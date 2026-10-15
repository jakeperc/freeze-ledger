/** What the data shows. Small multiples per lane for freezes per month with
 *  the un-indexed stretch marked, the two issuers side by side, and the time
 *  from a freeze to what happens next. Every number is from latest.json or
 *  counted from site.json in the browser. */

import { max } from "d3-array";
import { scaleBand, scaleLinear } from "d3-scale";
import { useMemo } from "react";
import { ACTION_COLOR, CHAIN_COLOR, type Chain, type Ledger } from "../lib/data";
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
  const detail = ledger.latest.coverage_span[laneDef.chain]?.detail?.[`${laneDef.token}:freeze`];
  const total = axis.reduce((a, m) => a + (counts.get(m) ?? 0), 0);
  // a gap is a stretch where this lane has other events (destroys, releases)
  // but no freezes: the freezes there are not indexed yet
  const laneDetail = ledger.latest.coverage_span[laneDef.chain]?.detail ?? {};
  const earliestAny = Object.entries(laneDetail).filter(([k]) => k.startsWith(laneDef.token + ":")).map(([, v]) => v.first).sort()[0];
  const firstIndexed = detail ? detail.first.slice(0, 7) : null;
  const gapStart = earliestAny ? Math.max(0, axis.indexOf(earliestAny.slice(0, 7))) : 0;
  const gapEnd = firstIndexed && earliestAny && earliestAny.slice(0, 7) < firstIndexed ? axis.indexOf(firstIndexed) : -1;
  const peak = axis.reduce((best, m) => ((counts.get(m) ?? 0) > (counts.get(best) ?? 0) ? m : best), axis[0]);
  const color = CHAIN_COLOR[laneDef.chain as Chain];
  const yearTicks = axis.filter((m) => m.endsWith("-01"));
  return (
    <div className="grid grid-cols-[9rem_1fr] items-center gap-4">
      <div>
        <div className="text-[13px]">{laneDef.label}</div>
        <div className="mono text-[11.5px] text-paper-3">{total ? `${fmtInt(total)} freezes` : "not yet indexed"}</div>
        {detail && <div className="mono text-[11px] text-paper-3">from {fmtDate(detail.first)}</div>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${laneDef.label}: freezes per month`}>
        {gapEnd > 0 && (
          <g>
            <rect x={x(axis[gapStart])} y={T} width={(x(axis[gapEnd]) ?? 0) - (x(axis[gapStart]) ?? 0)} height={H - B - T} fill="url(#hatch)" opacity={0.5} />
            <text x={(x(axis[gapStart]) ?? 0) + 4} y={T + 12} fontSize={10} fill="var(--color-paper-3)">freezes not indexed before {firstIndexed}; releases and destroys here are</text>
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

function Quantiles({ label, q, color }: { label: string; q: { n: number; p25: number; median: number; p75: number; max: number } | null; color: string }) {
  if (!q) return null;
  const W = 520, H = 34;
  const x = scaleLinear().domain([0, Math.max(30, q.max)]).range([0, W - 60]);
  return (
    <div className="grid grid-cols-[12rem_1fr] items-center gap-4">
      <div>
        <div className="text-[13px]">{label}</div>
        <div className="mono text-[11.5px] text-paper-3">{fmtInt(q.n)} cases</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${label}: quartiles in days`}>
        <line x1={0} x2={x(q.max)} y1={H / 2} y2={H / 2} stroke="var(--color-rule-2)" />
        <rect x={x(q.p25)} y={H / 2 - 7} width={Math.max(2, x(q.p75) - x(q.p25))} height={14} fill={color} opacity={0.35} />
        <line x1={x(q.median)} x2={x(q.median)} y1={H / 2 - 11} y2={H / 2 + 11} stroke={color} strokeWidth={2} />
        <text x={x(q.median)} y={H / 2 - 14} fontSize={10.5} textAnchor="middle" fill="var(--color-paper)" className="mono">median {fmtInt(q.median)} d</text>
        <text x={x(q.p25)} y={H - 2} fontSize={9.5} textAnchor="middle" fill="var(--color-paper-3)" className="mono">{fmtInt(q.p25)}</text>
        <text x={x(q.p75)} y={H - 2} fontSize={9.5} textAnchor="middle" fill="var(--color-paper-3)" className="mono">{fmtInt(q.p75)}</text>
        <text x={x(q.max) + 4} y={H / 2 + 4} fontSize={9.5} fill="var(--color-paper-3)" className="mono">max {fmtInt(q.max)} d</text>
      </svg>
    </div>
  );
}

