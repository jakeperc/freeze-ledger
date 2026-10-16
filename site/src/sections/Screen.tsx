/** Screen a list: paste any text with addresses in it and get each one's
 *  ledger status, in the order pasted. Runs entirely in the browser; nothing
 *  is uploaded. Any result opens the full lookup for that address. */

import { useDeferredValue, useMemo, useState } from "react";
import { extractAddresses } from "../lib/chain";
import { recordLabel, type Ledger } from "../lib/data";
import { csvCell, fmtDate, short } from "../lib/format";
import { addressView } from "../lib/lookup";
import { downloadBlob, scrollToEl, useMedia } from "../lib/browser";
import { ListRow } from "../ui/ListRow";

/** More than this is a batch job; the page stays responsive and says so. */
const CAP = 5000;

export function Screen({ ledger }: { ledger: Ledger }) {
  const [text, setText] = useState("");
  // typing stays immediate; the screening catches up a beat later
  const pasted = useDeferredValue(text);
  const found = useMemo(() => extractAddresses(pasted), [pasted]);
  const results = useMemo(
    () =>
      found.slice(0, CAP).map((a) => {
        const v = addressView(ledger, a);
        const frozen = v?.states.filter((s) => s.frozen) ?? [];
        return { address: a, inLedger: !!v, frozen, released: v ? v.states.filter((s) => !s.frozen) : [], record: v?.attributions[0] ?? null, events: v?.events.length ?? 0 };
      }),
    [found, ledger],
  );
  const phone = useMedia("(max-width: 767px)");
  const hits = results.filter((r) => r.frozen.length).length;
  const lookup = (a: string) => {
    dispatchEvent(new CustomEvent("fl:lookup", { detail: a }));
    scrollToEl("#lookup");
  };
  const status = (r: (typeof results)[number]) =>
    r.frozen.length ? { word: "Frozen", cls: "state-freeze" } : r.inLedger ? { word: "Released", cls: "state-unfreeze" } : { word: "Not in ledger", cls: "text-paper-3" };
  const where = (r: (typeof results)[number]) =>
    r.frozen.map((s) => `${s.token} on ${s.chain}${s.since ? ` since ${fmtDate(s.since)}` : ""}`).join("; ") || r.released.map((s) => `${s.token} on ${s.chain}`).join("; ");

  const download = () => {
    const lines = ["address,in_ledger,frozen_now,frozen_on,frozen_since,released_on,public_record,confidence,events"];
    for (const r of results) {
      lines.push([
        r.address, r.inLedger, r.frozen.length > 0,
        r.frozen.map((s) => `${s.token} ${s.chain}`).join("; "),
        r.frozen.map((s) => (s.since ? fmtDate(s.since) : "")).join("; "),
        r.released.map((s) => `${s.token} ${s.chain}`).join("; "),
        r.record ? recordLabel(r.record) : "", r.record?.confidence ?? "", r.events,
      ].map(csvCell).join(","));
    }
    downloadBlob(`freeze-ledger-screen-${new Date().toISOString().slice(0, 10)}.csv`, new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  };

  return (
    <section id="screen" className="px-5 py-16 md:px-8 md:py-20">
      <div className="mx-auto max-w-[72rem]">
        <h2 className="display text-[34px] md:text-[44px]">Screen a list</h2>
        <p className="mt-2 max-w-[48rem] text-paper-2">
          Paste anything with addresses in it: a column from a spreadsheet, a JSON export, a block of text. Every address is checked against the ledger in your browser. Nothing is uploaded anywhere.
        </p>
        <textarea
          className="mono mt-6 min-h-36 w-full resize-y text-[13px]"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"0xabc…, 0xdef…\nTxyz…"}
          spellCheck={false}
          aria-label="Addresses to screen"
          aria-describedby="screen-summary"
        />
        {text && <button className="mt-2" onClick={() => setText("")}>Clear</button>}

        <div id="screen-summary" aria-live="polite">
          {pasted.trim() && found.length === 0 && (
            <p className="mt-4 text-paper-3">No Ethereum, Base, Tron or Solana addresses in this text.</p>
          )}
          {results.length > 0 && (
            <div className="mt-4 text-[15px]">
              <span className={hits ? "state-freeze" : "text-paper"}>{hits}</span> of {results.length} {results.length === 1 ? "address is" : "addresses are"} frozen right now
            </div>
          )}
          {found.length > CAP && (
            <p className="mt-1 text-[12.5px] text-amber">Screening the first {CAP.toLocaleString()} of {found.length.toLocaleString()} addresses. Split the list to screen the rest.</p>
          )}
        </div>

        {results.length > 0 && (
          <>
            <button className="mt-3" onClick={download}>Download results as CSV</button>
            {phone ? (
              <ul className="mt-4 border-t border-rule">
                {results.map((r) => {
                  const st = status(r);
                  return (
                    <ListRow
                      key={r.address}
                      onOpen={() => lookup(r.address)}
                      label={`Look up ${r.address}: ${st.word}`}
                      top={<span className="mono">{short(r.address, 10, 6)}</span>}
                      topEnd={r.events ? `${r.events} event${r.events === 1 ? "" : "s"}` : undefined}
                      bottom={<><span className={st.cls}>{st.word}</span><span className="text-paper-2">{where(r) ? ` · ${where(r)}` : ""}</span></>}
                      bottomEnd={r.record ? <span className="record">{recordLabel(r.record)}</span> : undefined}
                    />
                  );
                })}
              </ul>
            ) : (
              <table className="mt-4 text-[13px]">
                <thead><tr><th>Address</th><th>Status</th><th>Where</th><th>Public record</th><th className="text-right">Events</th></tr></thead>
                <tbody>
                  {results.map((r) => {
                    const st = status(r);
                    return (
                      <tr key={r.address}>
                        <td className="mono whitespace-nowrap">
                          <button className="min-h-0 rounded-none border-0 p-0 text-left underline decoration-rule-2 underline-offset-[3px] hover:decoration-frost" onClick={() => lookup(r.address)} title={r.address} aria-label={`Look up ${r.address}`}>
                            {short(r.address, 10, 6)}
                          </button>
                        </td>
                        <td className={st.cls}>{st.word}</td>
                        <td className="text-paper-2">{where(r)}</td>
                        <td className={r.record ? "record" : "text-paper-3"}>{r.record ? `${recordLabel(r.record)} · ${r.record.confidence}` : r.inLedger ? "none found" : ""}</td>
                        <td className="mono text-right">{r.events || ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </section>
  );
}
