/** The registry: every event as a row, with filters, sorting and CSV export.
 *  Rows are windowed so the table stays light at tens of thousands of events.
 *  Filters and sort mirror into `r_*` query params so a view can be shared. */

import { useEffect, useMemo, useState } from "react";
import { CONF_LABEL, EXPLORER, type Chain, type Ledger } from "../lib/data";
import { fmtCompactUsd, fmtDateTime, short } from "../lib/format";
import { downloadBlob } from "../lib/browser";
import { useStore } from "../lib/store";

const PAGE = 80;

type Sort = "newest" | "oldest" | "amount";

interface Filters {
  chain: string;
  token: string;
  action: string;
  record: string;
  q: string;
  entity: string;
  from: string; // YYYY-MM-DD, UTC
  to: string;
  sort: Sort;
}

const EMPTY: Filters = { chain: "", token: "", action: "", record: "", q: "", entity: "", from: "", to: "", sort: "newest" };
const KEYS = Object.keys(EMPTY) as (keyof Filters)[];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SORTS: Sort[] = ["newest", "oldest", "amount"];

function readUrl(allowed: { chains: string[]; tokens: string[] }): Filters {
  const f = { ...EMPTY };
  if (typeof window === "undefined") return f;
  const p = new URLSearchParams(window.location.search);
  const get = (k: keyof Filters) => p.get(`r_${k}`) ?? "";
  const chain = get("chain"), token = get("token"), action = get("action"), record = get("record");
  if (allowed.chains.includes(chain)) f.chain = chain;
  if (allowed.tokens.includes(token)) f.token = token;
  if (["freeze", "unfreeze", "destroy"].includes(action)) f.action = action;
  if (record === "yes" || record === "no") f.record = record;
  f.q = get("q");
  f.entity = get("entity");
  const from = get("from"), to = get("to");
  if (DATE_RE.test(from)) f.from = from;
  if (DATE_RE.test(to)) f.to = to;
  const sort = get("sort") as Sort;
  if (SORTS.includes(sort)) f.sort = sort;
  return f;
}