export function Patterns({ ledger }: { ledger: Ledger }) {
  const { axis, perLane } = useMonthly(ledger);
  const l = ledger.latest;
  const t = l.by_issuer.tether, c = l.by_issuer.circle;
  const scr = l.sdn_screening;
  const sdnEvm = Math.max(scr["circle:ethereum"] ?? 0, scr["tether:ethereum"] ?? 0, scr["circle:base"] ?? 0);
  const rows: [string, string | number, string | number][] = [
    ["Addresses frozen", fmtInt(t?.frozen_addresses), fmtInt(c?.frozen_addresses)],
    ["Frozen right now", fmtInt(t?.currently_frozen), fmtInt(c?.currently_frozen)],
    ["Released", fmtInt(t?.released_addresses), fmtInt(c?.released_addresses)],
    ["Balances destroyed", fmtInt(t?.destroys), "cannot"],
    ["Destroyed, total", t ? fmtCompactUsd(t.destroyed_total) : "—", "—"],
    ["OFAC-listed addresses frozen on Ethereum", fmtInt(scr["tether:ethereum"] ?? 0), fmtInt(scr["circle:ethereum"] ?? 0)],
    ["OFAC-listed addresses frozen on Base", "no contract in scope", fmtInt(scr["circle:base"] ?? 0)],
  ];
  return (
    <section id="patterns" className="px-5 py-16 md:px-8 md:py-20">
      <div className="max-w-[72rem]">
        <h2 className="display text-[34px] md:text-[44px]">Patterns</h2>
        <p className="mt-2 max-w-[48rem] text-paper-2">Counted from the rows below the field. Hatched stretches are months the ledger does not cover yet for that lane.</p>

        <div className="rule mt-8 pt-5">
          <div className="mb-4 text-[15px]">Freezes per month</div>
          <svg width="0" height="0" aria-hidden="true"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-rule-2)" strokeWidth="1.5" /></pattern></defs></svg>
          <div className="space-y-3">
            {LANES.map((_, i) => <LaneChart key={i} ledger={ledger} lane={i} axis={axis} counts={perLane.get(i) ?? new Map()} />)}
          </div>
        </div>

        <div className="mt-12 grid gap-10 md:grid-cols-2">
          <div className="rule pt-5">
            <div className="text-[15px]">Two issuers</div>
            <p className="mt-1 text-[12.5px] text-paper-3">Tether can zero a frozen balance; Circle's contract cannot. One screens the sanctions list on every chain; the other freezes {scr["tether:ethereum"] !== undefined && sdnEvm ? `${fmtInt(scr["tether:ethereum"])} of the ${fmtInt(sdnEvm)}` : "a subset"} listed EVM addresses.</p>
            <table className="mt-4 text-[13px]">
              <thead><tr><th></th><th className="text-right">Tether</th><th className="text-right">Circle</th></tr></thead>
              <tbody>
                {rows.map(([k, a, b]) => (
                  <tr key={k}><td className="text-paper-2">{k}</td><td className="mono text-right">{a}</td><td className="mono text-right">{b}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[12px] text-paper-3">Tether's Ethereum freezes are indexed from {l.coverage_span.ethereum?.detail?.["USDT:freeze"] ? fmtDate(l.coverage_span.ethereum.detail["USDT:freeze"].first) : "—"}; its destroys and releases are complete, so "frozen right now" for USDT includes addresses whose freeze predates coverage.</p>
          </div>

          <div className="rule pt-5">
            <div className="text-[15px]">After a freeze</div>
            <p className="mt-1 text-[12.5px] text-paper-3">Days from the first freeze of an address to the next thing that happened to it. The box spans the middle half of cases.</p>
            <div className="mt-5 space-y-5">
              <Quantiles label="Freeze → balance destroyed (Tether)" q={l.freeze_to_destroy_days} color={ACTION_COLOR.destroy} />
              <Quantiles label="Freeze → released" q={l.freeze_to_release_days} color={ACTION_COLOR.unfreeze} />
            </div>
            <div className="mt-8 text-[15px]">Across chains</div>
            <p className="mt-1 text-[13.5px] text-paper-2">
              {fmtInt(l.multi_chain_addresses)} addresses are frozen on more than one chain{Object.keys(l.multi_chain_pairs).length ? ` (${Object.entries(l.multi_chain_pairs).map(([k, v]) => `${k.replace("+", " and ")}: ${fmtInt(v)}`).join("; ")})` : ""}.
              {l.attribution_coverage_by_chain.base && l.multi_chain_pairs["base+ethereum"] ? ` ${fmtInt(l.multi_chain_pairs["base+ethereum"])} of the ${fmtInt(l.attribution_coverage_by_chain.base.frozen_addresses)} addresses frozen on Base are also frozen on Ethereum: Circle carries its list across its deployments.` : ""}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
