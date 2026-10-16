/** What the data shows. Small multiples per lane for freezes per month, the
 *  two issuers side by side (how fast each acts on an OFAC listing, and on a
 *  delisting), the sanctions programs behind the matches, destroyed USDT over
 *  time, and the time from a freeze to what happens next. Every number is
 *  from latest.json or counted from site.json in the browser. */

import { max } from "d3-array";
import { scaleBand, scaleLinear } from "d3-scale";
import { useMemo } from "react";
import { coverageSentence, mainDelisting } from "../lib/copy";
import { ACTION_COLOR, CHAIN_COLOR, type Chain, type Ledger, type Quantiles as Q } from "../lib/data";
import { fmtCompactUsd, fmtDate, fmtInt, monthLabel } from "../lib/format";
import { LANES } from "../lib/layouts";

function useMonthly(ledger: Ledger) {
  return useMemo(() => {
    const s = ledger.site;
    const months = new Set<string>();
    const perLane: Map<number, Map<string, number>> = new Map();
    for (let i = 0; i < s.n; i++) {
      if (s.internal[i] || s.actions[s.a[i]] !== "freeze") continue;
      const m = new Date(s.t[i] * 1000).toISOString().slice(0, 7);
      months.add(m);
      const lane = LANES.findIndex((l) => l.chain === s.chains[s.c[i]] && l.token === s.tokens[s.k[i]]);
      const mm = perLane.get(lane) ?? new Map();
      mm.set(m, (mm.get(m) ?? 0) + 1);
      perLane.set(lane, mm);
    }
    // continuous month axis from the first to the last month
    const sorted = [...months].sort();
    const axis: string[] = [];
    if (sorted.length) {
      let [y, m] = sorted[0].split("-").map(Number);
      const last = sorted[sorted.length - 1];
      while (true) {
        const key = `${y}-${String(m).padStart(2, "0")}`;
        axis.push(key);
        if (key === last) break;
        m++; if (m > 12) { m = 1; y++; }
      }
    }
    return { axis, perLane };
  }, [ledger]);
}

