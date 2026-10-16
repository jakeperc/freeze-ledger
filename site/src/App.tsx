import { Fragment, lazy, Suspense, useEffect, useRef, useState } from "react";
import { loadLatest, loadLedger, loadSiteCore, type Latest, type SiteJson } from "./lib/data";
import { fmtInt } from "./lib/format";
import { useStore } from "./lib/store";
import { Hero } from "./sections/Hero";
import { Lookup } from "./sections/Lookup";
import { Method } from "./sections/Method";
import { Patterns } from "./sections/Patterns";
import { Registry } from "./sections/Registry";
import { Screen } from "./sections/Screen";
import { Verification } from "./sections/Verification";
import { ErrorBoundary } from "./ui/ErrorBoundary";

// the receipt and the palette load the first time they are opened (and on idle)
const loadDrawer = () => import("./ui/Drawer");
const loadPalette = () => import("./ui/Palette");
const Drawer = lazy(() => loadDrawer().then((m) => ({ default: m.Drawer })));
const Palette = lazy(() => loadPalette().then((m) => ({ default: m.Palette })));

const SECTIONS = [
  ["lookup", "Look up an address"],
  ["registry", "Registry"],
  ["patterns", "Patterns"],
  ["verification", "Verification"],
  ["screen", "Screen a list"],
  ["method", "Method, in short"],
] as const;
const TITLE = Object.fromEntries(SECTIONS) as Record<(typeof SECTIONS)[number][0], string>;

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
    l.then(setLatest, fail("latest"));
    c.then(setCore, fail("core"));
    Promise.all([l, c]).then(([lv, cv]) => loadLedger(lv, cv)).then(setLedger, fail("ledger"));
  }, [setLedger]);

  // ⌘K / Ctrl+K opens the palette from the first paint
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = useStore.getState();
        s.setPaletteOpen(!s.paletteOpen);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const drawerOpen = useStore((s) => s.drawer !== null);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const [mounted, setMounted] = useState({ drawer: false, palette: false });
  useEffect(() => { if (drawerOpen) setMounted((m) => (m.drawer ? m : { ...m, drawer: true })); }, [drawerOpen]);
  useEffect(() => { if (paletteOpen) setMounted((m) => (m.palette ? m : { ...m, palette: true })); }, [paletteOpen]);

  // A link straight to a section lands on its placeholder; when the rows
  // arrive and the sections above grow, land there again, unless the
  // visitor has started moving around the page themselves.
  const moved = useRef(false);
  useEffect(() => {
    const mark = () => { moved.current = true; };
    const evs = ["wheel", "touchstart", "keydown", "mousedown"] as const;
    evs.forEach((ev) => addEventListener(ev, mark, { passive: true }));
    return () => evs.forEach((ev) => removeEventListener(ev, mark));
  }, []);
  useEffect(() => {
    if (!ledger) return;
    const idle = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500));
    idle(() => { loadDrawer(); loadPalette(); });
    if (moved.current || !location.hash) return;
    requestAnimationFrame(() => {
      try { document.querySelector(location.hash)?.scrollIntoView(); } catch { /* not a selector */ }
    });
  }, [ledger]);

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
      <main id="top">
        {/* the scene keeps the core columns object it started with, so the full
            ledger arriving later does not rebuild (and replay) the field */}
        <Hero latest={latest} site={core} />
        <div className="rule mx-5 md:mx-8" />
        {ledger ? (
          <>
            <Guard id="lookup" title={TITLE.lookup}><Lookup ledger={ledger} /></Guard>
            <div className="rule mx-5 md:mx-8" />
            <Guard id="registry" title={TITLE.registry}><Registry ledger={ledger} /></Guard>
            <div className="rule mx-5 md:mx-8" />
            <Guard id="patterns" title={TITLE.patterns}><Patterns ledger={ledger} /></Guard>
            <div className="rule mx-5 md:mx-8" />
            <Guard id="verification" title={TITLE.verification}><Verification ledger={ledger} /></Guard>
            <div className="rule mx-5 md:mx-8" />
            <Guard id="screen" title={TITLE.screen}><Screen ledger={ledger} /></Guard>
            <div className="rule mx-5 md:mx-8" />
            <Guard id="method" title={TITLE.method}><Method ledger={ledger} /></Guard>
            {mounted.drawer && <ErrorBoundary fallback={null}><Suspense fallback={null}><Drawer ledger={ledger} /></Suspense></ErrorBoundary>}
          </>
        ) : rowsFailed ? (
          <p className="px-5 py-16 text-paper-2 md:px-8" role="alert">
            The rows behind the tools below did not load ({rowsFailed}).{devHint}
          </p>
        ) : (
          // placeholders with the real ids and headings, so links to a section
          // and the palette's "Go to" work before the rows have loaded
          SECTIONS.map(([id, title], i) => (
            <Fragment key={id}>
              {i > 0 && <div className="rule mx-5 md:mx-8" />}
              <section id={id} className="px-5 py-16 md:px-8 md:py-20">
                <div className="mx-auto max-w-[72rem]">
                  <h2 className="display text-[34px] md:text-[44px]">{title}</h2>
                  {i === 0 ? (
                    <p className="mt-2 text-paper-3" aria-live="polite">Loading {fmtInt(latest.events_total)} rows, their addresses and receipts…</p>
                  ) : (
                    <p className="mt-2 text-paper-3">Loading…</p>
                  )}
                </div>
              </section>
            </Fragment>
          ))
        )}
      </main>
      {mounted.palette && <ErrorBoundary fallback={null}><Suspense fallback={null}><Palette ledger={ledger} /></Suspense></ErrorBoundary>}
    </>
  );
}
