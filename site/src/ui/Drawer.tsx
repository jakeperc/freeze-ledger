/** The receipt. One event: what the chain said, where it was read from, the
 *  hash of the raw bytes, the public record for the address, and a button
 *  that re-derives the row from a public node in the visitor's browser. */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { CONTRACTS, rederive, type Rederivation } from "../lib/chain";
import { CONF_LABEL, EXPLORER, recordLabel, type Chain, type Ledger } from "../lib/data";
import { fmtDateTime, fmtInt, fmtUsd, short } from "../lib/format";
import { eventRow } from "../lib/lookup";
import { useStore } from "../lib/store";
import { CopyButton } from "./CopyButton";

const REPO = "https://github.com/jakeperc/freeze-ledger";

export function Drawer({ ledger }: { ledger: Ledger }) {
  const drawer = useStore((s) => s.drawer);
  const openDrawer = useStore((s) => s.openDrawer);
  const [re, setRe] = useState<{ status: "idle" | "running" | "done"; result?: Rederivation }>({ status: "idle" });
  const index = drawer?.kind === "event" ? drawer.index! : null;

  const panel = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => { setRe({ status: "idle" }); }, [index]);
  // focus moves into the receipt when it opens and back to what opened it when it closes
  useEffect(() => {
    if (index !== null) {
      opener.current ??= document.activeElement;
      requestAnimationFrame(() => panel.current?.focus());
    } else if (opener.current) {
      (opener.current as HTMLElement).focus?.();
      opener.current = null;
    }
  }, [index]);
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") openDrawer(null); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [openDrawer]);

  const row = index !== null ? eventRow(ledger, index) : null;
  const receipt = row ? ledger.site.evidence[ledger.site.evid[row.index]] : null;
  const attributions = row ? ledger.attributions.get(`${row.chain}|${row.address}`) ?? [] : [];
  const contract = row ? CONTRACTS[row.chain as "ethereum" | "base"]?.find((c) => c.token === row.token)?.address ?? "" : "";
  const canRederive = row ? ["ethereum", "base", "tron"].includes(row.chain) : false;

  const run = async () => {
    if (!row) return;
    setRe({ status: "running" });
    const result = await rederive({ chain: row.chain as Chain, tx: row.tx, logIndex: row.logIndex, block: row.block, address: row.address, action: row.action, amount: row.amount, contract });
    setRe({ status: "done", result });
  };

  const card = () => {
    if (!row || !receipt) return "";
    const lines = [
      `Freeze Ledger — event ${row.chain}:${row.tx}:${row.logIndex}`,
      `${row.action} · ${row.token} on ${row.chain} · ${fmtDateTime(row.time)} · block ${row.block}`,
      `address ${row.address}${row.owner ? ` (token account of ${row.owner})` : ""}${row.amount !== null ? ` · amount ${fmtUsd(row.amount, 6)}` : ""}`,
      `receipt ${receipt.id} · ${receipt.kind} · sha256 ${receipt.sha256}`,
      `source ${receipt.locator}`,
      attributions.length ? `record ${attributions.map((a) => `${recordLabel(a)} (${a.confidence}): ${a.evidence_url}`).join(" | ")}` : "no public record found",
      `${REPO} · data as of ${ledger.latest.generated_at}`,
    ];
    return lines.join("\n");
  };

  return (
    <AnimatePresence>
      {row && receipt && (
        <>
          <motion.div key="scrim" className="fixed inset-0 z-40 bg-ink/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => openDrawer(null)} />
          <motion.aside
            key="panel"
            ref={panel}
            tabIndex={-1}
            onKeyDown={trap}
            role="dialog"
            aria-modal="true"
            aria-label="Event receipt"
            className="panel fixed inset-y-0 right-0 z-50 w-full max-w-[34rem] overflow-y-auto border-l border-rule-2 bg-ink px-6 py-6"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 36 }}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className={`display text-[30px] state-${row.action}`}>{row.action === "freeze" ? "Frozen" : row.action === "unfreeze" ? "Released" : "Destroyed"}</div>
                <div className="text-paper-2">{row.token} on {row.chain} · {fmtDateTime(row.time)}</div>
              </div>
              <button onClick={() => openDrawer(null)} aria-label="Close">Close</button>
            </div>

            <dl className="mt-6 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-[13px]">
              <dt className="text-paper-3">Address</dt>
              <dd className="mono break-all"><a href={EXPLORER[row.chain as Chain].address(row.address)} target="_blank" rel="noopener">{row.address}</a></dd>
              {row.owner && (<><dt className="text-paper-3">Owner</dt><dd className="mono break-all"><a href={EXPLORER[row.chain as Chain].address(row.owner)} target="_blank" rel="noopener">{row.owner}</a><div className="text-[11.5px] text-paper-3">wallet that owns the frozen token account</div></dd></>)}
              {row.amount !== null && (<><dt className="text-paper-3">Destroyed</dt><dd className="mono text-ember">{fmtUsd(row.amount, 2)} {row.token}</dd></>)}
              <dt className="text-paper-3">Transaction</dt>
              <dd className="mono break-all"><a href={EXPLORER[row.chain as Chain].tx(row.tx)} target="_blank" rel="noopener">{row.tx}</a></dd>
              <dt className="text-paper-3">Block · log</dt>
              <dd className="mono">{fmtInt(row.block)} · {row.logIndex}</dd>
              <dt className="text-paper-3">Row id</dt>
              <dd className="mono break-all text-paper-2">{row.chain}:{short(row.tx, 10, 6)}:{row.logIndex}</dd>
            </dl>

            <div className="rule mt-6 pt-4">
              <div className="text-[13px] text-paper-3">Receipt</div>
              <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-[13px]">
                <dt className="text-paper-3">Kind</dt><dd className="mono">{receipt.kind}</dd>
                <dt className="text-paper-3">Read from</dt><dd className="mono break-all text-paper-2">{receipt.locator}</dd>
                <dt className="text-paper-3">Fetched</dt><dd className="mono">{fmtDateTime(receipt.fetched_at)}</dd>
                <dt className="text-paper-3">SHA-256</dt>
                <dd className="mono break-all">
                  <a href={`${REPO}/blob/main/evidence/raw/${receipt.fetched_at.slice(0, 10)}/${receipt.sha256.slice(0, 16)}.json`} target="_blank" rel="noopener">{receipt.sha256}</a>
                </dd>
                <dt className="text-paper-3">Size</dt><dd className="mono">{fmtInt(receipt.bytes)} bytes</dd>
              </dl>
            </div>

            <div className="rule mt-6 pt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[13px] text-paper-3">Re-derive from a public node</div>
                <button className="primary" disabled={re.status === "running" || !canRederive} title={canRederive ? undefined : "Solana rows are re-derived by verify.py"} onClick={run}>{re.status === "running" ? "Fetching…" : re.status === "done" ? "Run again" : "Run in my browser"}</button>
              </div>
              <p className="mt-1 text-[12px] text-paper-3">{row.chain === "tron"
                ? `Fetches this transaction's events from TronGrid, takes the one at index ${row.logIndex}, and compares it with the row above.`
                : canRederive
                  ? `Fetches this transaction's receipt from a public endpoint, decodes the log at index ${row.logIndex} with the issuer's ABI, and compares it with the row above.`
                  : "Solana rows are re-derived by verify.py against a second public endpoint; the browser check covers Ethereum, Base and Tron."}</p>
              {re.status === "done" && re.result && (
                <div className="mt-3">
                  {re.result.error ? (
                    <div className="text-ember">{re.result.error}</div>
                  ) : (
                    <>
                      <div className={re.result.ok ? "text-sage" : "text-ember"}>{re.result.ok ? "Every field matches." : "A field does not match."}</div>
                      <table className="mt-2 text-[12.5px]">
                        <thead><tr><th>Field</th><th>Row</th><th>Chain</th><th></th></tr></thead>
                        <tbody>
                          {re.result.checks.map((c) => (
                            <tr key={c.field}>
                              <td className="text-paper-3">{c.field}</td>
                              <td className="mono break-all">{c.row}</td>
                              <td className="mono break-all">{c.chain}</td>
                              <td className={c.ok ? "text-sage" : "text-ember"}>{c.ok ? "ok" : "differs"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="mono mt-2 text-[11.5px] text-paper-3">{re.result.endpoint.replace(/^https?:\/\//, "")} · {re.result.ms} ms</div>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="rule mt-6 pt-4">
              <div className="text-[13px] text-paper-3">Public record for this address</div>
              {attributions.length === 0 ? (
                <p className="mt-2 text-[13px] text-paper-2">None found in the sources searched so far.</p>
              ) : (
                <ul className="mt-2 space-y-3 text-[13px]">
                  {attributions.map((a) => (
                    <li key={a.attribution_id}>
                      <div><span className="record">{recordLabel(a)}</span><span className="text-paper-3"> · {CONF_LABEL[["", "low", "moderate", "high"].indexOf(a.confidence)] ?? a.confidence} confidence · judged {a.judged_at}</span></div>
                      <div className="text-paper-2">{a.basis}</div>
                      <a className="break-all text-[12px]" href={a.evidence_url} target="_blank" rel="noopener">{a.evidence_url}</a>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              <CopyButton text={card} label="Copy as evidence card" />
              <button onClick={() => { openDrawer(null); dispatchEvent(new CustomEvent("fl:lookup", { detail: row.address })); document.querySelector("#lookup")?.scrollIntoView({ behavior: "smooth" }); }}>Look up this address</button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