function LaneChart({ ledger, lane, axis, counts }: { ledger: Ledger; lane: number; axis: string[]; counts: Map<string, number> }) {
  const W = 720, H = 80, L = 0, R = 0, T = 18, B = 16;
  const x = scaleBand<string>().domain(axis).range([L, W - R]).paddingInner(0.25);
  const top = max(axis, (m) => counts.get(m) ?? 0) ?? 1;
  const y = scaleLinear().domain([0, Math.max(1, top)]).range([H - B, T]);
  const laneDef = LANES[lane];
  const cov = ledger.latest.coverage?.[`${laneDef.chain}:${laneDef.token}`];
  const total = axis.reduce((a, m) => a + (counts.get(m) ?? 0), 0);
  const peak = axis.reduce((best, m) => ((counts.get(m) ?? 0) > (counts.get(best) ?? 0) ? m : best), axis[0]);
  const color = CHAIN_COLOR[laneDef.chain as Chain];
  const yearTicks = axis.filter((m) => m.endsWith("-01"));
  // an incomplete lane is hatched across the whole axis, with what is missing written on it
  const open = cov && !cov.complete;
  return (
    <div className="grid grid-cols-[9rem_1fr] items-center gap-4">
      <div>
        <div className="text-[13px]">{laneDef.label}</div>
        <div className="mono text-[11.5px] text-paper-3">{total ? `${fmtInt(total)} freezes` : cov?.note || "no freezes"}</div>
        {cov?.first && <div className="mono text-[11px] text-paper-3">from {fmtDate(cov.first)}</div>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${laneDef.label}: freezes per month`}>
        {open && (
          <g>
            <rect x={L} y={T} width={W - L - R} height={H - B - T} fill="url(#hatch)" opacity={0.5} />
            <text x={L + 4} y={T + 12} fontSize={10} fill="var(--color-paper-3)">{cov.note}</text>
          </g>
        )}
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="var(--color-rule-2)" />
        {axis.map((m) => {
          const v = counts.get(m) ?? 0;
          if (!v) return null;
          return <rect key={m} x={x(m)} y={y(v)} width={x.bandwidth()} height={H - B - y(v)} fill={color} opacity={0.9}><title>{`${monthLabel(m)}: ${v}`}</title></rect>;
        })}
        {total > 0 && <text x={Math.min(W - 70, Math.max(40, (x(peak) ?? 0) + x.bandwidth() / 2))} y={y(counts.get(peak) ?? 0) - 4} fontSize={10} textAnchor="middle" fill="var(--color-paper-2)" className="mono">{counts.get(peak)} · {monthLabel(peak)}</text>}
        {yearTicks.map((m) => <text key={m} x={x(m)} y={H - 3} fontSize={10} fill="var(--color-paper-3)" className="mono">{m.slice(0, 4)}</text>)}
      </svg>
    </div>
  );
}

function Quantiles({ label, q, color }: { label: string; q: Q | null; color: string }) {
  if (!q || q.median === undefined) return null;
  const { p25 = 0, median, p75 = 0, max: top = 0 } = q;
  const W = 420, H = 40;
  const x = scaleLinear().domain([0, Math.max(30, top)]).range([10, W - 70]);
  return (
    <div className="grid gap-1">
      <div>
        <div className="text-[13px]">{label}</div>
        <div className="mono text-[11.5px] text-paper-3">{fmtInt(q.n)} cases</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="max-w-[34rem]" role="img" aria-label={`${label}: median ${fmtInt(median)} days, middle half ${fmtInt(p25)} to ${fmtInt(p75)} days`}>
        <line x1={x(0)} x2={x(top)} y1={H / 2} y2={H / 2} stroke="var(--color-rule-2)" />
        <rect x={x(p25)} y={H / 2 - 7} width={Math.max(2, x(p75) - x(p25))} height={14} fill={color} opacity={0.35} />
        <line x1={x(median)} x2={x(median)} y1={H / 2 - 11} y2={H / 2 + 11} stroke={color} strokeWidth={2} />
        <text x={Math.max(42, x(median))} y={H / 2 - 13} fontSize={10.5} textAnchor="middle" fill="var(--color-paper)" className="mono">median {fmtInt(median)} d</text>
        <text x={x(p25)} y={H - 2} fontSize={9.5} textAnchor="middle" fill="var(--color-paper-3)" className="mono">{fmtInt(p25)}</text>
        <text x={x(p75)} y={H - 2} fontSize={9.5} textAnchor="middle" fill="var(--color-paper-3)" className="mono">{fmtInt(p75)}</text>
        <text x={x(top) + 4} y={H / 2 + 4} fontSize={9.5} fill="var(--color-paper-3)" className="mono">max {fmtInt(top)} d</text>
      </svg>
    </div>
  );
}

const ISSUER: Record<string, string> = { tether: "Tether", circle: "Circle" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const of = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? "—" : `${fmtInt(a)} of ${fmtInt(b)}`);

/** Ranked bars: frozen addresses on the OFAC list per sanctions program. */
function Programs({ ledger }: { ledger: Ledger }) {
  const rows = ledger.latest.top_programs.slice(0, 10);
  const top = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <div className="rule pt-5">
      <div className="text-[15px]">Sanctions programs behind the matches</div>
      <p className="mt-1 text-[12.5px] text-paper-3">Frozen addresses on the OFAC list, by the program their listing cites. An address under several programs counts once in each.</p>
      <ul className="mt-4 space-y-1.5">
        {rows.map(([p, n]) => (
          <li key={p} className="grid grid-cols-[11rem_1fr_3rem] items-center gap-3 text-[12.5px]">
            <span className="mono truncate text-paper-2" title={p}>{p}</span>
            <span className="h-2.5 bg-amber/70" style={{ width: `${(100 * n) / top}%` }} />
            <span className="mono text-right text-paper-2">{fmtInt(n)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Cumulative USDT destroyed, one line per chain, counted from the rows. */
function Destroyed({ ledger }: { ledger: Ledger }) {
  const s = ledger.site;
  const series = useMemo(() => {
    const out: Record<string, { t: number; v: number }[]> = {};
    for (let i = 0; i < s.n; i++) {
      if (s.internal[i] || s.actions[s.a[i]] !== "destroy" || s.amt[i] === null) continue;
      const c = s.chains[s.c[i]];
      const line = (out[c] ??= [{ t: s.t[i], v: 0 }]);
      line.push({ t: s.t[i], v: line[line.length - 1].v + (s.amt[i] as number) });
    }
    return out;
  }, [s]);
  const W = 520, H = 170, L = 4, R = 128, T = 10, B = 18;
  const t0 = s.t[0], t1 = s.t[s.n - 1];
  const top = Math.max(1, ...Object.values(series).map((l) => l[l.length - 1].v));
  const x = scaleLinear().domain([t0, t1]).range([L, W - R]);
  const y = scaleLinear().domain([0, top]).range([H - B, T]);
  const years: number[] = [];
  for (let yr = new Date(t0 * 1000).getUTCFullYear() + 1; yr <= new Date(t1 * 1000).getUTCFullYear(); yr++) years.push(yr);
  const ends = Object.entries(series).map(([c, line]) => ({ c, v: line[line.length - 1].v })).sort((a, b) => b.v - a.v);
  return (
    <div className="rule pt-5">
      <div className="text-[15px]">USDT destroyed after a freeze, running total</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="mt-3" role="img" aria-label={`Cumulative USDT destroyed: ${ends.map((e) => `${cap(e.c)} ${fmtCompactUsd(e.v)}`).join(", ")}`}>
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="var(--color-rule-2)" />
        {years.map((yr) => (
          <text key={yr} x={x(Date.UTC(yr, 0, 1) / 1000)} y={H - 4} fontSize={10} textAnchor="middle" fill="var(--color-paper-3)" className="mono">{yr}</text>
        ))}
        {Object.entries(series).map(([c, line]) => {
          const d = line.map((p, j) => `${j ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("") + `L${x(t1).toFixed(1)},${y(line[line.length - 1].v).toFixed(1)}`;
          return <path key={c} d={d} fill="none" stroke={CHAIN_COLOR[c as Chain]} strokeWidth={1.6} />;
        })}
        {/* end labels, nudged apart when the lines finish close together */}
        {ends.map((e, j) => {
          const yy = Math.min(H - B, Math.max(T + 8, y(e.v) + 4 + (j > 0 && Math.abs(y(e.v) - y(ends[j - 1].v)) < 14 ? 14 : 0)));
          return <text key={e.c} x={W - R + 6} y={yy} fontSize={10.5} fill={CHAIN_COLOR[e.c as Chain]} className="mono">{cap(e.c)} {fmtCompactUsd(e.v)}</text>;
        })}
      </svg>
    </div>
  );
}

