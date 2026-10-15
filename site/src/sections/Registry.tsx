/** The registry: every event as a row, newest first, with filters. Rows are
 *  windowed so the table stays light at tens of thousands of events. */

import { useMemo, useState } from "react";
import { CONF_LABEL, EXPLORER, type Chain, type Ledger } from "../lib/data";
import { fmtCompactUsd, fmtDateTime, short } from "../lib/format";
import { useStore } from "../lib/store";

const PAGE = 80;

export function Registry({ ledger }: { ledger: Ledger }) {
  const s = ledger.site;
  const [chain, setChain] = useState("");
  const [token, setToken] = useState("");
  const [action, setAction] = useState("");
  const [record, setRecord] = useState("");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const openDrawer = useStore((s) => s.openDrawer);

  const indices = useMemo(() => {
    const out: number[] = [];
    const ql = q.trim().toLowerCase();
    for (let i = s.n - 1; i >= 0; i--) {
      if (s.internal[i]) continue;
      if (chain && s.chains[s.c[i]] !== chain) continue;
      if (token && s.tokens[s.k[i]] !== token) continue;
      if (action && s.actions[s.a[i]] !== action) continue;
      if (record === "yes" && !s.conf[i]) continue;
      if (record === "no" && s.conf[i]) continue;
      if (ql && !s.addr[i].toLowerCase().includes(ql) && !s.tx[i].toLowerCase().includes(ql)) continue;
      out.push(i);
    }
    return out;
  }, [s, chain, token, action, record, q]);

  const sel = "text-[13px]";
  return (
    <section id="registry" className="px-5 py-16 md:px-8 md:py-20">
      <div className="max-w-[72rem]">
        <h2 className="display text-[34px] md:text-[44px]">Registry</h2>
        <p className="mt-2 max-w-[48rem] text-paper-2">Every event, newest first. Click a row for its receipt.</p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <input className="mono min-w-[16rem] flex-1 text-[13px]" placeholder="address or transaction" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} spellCheck={false} aria-label="Filter by address or transaction" />
          <select className={sel} value={chain} onChange={(e) => { setChain(e.target.value); setShown(PAGE); }} aria-label="Chain">
            <option value="">All chains</option>
            {s.chains.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className={sel} value={token} onChange={(e) => { setToken(e.target.value); setShown(PAGE); }} aria-label="Token">
            <option value="">USDT and USDC</option>
            {s.tokens.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className={sel} value={action} onChange={(e) => { setAction(e.target.value); setShown(PAGE); }} aria-label="Outcome">
            <option value="">Every outcome</option>
            <option value="freeze">Frozen</option>
            <option value="unfreeze">Released</option>
            <option value="destroy">Destroyed</option>
          </select>
          <select className={sel} value={record} onChange={(e) => { setRecord(e.target.value); setShown(PAGE); }} aria-label="Public record">
            <option value="">With or without a record</option>
            <option value="yes">Has a public record</option>
            <option value="no">No record found</option>
          </select>
          <span className="mono ml-auto text-[12px] text-paper-3">{indices.length.toLocaleString()} of {ledger.latest.events_public.toLocaleString()}</span>
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
