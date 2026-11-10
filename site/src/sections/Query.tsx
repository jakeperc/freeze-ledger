/** Query: SQL over the whole ledger, in the browser. The engine and the CSVs
 *  load only when the visitor asks for them; until then this section is a
 *  few lines of text and a button. A query in the link (`?sql=`) fills the
 *  editor but never runs by itself: the visitor reads it and presses Run. */

import { useEffect, useRef, useState } from "react";
import type { Engine, Result } from "../lib/sql";
import { copyText, downloadBlob, useMedia } from "../lib/browser";
import { csvCell, fmtInt } from "../lib/format";

/** Shown on the page; the full result always goes into the download. */
const SHOW = 500;

const STARTERS: { label: string; sql: string }[] = [
  {
    label: "Freezes per month, by issuer",
    sql: `-- issuer-internal addresses (the issuers' own contracts) are left out, as in every headline count
SELECT date_trunc('month', block_time)::DATE AS month,
       count(*) FILTER (WHERE issuer = 'tether') AS tether,
       count(*) FILTER (WHERE issuer = 'circle') AS circle
FROM events
WHERE action = 'freeze' AND NOT issuer_internal
GROUP BY month
ORDER BY month DESC`,
  },
  {
    label: "Addresses frozen on more than one lane",
    sql: `-- a lane is one chain and one token; an EVM address is the same on Ethereum and Base
SELECT address,
       string_agg(DISTINCT token || ' on ' || chain, ', ') AS lanes,
       min(block_time) AS first_freeze,
       max(block_time) AS last_freeze
FROM events
WHERE action = 'freeze' AND NOT issuer_internal
GROUP BY address
HAVING count(DISTINCT chain || ':' || token) > 1
ORDER BY first_freeze`,
  },
  {
    label: "Destroyed balances over $1M",
    sql: `-- amount is in USDT; the public record columns are empty where none was found
SELECT e.block_time, e.chain, e.address, e.amount,
       string_agg(DISTINCT a.entity, '; ') AS entity,
       string_agg(DISTINCT a.confidence, '; ') AS confidence
FROM events e
LEFT JOIN attributions a ON a.address = e.address AND a.chain = e.chain
WHERE e.action = 'destroy' AND e.amount >= 1000000
GROUP BY ALL
ORDER BY e.amount DESC`,
  },
  {
    label: "Share of frozen addresses with no public record, by chain",
    sql: `-- counted over chain-address pairs ever frozen; a standing attribution of any confidence counts as a record
WITH frozen AS (
  SELECT DISTINCT chain, address FROM events WHERE action = 'freeze' AND NOT issuer_internal
), recorded AS (
  SELECT DISTINCT chain, address FROM attributions
)
SELECT f.chain,
       count(*) AS frozen_addresses,
       count(r.address) AS with_record,
       round(100.0 * (count(*) - count(r.address)) / count(*), 1) AS pct_no_record
FROM frozen f
LEFT JOIN recorded r USING (chain, address)
GROUP BY f.chain
ORDER BY frozen_addresses DESC`,
  },
  {
    label: "Sanctions programs behind attributed freezes",
    sql: `-- program holds one or more codes separated by ';', so each code is counted on its own
SELECT trim(p) AS program, count(DISTINCT address) AS addresses, min(record_date) AS earliest_record
FROM attributions, unnest(string_split(program, ';')) AS t(p)
WHERE source_class = 'ofac_sdn' AND program IS NOT NULL AND trim(p) <> ''
GROUP BY ALL
ORDER BY addresses DESC`,
  },
  {
    label: "Days from OFAC listing to first freeze",
    sql: `-- the rules of latest.json's sdn_listing_lag_days: a lane is one issuer on one chain;
-- only listings known to the day (not_before is set only for those) and made after the
-- lane's first event, so a chain that launched later does not read as a slow issuer;
-- a freeze or a destroy counts. Negative values are freezes made before OFAC named the
-- address. EVM addresses match on lowercase, Tron's case-sensitive base58 exactly;
-- Solana is left out (OFAC lists the wallet, the issuer freezes a token account)
WITH lane_start AS (
  SELECT issuer, chain, min(block_time)::DATE AS started
  FROM events WHERE NOT issuer_internal GROUP BY ALL
), first_freeze AS (
  SELECT issuer, chain, address, min(block_time)::DATE AS frozen
  FROM events
  WHERE action IN ('freeze', 'destroy') AND NOT issuer_internal AND chain <> 'solana'
  GROUP BY ALL
), lags AS (
  SELECT f.issuer, f.chain, f.address, h.first_seen AS listed, f.frozen,
         date_diff('day', h.first_seen, f.frozen) AS days_after_listing
  FROM sdn_history h
  JOIN first_freeze f
    ON (h.chain_hint = 'evm' AND f.chain IN ('ethereum', 'base') AND lower(f.address) = lower(h.address_norm))
    OR (h.chain_hint = 'tron' AND f.chain = 'tron' AND f.address = h.address_norm)
  JOIN lane_start l USING (issuer, chain)
  WHERE h.not_before IS NOT NULL AND h.first_seen > l.started
)
-- one row per lane; drop the GROUP BY to see every address
SELECT issuer, chain, count(*) AS addresses,
       -- the lower median, as latest.json computes it
       list_sort(list(days_after_listing))[1 + ((count(*) - 1) // 2)] AS median_days,
       count(*) FILTER (WHERE days_after_listing < -7) AS frozen_over_a_week_before_listing
FROM lags
GROUP BY ALL
ORDER BY issuer, chain`,
  },
];

