/** The last run of verify.py, as it was written to data/verification_report.json,
 *  plus the hashes of the files this page is reading. */

import { DATA_BASE, type Ledger } from "../lib/data";
import { fmtDateTime, fmtInt } from "../lib/format";

const STATUS: Record<string, string> = { ok: "text-sage", FAIL: "text-ember", warn: "text-amber", skipped: "text-paper-3" };

export function Verification({ ledger }: { ledger: Ledger }) {
  const r = ledger.report;
  const files = ledger.latest.files;
  return (
    <section id="verification" className="px-5 py-16 md:px-8 md:py-20">
      <div className="mx-auto max-w-[72rem]">
        <h2 className="display text-[34px] md:text-[44px]">Verification</h2>
        <p className="mt-2 max-w-[48rem] text-paper-2">
          Nothing is committed until <a href="https://github.com/jakeperc/freeze-ledger/blob/main/verify.py" target="_blank" rel="noopener">verify.py</a> re-derives it: the schema, every receipt's hash, the published views against a fresh recomputation, a seeded sample of rows re-fetched from a second public node, and the OFAC extract against an independent one. This is its last report.
        </p>
        <div className="mt-8 grid gap-10 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="rule min-w-0 pt-4">
            {!r ? (
              <p className="text-paper-3">No report file was published with this data.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className={`text-[18px] ${r.failed ? "text-ember" : "text-sage"}`}>{r.failed ? `${r.failed} check(s) failed` : "All checks passed"}</div>
                  <div className="mono text-[12px] text-paper-3">{fmtDateTime(r.verified_at)} · seed {r.seed} · {fmtInt(r.events)} rows{r.offline ? " · offline" : ""}</div>
                </div>
                <ul className="mt-4 space-y-2">
                  {r.checks.map((c, i) => (
                    <li key={i} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[13px] sm:grid-cols-[4.5rem_11rem_minmax(0,1fr)]">
                      <span className={`mono ${STATUS[c.status] ?? ""}`}>{c.status}</span>
                      <span className="mono text-paper-2">{c.check}</span>
                      <span className="col-start-2 break-words text-paper-2 sm:col-start-auto">{c.detail}</span>
                    </li>
                  ))}
                </ul>
                {r.offline && <p className="mt-4 text-[12.5px] text-paper-3">This report ran offline: the chain re-derivation and the SDN cross-check were skipped. The nightly workflow runs them before it commits. You can re-derive any single row yourself from its receipt (click a row), or clone the repo and run <span className="mono">python verify.py</span>.</p>}
              </>
            )}
          </div>
          <div className="rule min-w-0 pt-4">
            <div className="text-[13px] text-paper-3">Files this page is reading</div>
            <ul className="mt-2 space-y-2">
              {Object.entries(files).map(([name, meta]) => (
                <li key={name} className="text-[12.5px]">
                  <a className="mono" href={DATA_BASE + name} download>{name}</a>
                  {meta.rows !== undefined && <span className="text-paper-3"> · {fmtInt(meta.rows)} rows</span>}
                  <div className="mono break-all text-[11px] text-paper-3">sha256 {meta.sha256}</div>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[12.5px] text-paper-3">Run it yourself:</p>
            <pre className="mono mt-1 overflow-x-auto text-[12px] text-paper-2">{`git clone https://github.com/jakeperc/freeze-ledger
cd freeze-ledger && python verify.py`}</pre>
          </div>
        </div>
      </div>
    </section>
  );
}
