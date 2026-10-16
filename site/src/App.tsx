import { useEffect, useState } from "react";
import { loadLatest, loadLedger, loadSiteCore, prefetchIds, type Latest, type SiteJson } from "./lib/data";
import { fmtInt } from "./lib/format";
import { useStore } from "./lib/store";
import { Hero } from "./sections/Hero";
import { Lookup } from "./sections/Lookup";
import { Method } from "./sections/Method";
import { Patterns } from "./sections/Patterns";
import { Registry } from "./sections/Registry";
import { Screen } from "./sections/Screen";
import { Verification } from "./sections/Verification";
import { Drawer } from "./ui/Drawer";
import { Palette } from "./ui/Palette";

/** Three stages, smallest first: the chapters as soon as latest.json lands,
 *  the field when its columns do, and the tools once every address and hash
 *  is in. Nothing waits on more than it needs. */
export function App() {
  const ledger = useStore((s) => s.ledger);
  const setLedger = useStore((s) => s.setLedger);
  const [latest, setLatest] = useState<Latest | null>(null);
  const [core, setCore] = useState<SiteJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
    const l = loadLatest();
    const c = loadSiteCore();
    prefetchIds().catch(() => {}); // surfaced by loadLedger
    l.then(setLatest, fail);
    c.then(setCore, fail);
    Promise.all([l, c]).then(([lv, cv]) => loadLedger(lv, cv)).then(setLedger, fail);
  }, [setLedger]);
  if (error)
    return (
      <div className="p-8 text-paper-2">
        The ledger's data files did not load ({error}). Run <code className="mono">python -m freeze_ledger export</code> and reload.
      </div>
    );
  if (!latest) return <div className="p-8 text-paper-3">Loading the ledger…</div>;
  return (
    <main>
      {/* the scene keeps the core columns object it started with, so the full
          ledger arriving later does not rebuild (and replay) the field */}
      <Hero latest={latest} site={core} />
      <div className="rule mx-5 md:mx-8" />
      {ledger ? (
        <>
          <Lookup ledger={ledger} />
          <div className="rule mx-5 md:mx-8" />
          <Registry ledger={ledger} />
          <div className="rule mx-5 md:mx-8" />
          <Patterns ledger={ledger} />
          <div className="rule mx-5 md:mx-8" />
          <Verification ledger={ledger} />
          <div className="rule mx-5 md:mx-8" />
          <Screen ledger={ledger} />
          <div className="rule mx-5 md:mx-8" />
          <Method ledger={ledger} />
          <Drawer ledger={ledger} />
          <Palette ledger={ledger} />
        </>
      ) : (
        <p className="px-5 py-16 text-paper-3 md:px-8" aria-live="polite">
          Loading {fmtInt(latest.events_total)} rows, their addresses and receipts…
        </p>
      )}
    </main>
  );
}