/** Day start (UTC) in unix seconds. */
const dayStart = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function Registry({ ledger }: { ledger: Ledger }) {
  const s = ledger.site;
  const [f, setF] = useState<Filters>(() => readUrl(s));
  const [shown, setShown] = useState(PAGE);
  const openDrawer = useStore((s) => s.openDrawer);

  const set = (patch: Partial<Filters>) => { setF((cur) => ({ ...cur, ...patch })); setShown(PAGE); };

  // Mirror filters into the URL, leaving every other param (a, hero, ...) alone.
  useEffect(() => {
    const url = new URL(window.location.href);
    for (const k of KEYS) {
      const v = f[k];
      if (v && v !== EMPTY[k]) url.searchParams.set(`r_${k}`, v);
      else url.searchParams.delete(`r_${k}`);
    }
    const next = url.pathname + url.search + url.hash;
    if (next !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(window.history.state, "", next);
  }, [f]);

  const entityNames = useMemo(() => s.entities.map((e) => e.name.toLowerCase()), [s]);

  const indices = useMemo(() => {
    const out: number[] = [];
    const ql = f.q.trim().toLowerCase();
    const el = f.entity.trim().toLowerCase();
    const lo = f.from ? dayStart(f.from) : -Infinity;
    const hi = f.to ? dayStart(f.to) + 86400 : Infinity; // inclusive of the whole "to" day
    for (let i = 0; i < s.n; i++) {
      if (s.internal[i]) continue;
      const t = s.t[i];
      if (t < lo || t >= hi) continue;
      if (f.chain && s.chains[s.c[i]] !== f.chain) continue;
      if (f.token && s.tokens[s.k[i]] !== f.token) continue;
      if (f.action && s.actions[s.a[i]] !== f.action) continue;
      if (f.record === "yes" && !s.conf[i]) continue;
      if (f.record === "no" && s.conf[i]) continue;
      if (ql && !s.addr[i].toLowerCase().includes(ql) && !s.tx[i].toLowerCase().includes(ql)) continue;
      if (el && !(s.conf[i] && s.ent[i] >= 0 && entityNames[s.ent[i]].includes(el))) continue;
      out.push(i);
    }
    // `out` is oldest first (t ascending). Newest = reverse; amount = largest first, rows without an amount last, newest first within ties.
    if (f.sort === "newest") out.reverse();
    else if (f.sort === "amount") {
      out.sort((x, y) => {
        const ax = s.amt[x], ay = s.amt[y];
        if (ax === null && ay === null) return y - x;
        if (ax === null) return 1;
        if (ay === null) return -1;
        return ay - ax || y - x;
      });
    }
    return out;
  }, [s, f, entityNames]);

  const filtered = KEYS.some((k) => k !== "sort" && f[k] !== EMPTY[k]) || f.sort !== EMPTY.sort;

  const download = () => {
    const lines = ["event_id,block_time,chain,token,action,address,amount,public_record,confidence"];
    for (const i of indices) {
      const rec = s.conf[i] > 0;
      lines.push([
        `${s.chains[s.c[i]]}:${s.tx[i]}:${s.li[i]}`,
        new Date(s.t[i] * 1000).toISOString(),
        s.chains[s.c[i]], s.tokens[s.k[i]], s.actions[s.a[i]], s.addr[i],
        s.amt[i] ?? "",
        rec ? (s.entities[s.ent[i]]?.name ?? "") : "",
        rec ? CONF_LABEL[s.conf[i]] : "",
      ].map(csvCell).join(","));
    }
    downloadBlob(`freeze-ledger-registry-${new Date().toISOString().slice(0, 10)}.csv`, new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  };

  const sel = "text-[13px]";
  const lbl = "flex items-center gap-2 text-[12.5px] text-paper-3";
  return (
    <section id="registry" className="px-5 py-16 md:px-8 md:py-20">
      <div className="mx-auto max-w-[72rem]">
        <h2 className="display text-[34px] md:text-[44px]">Registry</h2>
        <p className="mt-2 max-w-[48rem] text-paper-2">Every event, {f.sort === "oldest" ? "oldest first" : f.sort === "amount" ? "largest amount first" : "newest first"}. Click a row for its receipt.</p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <input className="mono min-w-[16rem] flex-1 text-[13px]" placeholder="address or transaction" value={f.q} onChange={(e) => set({ q: e.target.value })} spellCheck={false} aria-label="Filter by address or transaction" />
          <input className="min-w-[12rem] flex-1 text-[13px]" placeholder="public-record entity" value={f.entity} onChange={(e) => set({ entity: e.target.value })} spellCheck={false} aria-label="Filter by public-record entity" />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select className={sel} value={f.chain} onChange={(e) => set({ chain: e.target.value })} aria-label="Chain">
            <option value="">All chains</option>
            {s.chains.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className={sel} value={f.token} onChange={(e) => set({ token: e.target.value })} aria-label="Token">
            <option value="">USDT and USDC</option>
            {s.tokens.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className={sel} value={f.action} onChange={(e) => set({ action: e.target.value })} aria-label="Outcome">
            <option value="">Every outcome</option>
            <option value="freeze">Frozen</option>
            <option value="unfreeze">Released</option>
            <option value="destroy">Destroyed</option>
          </select>
          <select className={sel} value={f.record} onChange={(e) => set({ record: e.target.value })} aria-label="Public record">
            <option value="">With or without a record</option>
            <option value="yes">Has a public record</option>
            <option value="no">No record found</option>
          </select>
          <label className={lbl}>From
            <input type="date" className={sel} value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} aria-label="From date (UTC)" />
          </label>
          <label className={lbl}>To
            <input type="date" className={sel} value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} aria-label="To date (UTC)" />
          </label>
          <select className={sel} value={f.sort} onChange={(e) => set({ sort: e.target.value as Sort })} aria-label="Sort">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="amount">Largest amount first</option>
          </select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="mono text-[12px] text-paper-3">{indices.length.toLocaleString()} of {ledger.latest.events_public.toLocaleString()}</span>
          {filtered && <button onClick={() => set({ ...EMPTY })}>Clear filters</button>}
          <button className="ml-auto" onClick={download} disabled={indices.length === 0}>Download these rows (CSV)</button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[56rem] text-[13px]">
            <thead>
              <tr>
                <th>When (UTC)</th><th>Chain</th><th>Token</th><th>Outcome</th><th>Address</th><th className="text-right">Amount</th><th>Public record</th>
              </tr>
            </thead>
            <tbody>
              {indices.slice(0, shown).map((i) => {
                const action = s.actions[s.a[i]], chain = s.chains[s.c[i]] as Chain;
                return (
                  <tr key={i} className="cursor-pointer" onClick={() => openDrawer({ kind: "event", index: i })}>
                    <td className="mono whitespace-nowrap text-paper-2">{fmtDateTime(s.t[i]).slice(0, 16)}</td>
                    <td>{chain}</td>
                    <td className="mono">{s.tokens[s.k[i]]}</td>
                    <td className={`state-${action}`}>{action === "freeze" ? "Frozen" : action === "unfreeze" ? "Released" : "Destroyed"}</td>
                    <td className="mono">
                      <a href={EXPLORER[chain].address(s.addr[i])} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()} title={s.addr[i]}>{short(s.addr[i], 8, 6)}</a>
                    </td>
                    <td className="mono text-right text-ember">{s.amt[i] !== null ? fmtCompactUsd(s.amt[i]) : ""}</td>
                    <td className={s.conf[i] ? "record" : "text-paper-3"}>{s.conf[i] ? `${s.entities[s.ent[i]]?.name ?? "record"} · ${CONF_LABEL[s.conf[i]]}` : "none found"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {indices.length === 0 && <p className="mt-4 text-[13px] text-paper-3">No events match these filters.</p>}
        </div>
        {shown < indices.length && (
          <div className="mt-4 flex items-center gap-3">
            <button onClick={() => setShown((n) => n + PAGE * 3)}>Show more</button>
            <span className="text-[12.5px] text-paper-3">{Math.min(shown, indices.length).toLocaleString()} shown</span>
          </div>
        )}
      </div>
    </section>
  );
}
