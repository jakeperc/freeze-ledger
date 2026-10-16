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
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { Palette } from "./ui/Palette";

type Stage = "latest" | "core" | "ledger";

/** One section that fails to render says so in place; the rest of the page stays. */
function Guard({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <ErrorBoundary
      fallback={
        <section id={id} className="px-5 py-16 md:px-8">
          <div className="mx-auto max-w-[72rem]">
            <h2 className="display text-[34px] md:text-[44px]">{title}</h2>
            <p className="mt-2 text-paper-3">This part of the page failed to render. The same data is in the downloads under Method and in the repository.</p>
          </div>
        </section>
      }
    >
      {children}
    </ErrorBoundary>
  );
}

const devHint = import.meta.env.DEV
  ? <> Run <code className="mono">python -m freeze_ledger export</code> and reload.</>
  : <> Reload the page, or get the CSVs from the <a href="https://github.com/jakeperc/freeze-ledger">repository</a>.</>;

/** Three stages, smallest first: the chapters as soon as latest.json lands,
 *  the field when its columns do, and the tools once every address and hash
 *  is in. Nothing waits on more than it needs, and a stage that fails only
 *  takes down what needed it. */
export function App() {
  const ledger = useStore((s) => s.ledger);
  const setLedger = useStore((s) => s.setLedger);
  const [latest, setLatest] = useState<Latest | null>(null);
  const [core, setCore] = useState<SiteJson | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Stage, string>>>({});
  useEffect(() => {
    const fail = (stage: Stage) => (e: unknown) =>
      setErrors((cur) => ({ ...cur, [stage]: e instanceof Error ? e.message : String(e) }));
    const l = loadLatest();
    const c = loadSiteCore();
    prefetchIds().catch(() => {}); // surfaced by loadLedger
    l.then(setLatest, fail("latest"));
    c.then(setCore, fail("core"));
    Promise.all([l, c]).then(([lv, cv]) => loadLedger(lv, cv)).then(setLedger, fail("ledger"));
  }, [setLedger]);
  if (errors.latest)
    return (
      <div className="p-8 text-paper-2" role="alert">
        The ledger's data files did not load ({errors.latest}).{devHint}
      </div>
    );
  if (!latest) return <div className="p-8 text-paper-3" aria-live="polite">Loading the ledger…</div>;
  const rowsFailed = errors.ledger ?? errors.core;
  return (
    <>
      <a href="#lookup" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:border focus:border-frost focus:bg-ink focus:px-3 focus:py-2 focus:no-underline">
        Skip to the address lookup
      </a>
      <main>
        {/* the scene keeps the core columns object it started with, so the full
            ledger arriving later does not rebuild (and replay) the field */}
        <Hero latest={latest} site={core} />
        <div className="rule mx-5 md:mx-8" />
        {ledger ? (
          <>
            <Guard id="lookup" title="Look up an address"><Lookup ledger={ledger} /></Guard>
            <div className="rule mx-5 md:mx-8" />
            <Guard id="registry" title="Registry"><Registry ledger={ledger} /></Guard>
            <div className="rule mx-5 md:mx-8" />
            <Guard id="patterns" title="Patterns"><Patterns ledger={ledger} /></Guard>
            <div className="rule mx-5 md:mx-8" />
            <Guard id="verification" title="Verification"><Verification ledger={ledger} /></Guard>
            <div className="rule mx-5 md:mx-8" />
            <Guard id="screen" title="Screen a list"><Screen ledger={ledger} /></Guard>
            <div className="rule mx-5 md:mx-8" />
            <Guard id="method" title="Method, in short"><Method ledger={ledger} /></Guard>
            <ErrorBoundary fallback={null}><Drawer ledger={ledger} /></ErrorBoundary>
            <ErrorBoundary fallback={null}><Palette ledger={ledger} /></ErrorBoundary>
          </>
        ) : rowsFailed ? (
          <p className="px-5 py-16 text-paper-2 md:px-8" role="alert">
            The rows behind the tools below did not load ({rowsFailed}).{devHint}
          </p>
        ) : (
          <p className="px-5 py-16 text-paper-3 md:px-8" aria-live="polite">
            Loading {fmtInt(latest.events_total)} rows, their addresses and receipts…
          </p>
        )}
      </main>
    </>
  );
}