const fromLink = () => {
  try {
    return new URLSearchParams(location.search).get("sql");
  } catch {
    return null;
  }
};

type Phase = { kind: "idle" } | { kind: "loading"; step: string } | { kind: "ready" } | { kind: "failed"; error: string };

export function Query() {
  const linked = useRef(fromLink());
  const [sql, setSql] = useState(linked.current ?? STARTERS[0].sql);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const engine = useRef<Engine | null>(null);
  const phone = useMedia("(max-width: 767px)");

  // one engine per page: every caller awaits the same start, so a second
  // Ctrl+Enter during the download cannot start a second worker
  const starting = useRef<Promise<Engine | null> | null>(null);
  // each run takes a ticket; only the newest run may write the result
  const ticket = useRef(0);

  useEffect(() => () => { engine.current?.close(); }, []);

  const load = (): Promise<Engine | null> => {
    if (engine.current) return Promise.resolve(engine.current);
    if (starting.current) return starting.current;
    setPhase({ kind: "loading", step: "Downloading the SQL engine" });
    starting.current = (async () => {
      try {
        const { start } = await import("../lib/sql");
        engine.current = await start((step) => setPhase({ kind: "loading", step }));
        setPhase({ kind: "ready" });
        return engine.current;
      } catch (e) {
        setPhase({ kind: "failed", error: e instanceof Error ? e.message : String(e) });
        starting.current = null; // a later press may retry; start() has closed its worker
        return null;
      }
    })();
    return starting.current;
  };

  const run = async (text = sql) => {
    const mine = ++ticket.current;
    const eng = await load();
    if (!eng || mine !== ticket.current) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const r = await eng.run(text);
      if (mine === ticket.current) setResult(r);
    } catch (e) {
      if (mine === ticket.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === ticket.current) setRunning(false);
    }
  };

  const pick = (s: string) => {
    setSql(s);
    if (engine.current) run(s);
    else setResult(null);
  };

  const download = () => {
    if (!result) return;
    const lines = [result.columns.map(csvCell).join(",")];
    for (const r of result.rows) lines.push(r.map((v) => (v === null ? "" : csvCell(v as string | number | boolean))).join(","));
    downloadBlob(`freeze-ledger-query-${new Date().toISOString().slice(0, 10)}.csv`, new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  };

  const share = async () => {
    const u = new URL(location.href);
    u.search = "";
    u.hash = "query";
    u.searchParams.set("sql", sql);
    setCopied(await copyText(u.toString()));
    setTimeout(() => setCopied(false), 2000);
  };

  const ready = phase.kind === "ready";
  return (
    <section id="query" className="px-5 py-16 md:px-8 md:py-20">
      <div className="mx-auto max-w-[72rem]">
        <h2 className="display text-[34px] md:text-[44px]">Query the ledger</h2>
        <p className="mt-2 max-w-[48rem] text-paper-2">
          Ask the whole dataset a question in SQL. The engine (<a href="https://duckdb.org/docs/api/wasm/overview" target="_blank" rel="noopener">DuckDB</a>, compiled to WebAssembly) and the CSVs load into this tab when you ask for them, and every query runs on your device. Nothing you type is sent anywhere.
        </p>

        {phase.kind === "idle" && (
          <p className="mt-3 text-[13px] text-paper-3">
            Loading it downloads the engine (34 MB, about 8 MB where the connection compresses it) and about 6.5 MB of data. On a phone on mobile data, the downloads under Method may be the better route.
          </p>
        )}
        {phase.kind === "loading" && <p className="mt-3 text-[13px] text-paper-3" aria-live="polite">{phase.step}…</p>}
        {phase.kind === "failed" && (
          <p className="mt-3 text-[13px] text-amber" role="alert">
            The SQL engine did not start ({phase.error}). It needs WebAssembly and Web Workers; the same data is in the downloads under Method.
          </p>
        )}
        {ready && engine.current && (
          <details className="mt-3 text-[13px] text-paper-2">
            <summary className="cursor-pointer text-paper-3">Tables ({engine.current.version})</summary>
            <ul className="mt-2 space-y-1">
              <li><span className="mono">events</span> · {fmtInt(engine.current.rows.events)} rows · one row per freeze, unfreeze or destroy; <span className="mono">amount</span> is set on destroys only</li>
              <li><span className="mono">attributions</span> · {fmtInt(engine.current.rows.attributions)} rows · the judgments that stand (<span className="mono">attributions_all</span> keeps superseded ones too)</li>
              <li><span className="mono">evidence</span> · {fmtInt(engine.current.rows.evidence)} rows · the receipt behind each row</li>
              <li><span className="mono">sdn_addresses</span> · {fmtInt(engine.current.rows.sdn_addresses)} rows · OFAC SDN digital-currency addresses</li>
              <li><span className="mono">sdn_history</span> · {fmtInt(engine.current.rows.sdn_history)} rows · when each was listed and removed</li>
            </ul>
            <p className="mt-2 text-paper-3">Columns are described in <a href="https://github.com/jakeperc/freeze-ledger/blob/main/METHODOLOGY.md#schema" target="_blank" rel="noopener">METHODOLOGY.md</a>.</p>
          </details>
        )}

        <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Starter queries">
          {STARTERS.map((s) => (
            <button key={s.label} aria-pressed={sql === s.sql} onClick={() => pick(s.sql)} className="text-[12.5px]">{s.label}</button>
          ))}
        </div>

        <textarea
          className="mono mt-4 min-h-48 w-full resize-y text-[13px]"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              run();
            }
          }}
          spellCheck={false}
          aria-label="SQL query"
        />
        {linked.current && sql === linked.current && !result && (
          <p className="mt-1 text-[12.5px] text-paper-3">This query came with the link. Read it, then run it.</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className="primary" onClick={() => run()} disabled={running || phase.kind === "loading"}>
            {ready ? (running ? "Running…" : "Run") : phase.kind === "loading" ? "Loading…" : "Load the engine and run"}
          </button>
          {!phone && <span className="text-[12px] text-paper-3">Ctrl+Enter runs</span>}
          <button onClick={share}>{copied ? "Link copied" : "Copy a link to this query"}</button>
          {result && result.rows.length > 0 && <button onClick={download}>Download the result as CSV</button>}
        </div>

        <div aria-live="polite">
          {error && <pre className="mono mt-4 whitespace-pre-wrap text-[12.5px] text-amber" role="alert">{error}</pre>}
          {result && (
            <p className="mt-4 text-[12.5px] text-paper-3">
              {fmtInt(result.rows.length)} {result.rows.length === 1 ? "row" : "rows"} in {result.ms < 1000 ? `${Math.round(result.ms)} ms` : `${(result.ms / 1000).toFixed(1)} s`}
              {result.rows.length > SHOW && <> · showing the first {fmtInt(SHOW)}; the download has all of them</>}
            </p>
          )}
        </div>
        {result && result.rows.length > 0 && (
          <div className="panel mt-2 max-h-[32rem] overflow-auto">
            <table className="text-[12.5px]">
              <thead>
                <tr>{result.columns.map((c) => <th key={c} className="whitespace-nowrap">{c}</th>)}</tr>
              </thead>
              <tbody>
                {result.rows.slice(0, SHOW).map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} className={`whitespace-nowrap ${typeof v === "number" ? "text-right" : ""} ${v === null ? "text-paper-3" : "mono"}`}>
                        {v === null ? "—" : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
