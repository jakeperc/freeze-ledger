/** Screen a list: paste any text with addresses in it and get each one's
 *  ledger status. Runs entirely in the browser; nothing is uploaded. */

import { useMemo, useState } from "react";
import { extractAddresses } from "../lib/chain";
import { recordLabel, type Ledger } from "../lib/data";
import { fmtDate, short } from "../lib/format";
import { addressView } from "../lib/lookup";

export function Screen({ ledger }: { ledger: Ledger }) {
  const [text, setText] = useState("");
  const addresses = useMemo(() => extractAddresses(text), [text]);
  const results = useMemo(
    () =>
      addresses.map((a) => {
        const v = addressView(ledger, a);
        const frozen = v?.states.filter((s) => s.frozen) ?? [];
        return { address: a, inLedger: !!v, frozen, released: v ? v.states.filter((s) => !s.frozen) : [], record: v?.attributions[0] ?? null, events: v?.events.length ?? 0 };
      }),
    [addresses, ledger],
  );
  const hits = results.filter((r) => r.frozen.length).length;
  const download = () => {
    const lines = ["address,in_ledger,frozen_now,frozen_on,released_on,public_record,confidence,events"];
    for (const r of results) {
      lines.push([
        r.address, r.inLedger, r.frozen.length > 0,
        `"${r.frozen.map((s) => `${s.token} ${s.chain}`).join("; ")}"`,
        `"${r.released.map((s) => `${s.token} ${s.chain}`).join("; ")}"`,
        `"${r.record ? recordLabel(r.record).replace(/"/g, '""') : ""}"`, r.record?.confidence ?? "", r.events,
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `freeze-ledger-screen-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section id="screen" className="px-5 py-16 md:px-8 md:py-20">
      <div className="max-w-[72rem]">
        <h2 className="display text-[34px] md:text-[44px]">Screen a list</h2>
        <p className="mt-2 max-w-[48rem] text-paper-2">
          Paste anything with addresses in it: a column from a spreadsheet, a JSON export, a block of text. Every address is checked against the ledger in your browser. Nothing is uploaded anywhere.
        </p>
        <textarea
          className="mono mt-6 h-36 w-full text-[13px]"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"0xabc…, 0xdef…\nTxyz…"}
          spellCheck={false}
          aria-label="Addresses to screen"
        />
        {addresses.length > 0 && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <div className="text-[15px]">
                <span className={hits ? "state-freeze" : "text-paper"}>{hits}</span> of {addresses.length} {addresses.length === 1 ? "address is" : "addresses are"} frozen right now
              </div>
              <button onClick={download}>Download results as CSV</button>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-[48rem] text-[13px]">
                <thead><tr><th>Address</th><th>Status</th><th>Where</th><th>Public record</th><th className="text-right">Events</th></tr></thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.address}>
                      <td className="mono" title={r.address}>{short(r.address, 10, 6)}</td>
                      <td className={r.frozen.length ? "state-freeze" : r.inLedger ? "state-unfreeze" : "text-paper-3"}>{r.frozen.length ? "Frozen" : r.inLedger ? "Released" : "Not in ledger"}</td>
                      <td className="text-paper-2">{r.frozen.map((s) => `${s.token} on ${s.chain}${s.since ? ` since ${fmtDate(s.since)}` : ""}`).join("; ") || r.released.map((s) => `${s.token} on ${s.chain}`).join("; ")}</td>
                      <td className={r.record ? "record" : "text-paper-3"}>{r.record ? `${recordLabel(r.record)} · ${r.record.confidence}` : r.inLedger ? "none found" : ""}</td>
                      <td className="mono text-right">{r.events || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