/** Freezes per year, stacked by chain, with Tron's share written on each row. */
function Yearly({ ledger }: { ledger: Ledger }) {
  const s = ledger.site;
  const rows = useMemo(() => {
    const m = new Map<number, Record<string, number>>();
    for (let i = 0; i < s.n; i++) {
      if (s.internal[i] || s.actions[s.a[i]] !== "freeze") continue;
      const yr = new Date(s.t[i] * 1000).getUTCFullYear();
      const r = m.get(yr) ?? {};
      const c = s.chains[s.c[i]];
      r[c] = (r[c] ?? 0) + 1;
      m.set(yr, r);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [s]);
  const top = Math.max(1, ...rows.map(([, r]) => Object.values(r).reduce((a, b) => a + b, 0)));
  const last = new Date(s.t[s.n - 1] * 1000).toISOString().slice(0, 10);
  return (
    <div className="rule pt-5">
      <div className="text-[15px]">Freezes per year</div>
      <p className="mt-1 text-[12.5px] text-paper-3">Stacked by chain. The percentage is Tron's share. {last.slice(0, 4)} runs to {last}.</p>
      <ul className="mt-4 space-y-1.5">
        {rows.map(([yr, r]) => {
          const total = Object.values(r).reduce((a, b) => a + b, 0);
          return (
            <li key={yr} className="grid grid-cols-[3rem_1fr_7rem] items-center gap-3 text-[12.5px]">
              <span className="mono text-paper-2">{yr}</span>
              <span className="flex h-2.5" style={{ width: `${Math.max(0.5, (100 * total) / top)}%` }} title={`${fmtInt(total)} freezes`}>
                {s.chains.map((c) => (r[c] ? <span key={c} style={{ width: `${(100 * r[c]) / total}%`, background: CHAIN_COLOR[c] }} /> : null))}
              </span>
              <span className="mono text-right text-paper-3">{fmtInt(total)} · {Math.round((100 * (r.tron ?? 0)) / total)}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Patterns({ ledger }: { ledger: Ledger }) {
  const { axis, perLane } = useMonthly(ledger);
  const l = ledger.latest;
  const t = l.by_issuer.tether, c = l.by_issuer.circle;
  const lag = l.sdn_listing_lag_days ?? {};
  const del = l.sdn_delisted?.lanes ?? {};
  const delist = mainDelisting(l);
  type LagRow = (typeof lag)[string];
  type DelRow = (typeof del)[string];
  const sum = (issuer: string, f: (v: LagRow) => number) =>
    Object.entries(lag).filter(([k]) => k.startsWith(issuer + ":")).reduce((a, [, v]) => a + f(v), 0);
  const delSum = (issuer: string, f: (v: DelRow) => number) =>
    Object.entries(del).filter(([k]) => k.startsWith(issuer + ":")).reduce((a, [, v]) => a + f(v), 0);
  const rows: [string, string, string][] = [
    ["Addresses frozen", fmtInt(t?.frozen_addresses), fmtInt(c?.frozen_addresses)],
    ["Frozen right now", fmtInt(t?.currently_frozen), fmtInt(c?.currently_frozen)],
    ["Released", fmtInt(t?.released_addresses), fmtInt(c?.released_addresses)],
    ["Balances destroyed", fmtInt(t?.destroys), "cannot"],
    ["Destroyed, total", t ? fmtCompactUsd(t.destroyed_total) : "—", "—"],
    ["OFAC listing to freeze on Ethereum, median days", fmtInt(lag["tether:ethereum"]?.median), fmtInt(Math.max(0, lag["circle:ethereum"]?.median ?? 0))],
    ["Frozen within two days of the listing, all chains", of(sum("tether", (v) => v.within_2_days), sum("tether", (v) => v.n)), of(sum("circle", (v) => v.within_2_days), sum("circle", (v) => v.n))],
    ["Frozen a week or more before OFAC listed them", fmtInt(sum("tether", (v) => v.before_listing)), fmtInt(sum("circle", (v) => v.before_listing))],
  ];
  if (delist)
    rows.push([
      `Released after OFAC delisted them (${delist.date.slice(0, 7)})`,
      of(delSum("tether", (v) => v.released_after_removal), delSum("tether", (v) => v.frozen_when_removed)),
      of(delSum("circle", (v) => v.released_after_removal), delSum("circle", (v) => v.frozen_when_removed)),
    ]);
  return (
    <section id="patterns" className="px-5 py-16 md:px-8 md:py-20">
      <div className="max-w-[72rem]">
        <h2 className="display text-[34px] md:text-[44px]">Patterns</h2>
        <p className="mt-2 max-w-[48rem] text-paper-2">Counted from the rows below the field. {coverageSentence(l)}</p>

        <div className="rule mt-8 pt-5">
          <div className="mb-4 text-[15px]">Freezes per month</div>
          <svg width="0" height="0" aria-hidden="true"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-rule-2)" strokeWidth="1.5" /></pattern></defs></svg>
          <div className="space-y-3">
            {LANES.map((_, i) => <LaneChart key={i} ledger={ledger} lane={i} axis={axis} counts={perLane.get(i) ?? new Map()} />)}
          </div>
        </div>

        <div className="mt-12 grid gap-10 md:grid-cols-2">
          <div className="rule min-w-0 pt-5">
            <div className="text-[15px]">Two issuers</div>
            <p className="mt-1 text-[12.5px] text-paper-3">
              Both freeze the addresses OFAC lists. They differ in how fast, and Tether can also zero a frozen balance, which Circle's contract cannot.
            </p>
            <div className="overflow-x-auto">
              <table className="mt-4 text-[13px]">
                <thead><tr><th></th><th className="text-right">Tether</th><th className="text-right">Circle</th></tr></thead>
                <tbody>
                  {rows.map(([k, a, b]) => (
                    <tr key={k}><td className="text-paper-2">{k}</td><td className="mono whitespace-nowrap text-right">{a}</td><td className="mono whitespace-nowrap text-right">{b}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[12px] text-paper-3">Listing dates come from the history of the nightly SDN extract, so they are known to the day only for addresses added after September 2022, and only chains live at the listing count. The extract can trail OFAC by a day or two, and "within two days" allows for it.</p>
          </div>

          <div className="rule min-w-0 pt-5">
            <div className="text-[15px]">OFAC listing to freeze, by chain</div>
            <div className="overflow-x-auto">
              <table className="mt-4 text-[13px]">
                <thead><tr><th>Issuer, chain</th><th className="text-right">Listed</th><th className="text-right">Median days</th><th className="text-right">Within 2 days</th><th className="text-right">Before listing</th></tr></thead>
                <tbody>
                  {Object.entries(lag).filter(([, v]) => v.n > 0).map(([k, v]) => {
                    const [iss, ch] = k.split(":");
                    return (
                      <tr key={k}>
                        <td className="whitespace-nowrap text-paper-2">{ISSUER[iss] ?? iss}, {cap(ch)}</td>
                        <td className="mono text-right">{fmtInt(v.n)}</td>
                        <td className="mono text-right">{fmtInt(Math.max(0, v.median ?? 0))}</td>
                        <td className="mono text-right">{fmtInt(v.within_2_days)}</td>
                        <td className="mono text-right">{fmtInt(v.before_listing)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[12px] text-paper-3">"Before listing" means a week or more early: the issuer froze the address before it was on the list, which screening against the list cannot explain.</p>

            <div className="mt-8 text-[15px]">After a freeze</div>
            <p className="mt-1 text-[12.5px] text-paper-3">Days from the first freeze of an address to the next thing that happened to it. The box spans the middle half of cases.</p>
            <div className="mt-5 space-y-5">
              <Quantiles label="Freeze → balance destroyed (Tether)" q={l.freeze_to_destroy_days} color={ACTION_COLOR.destroy} />
              <Quantiles label="Freeze → released" q={l.freeze_to_release_days} color={ACTION_COLOR.unfreeze} />
            </div>
          </div>
        </div>

        <div className="mt-12 grid gap-10 md:grid-cols-2">
          <Destroyed ledger={ledger} />
          <Programs ledger={ledger} />
        </div>

        <div className="mt-12 grid gap-10 md:grid-cols-2">
          <Yearly ledger={ledger} />
          <div className="rule pt-5">
            <div className="text-[15px]">Across chains</div>
            <p className="mt-2 text-[13.5px] text-paper-2">
              {fmtInt(l.multi_chain_addresses)} addresses are frozen on more than one chain{Object.keys(l.multi_chain_pairs).length ? ` (${Object.entries(l.multi_chain_pairs).map(([k, v]) => `${k.replace("+", " and ")}: ${fmtInt(v)}`).join("; ")})` : ""}.
              {l.attribution_coverage_by_chain.base && l.multi_chain_pairs["base+ethereum"] ? ` ${fmtInt(l.multi_chain_pairs["base+ethereum"])} of the ${fmtInt(l.attribution_coverage_by_chain.base.frozen_addresses)} addresses frozen on Base are also frozen on Ethereum: Circle carries its list across its deployments.` : ""}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
