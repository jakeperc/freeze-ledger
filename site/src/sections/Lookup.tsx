/** Paste an address: the ledger's history for it, its current state per
 *  chain and token, the public record attached to it, and a button that asks
 *  the issuer contracts directly, from the visitor's browser, whether it is
 *  frozen right now. */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { isEvmAddress, isTronAddress, liveStatus, normalizeAddress, type LiveStatus } from "../lib/chain";
import { EXPLORER, recordLabel, type Chain, type Ledger } from "../lib/data";
import { fmtCompactUsd, fmtDate, fmtDateTime, short } from "../lib/format";
import { addressView } from "../lib/lookup";
import { useStore } from "../lib/store";

const SOURCE: Record<string, string> = { ofac_sdn: "OFAC SDN list", federal_register: "Federal Register", doj: "DOJ", court: "court record", issuer: "issuer statement", explorer_label: "explorer label", press: "press", tracker: "tracker" };
const dedupe = <T extends { entity: string; evidence_url: string; confidence: string }>(rows: T[]) => {
  const seen = new Set<string>();
  return rows.filter((r) => { const k = `${r.entity}|${r.evidence_url}|${r.confidence}`; if (seen.has(k)) return false; seen.add(k); return true; });
};

export function Lookup({ ledger }: { ledger: Ledger }) {
  const [text, setText] = useState(() => new URLSearchParams(location.search).get("a") ?? "");
  const [live, setLive] = useState<{ status: "idle" | "loading" | "done" | "error"; rows: LiveStatus[]; error?: string }>({ status: "idle", rows: [] });
  const openDrawer = useStore((s) => s.openDrawer);
  const address = normalizeAddress(text);
  const view = useMemo(() => (address ? addressView(ledger, address) : null), [ledger, address]);

  useEffect(() => {
    const onLookup = (e: Event) => setText((e as CustomEvent<string>).detail);
    addEventListener("fl:lookup", onLookup);
    return () => removeEventListener("fl:lookup", onLookup);
  }, []);

  useEffect(() => {
    setLive({ status: "idle", rows: [] });
    const url = new URL(location.href);
    if (address) url.searchParams.set("a", address); else url.searchParams.delete("a");
    history.replaceState(null, "", url);
  }, [address]);

  const check = async () => {
    if (!address) return;
    setLive({ status: "loading", rows: [] });
    try {
      const rows = await liveStatus(address, (view?.states ?? []).map((s) => s.account).filter((a): a is string => !!a));
      setLive({ status: "done", rows });
    } catch (e) {
      setLive({ status: "error", rows: [], error: e instanceof Error ? e.message : String(e) });
    }
  };

  const example = ledger.site.addr.find((_, i) => ledger.site.conf[i] === 3 && ledger.site.actions[ledger.site.a[i]] === "freeze") ?? "";
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    navigator.clipboard?.writeText(location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); });
  };
  const askWhom = !address ? "" : isTronAddress(address)
    ? "Tether's USDT contract on Tron"
    : isEvmAddress(address)
      ? "Tether's and Circle's contracts on Ethereum and Base"
      : "Solana for the state of this token account, or of the token accounts the ledger knows this wallet owns,";

  return (
    <section id="lookup" className="px-5 py-16 md:px-8 md:py-24">
      <div className="max-w-[72rem]">
        <h2 className="display text-[34px] md:text-[44px]">Look up an address</h2>
        <p className="mt-2 max-w-[48rem] text-paper-2">
          Any Ethereum, Base, Tron or Solana address. The answer comes from the ledger first, then from the issuer contracts themselves if you ask.
          Nothing you type leaves your browser except that one optional contract call.
        </p>
        <div className="mt-6 flex flex-col gap-2 md:flex-row">
          <input
            className="mono flex-1 text-[14px]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="0x… or T… or a Solana address"
            spellCheck={false}
            autoComplete="off"
            aria-label="Address"
          />
          <button className="primary" disabled={!address || live.status === "loading"} onClick={check}>
            {live.status === "loading" ? "Asking the contracts…" : "Check live on-chain"}
          </button>
        </div>
        {!text && example && (
          <p className="mt-2 text-[12.5px] text-paper-3">
            Try one that matches the sanctions list: <button className="mono border-0 p-0 underline" onClick={() => setText(example)}>{short(example, 10, 6)}</button>
          </p>
        )}
        {text && !address && <p className="mt-2 text-[12.5px] text-ember">That does not look like an address on a chain this ledger covers.</p>}

        <AnimatePresence mode="wait">
          {address && (
            <motion.div key={address} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} className="mt-8">
              {!view ? (
                <div className="rule pt-5">
                  <div className="text-[18px]">Not in the ledger.</div>
                  <p className="mt-1 max-w-[48rem] text-paper-2">
                    No freeze, release or destroyed balance for <span className="mono">{short(address, 10, 6)}</span> on the chains and date ranges indexed so far. That is not the same as never frozen: check live on-chain, and see the coverage note under the field for what is not indexed yet.
                  </p>
                  {live.status === "error" && <p className="mt-3 text-ember">The public nodes did not answer ({live.error}). Try again in a moment.</p>}
                  {live.status === "done" && (
                    <ul className="mt-3 space-y-1.5">
                      {live.rows.length === 0 && <li className="text-paper-3">This is not a USDC or USDT token account. Listing a wallet's token accounts needs an indexed call that free public nodes refuse from a browser; paste the token account instead.</li>}
                      {live.rows.map((r) => (
                        <li key={r.chain + r.token + (r.account ?? "")} className="flex flex-wrap items-baseline justify-between gap-x-4">
                          <div>
                            <span className={r.frozen ? "state-freeze" : "text-paper-2"}>{r.frozen ? "Frozen" : "Not frozen"}</span>
                            <span className="text-paper-2"> {r.token} on {r.chain}</span>
                            {r.frozen && <span className="ml-2 text-[12px] text-ember">frozen on-chain but not in the ledger yet</span>}
                          </div>
                          <div className="mono text-[11.5px] text-paper-3">{r.block ? `${r.chain === "solana" ? "slot" : "block"} ${r.block.toLocaleString()} · ` : ""}{r.endpoint.replace(/^https?:\/\//, "")} · {r.ms} ms</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="grid gap-8 md:grid-cols-[1.1fr_1fr]">
                  <div>
                    <div className="rule pt-4 text-[12px] text-paper-3">Ledger state</div>
                    <div className="mt-2 space-y-2">
                      {view.states.map((st) => (
                        <div key={st.chain + st.token} className="flex items-baseline justify-between gap-4">
                          <div>
                            <span className={st.frozen ? "state-freeze" : "state-unfreeze"}>{st.frozen ? "Frozen" : "Released"}</span>
                            <span className="text-paper-2"> {st.token} on {st.chain}</span>
                            {st.account && <div className="mono text-[11.5px] text-paper-3">token account {short(st.account, 8, 6)}, owned by this wallet</div>}
                          </div>
                          <div className="mono text-[12.5px] text-paper-3">{st.frozen && st.since ? `since ${fmtDate(st.since)}` : ""}</div>
                        </div>
                      ))}
                    </div>

                    <div className="rule mt-6 pt-4 text-[12px] text-paper-3">Public record</div>
                    {view.attributions.length === 0 ? (
                      <p className="mt-2 text-paper-2">No public record found for this address: no OFAC listing, filing, notice or issuer statement in the sources searched so far.</p>
                    ) : (
                      <ul className="mt-2 space-y-3">
                        {dedupe(view.attributions).map((a) => (
                          <li key={a.attribution_id} className="text-[13.5px]">
                            <div>
                              <span className="record">{recordLabel(a)}</span>
                              <span className="text-paper-3"> · {SOURCE[a.source_class] ?? a.source_class} · {a.confidence} confidence{a.record_date ? ` · ${a.record_date}` : ""}</span>
                            </div>
                            <div className="text-paper-2">{a.basis}</div>
                            <a className="mono text-[12px]" href={a.evidence_url} target="_blank" rel="noopener">{a.evidence_url.split("/").pop()}</a>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="rule mt-6 pt-4 text-[12px] text-paper-3">Live from the contracts</div>
                    {live.status === "idle" && <p className="mt-2 text-paper-3">Press “Check live on-chain” to ask {askWhom} whether this address is blocked at this moment.</p>}
                    {live.status === "done" && live.rows.length === 0 && <p className="mt-2 text-paper-3">This is not a USDC or USDT token account. Listing a wallet's token accounts needs an indexed call that free public nodes refuse from a browser; paste the token account instead.</p>}
                    {live.status === "error" && <p className="mt-2 text-ember">The public nodes did not answer ({live.error}). Try again in a moment.</p>}
                    {live.status === "done" && (
                      <ul className="mt-2 space-y-1.5">
                        {live.rows.map((r) => {
                          const ledgerSays = view.states.find((s) => s.chain === r.chain && s.token === r.token && (!r.account || (s.account ?? view.address) === r.account));
                          const agrees = ledgerSays ? ledgerSays.frozen === r.frozen : !r.frozen;
                          return (
                            <li key={r.chain + r.token + (r.account ?? "")} className="flex flex-wrap items-baseline justify-between gap-x-4">
                              <div>
                                <span className={r.frozen ? "state-freeze" : "text-paper-2"}>{r.frozen ? "Frozen" : "Not frozen"}</span>
                                <span className="text-paper-2"> {r.token} on {r.chain}</span>
                                <span className={`ml-2 text-[12px] ${agrees ? "text-sage" : "text-ember"}`}>{agrees ? "matches the ledger" : "differs from the ledger"}</span>
                              </div>
                              <div className="mono text-[11.5px] text-paper-3">{r.account && r.account !== view.address ? `account ${short(r.account, 6, 4)} · ` : ""}{r.block ? `${r.chain === "solana" ? "slot" : "block"} ${r.block.toLocaleString()} · ` : ""}{r.endpoint.replace(/^https?:\/\//, "")} · {r.ms} ms</div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  <div>
                    <div className="rule pt-4 text-[12px] text-paper-3">History · {view.events.length} event{view.events.length === 1 ? "" : "s"}</div>
                    <ol className="mt-2 space-y-1.5">
                      {view.events.map((i) => {
                        const s = ledger.site;
                        const action = s.actions[s.a[i]], chain = s.chains[s.c[i]] as Chain;
                        return (
                          <li key={i} className="flex items-baseline justify-between gap-3 text-[13.5px]">
                            <button className="border-0 p-0 text-left" onClick={() => openDrawer({ kind: "event", index: i })}>
                              <span className={`state-${action}`}>{action === "freeze" ? "Frozen" : action === "unfreeze" ? "Released" : "Destroyed"}</span>
                              <span className="text-paper-2"> {s.tokens[s.k[i]]} on {chain}</span>
                              {s.amt[i] !== null && <span className="mono text-ember"> {fmtCompactUsd(s.amt[i])}</span>}
                            </button>
                            <span className="mono text-[12px] text-paper-3">{fmtDateTime(s.t[i]).slice(0, 10)}</span>
                          </li>
                        );
                      })}
                    </ol>
                    <div className="mt-4 flex flex-wrap gap-3 text-[12.5px]">
                      {view.chains.map((c) => (
                        <a key={c} href={EXPLORER[c as Chain].address(address)} target="_blank" rel="noopener">{c} explorer</a>
                      ))}
                      <button className="border-0 p-0 underline" onClick={copyLink} aria-live="polite">{copied ? "Copied" : "Copy link to this lookup"}</button>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
