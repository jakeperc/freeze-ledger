/** The field pinned under a column of chapters. Scrolling through the
 *  chapters changes the layout and color of the field; the controls let a
 *  visitor do the same by hand. */

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { animate } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildChapters } from "../lib/copy";
import type { Latest, SiteJson } from "../lib/data";
import { normalizeAddress } from "../lib/chain";
import { isWide, useStore, type ColorMode, type Layout } from "../lib/store";
import { Scene } from "../scene/Scene";

gsap.registerPlugin(ScrollTrigger);

const LAYOUTS: { id: Layout; label: string; hint: string }[] = [
  { id: "timeline", label: "Timeline", hint: "one lane per chain and token, left to right in time" },
  { id: "entities", label: "By record", hint: "clusters by the public record behind each address" },
];
const COLORS: { id: ColorMode; label: string }[] = [
  { id: "chain", label: "Chain" },
  { id: "action", label: "Outcome" },
  { id: "record", label: "Record" },
];

function Figure({ text, active }: { text: string; active: boolean }) {
  // Numbers count up when their chapter arrives; text with letters just
  // appears. The real value is always the element's text: the count-up is
  // drawn over it as generated content, so a screen reader, a crawler, a link
  // preview or a background tab (where animation frames never run) reads the
  // number, never the "0" a count-up starts from.
  const numeric = /^[\d,.]+[BMk]?$/.test(text.replace(/[$%]/g, ""));
  const target = numeric ? parseFloat(text.replace(/[^0-9.]/g, "")) : 0;
  const [shown, setShown] = useState<string | null>(null);
  const reduced = useStore((s) => s.reducedMotion);
  useEffect(() => {
    if (!active || !numeric || reduced || document.visibilityState !== "visible") return;
    const digits = text.includes(".") ? text.split(".")[1].replace(/[^0-9]/g, "").length : 0;
    const fmt = (v: number) => text.replace(/[\d,.]+/, v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
    setShown(fmt(0));
    const c = animate(0, target, { duration: 1.4, ease: [0.16, 1, 0.3, 1], onUpdate: (v) => setShown(fmt(v)), onComplete: () => setShown(null) });
    return () => { c.stop(); setShown(null); };
  }, [active, target, numeric, reduced, text]);
  return (
    <span className="relative inline-block">
      <span style={shown === null ? undefined : { color: "transparent" }}>{text}</span>
      {shown !== null && <span aria-hidden className="absolute inset-0 whitespace-nowrap before:content-[attr(data-v)]" data-v={shown} />}
    </span>
  );
}

export function Hero({ latest, site }: { latest: Latest; site: SiteJson | null }) {
  const chapters = useMemo(() => buildChapters(latest), [latest]);
  const setLayout = useStore((s) => s.setLayout);
  const setColorMode = useStore((s) => s.setColorMode);
  const layout = useStore((s) => s.layout);
  const colorMode = useStore((s) => s.colorMode);
  const chapter = useStore((s) => s.chapter);
  const setChapter = useStore((s) => s.setChapter);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const root = useRef<HTMLDivElement>(null);
  const [manual, setManual] = useState(false); // once a visitor touches the controls, scrolling stops overriding them

  useEffect(() => {
    const el = root.current!;
    const blocks = el.querySelectorAll<HTMLElement>("[data-chapter]");
    const triggers: ScrollTrigger[] = [];
    // stacked, a chapter is current from when its top clears the pinned band
    const pin = el.querySelector<HTMLElement>(".scene-pin")!;
    const edge = () => (isWide() ? "55%" : `${pin.offsetHeight + 1}px`);
    blocks.forEach((b, i) => {
      triggers.push(
        ScrollTrigger.create({
          trigger: b,
          start: () => `top ${edge()}`,
          end: () => `bottom ${edge()}`,
          onEnter: () => enter(i),
          onEnterBack: () => enter(i),
        }),
      );
    });
    const enter = (i: number) => {
      setChapter(i);
      if (manual) return;
      const c = chapters[i];
      if (i === 0 && useStore.getState().layout !== c.layout && new URLSearchParams(location.search).get("hero")) return; // respect ?hero= on the first chapter
      setLayout(c.layout);
      setColorMode(c.colorMode);
    };
    return () => triggers.forEach((t) => t.kill());
  }, [chapters, manual, setChapter, setLayout, setColorMode]);

  return (
    <section ref={root} className="relative" aria-label="The field">
      <div className="scene-pin z-20 overflow-hidden bg-ink wide:z-0">
        {site && <Scene site={site} />}
        {/* keeps the floating chapter text readable over the brightest points */}
        <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-[1] hidden w-[42rem] bg-gradient-to-r from-ink/90 via-ink/60 to-transparent wide:block" />

        {/* masthead */}
        <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between px-5 pt-4 md:px-8">
          <div className="pointer-events-auto">
            <div className="display text-[22px] leading-none">Freeze Ledger</div>
            <div className="mt-1 text-[12px] text-paper-3">Every stablecoin issuer freeze, with its receipt</div>
          </div>
          <nav className="pointer-events-auto hidden items-center gap-5 text-[13px] text-paper-2 md:flex">
            <MastheadLookup />
            <a href="#registry" className="no-underline hover:text-paper">Registry</a>
            <a href="#patterns" className="no-underline hover:text-paper">Patterns</a>
            <a href="#verification" className="no-underline hover:text-paper">Verification</a>
            <a href="#method" className="no-underline hover:text-paper">Method</a>
            <button onClick={() => setPaletteOpen(true)} className="flex items-center gap-2 border-rule-2 px-2 py-1 text-[12px]">
              Search <kbd>⌘K</kbd>
            </button>
          </nav>
        </header>

        {/* controls */}
        <div data-controls className="absolute bottom-5 left-5 z-10 flex flex-wrap items-end gap-x-6 gap-y-3 md:left-8 md:bottom-7">
          <div>
            <div className="mb-1.5 text-[11px] text-paper-3">Arrange</div>
            <div className="flex gap-1.5">
              {LAYOUTS.map((l) => (
                <button key={l.id} aria-pressed={layout === l.id} title={l.hint} onClick={() => { setManual(true); setLayout(l.id); }} className="px-2.5 py-1 text-[12px]">
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] text-paper-3">Color by</div>
            <div className="flex gap-1.5">
              {COLORS.map((c) => (
                <button key={c.id} aria-pressed={colorMode === c.id} onClick={() => { setManual(true); setColorMode(c.id); }} className="px-2.5 py-1 text-[12px]">
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <Legend colorMode={colorMode} />
          {site && <Scrubber site={site} />}
        </div>
      </div>

      {/* chapters scroll over the pinned scene on wide landscape screens, under it
          everywhere else; over the scene they must not take the pointer from the
          menu, the controls or the points */}
      <div className="relative z-10 wide:pointer-events-none wide:-mt-[100vh]">
        {chapters.map((c, i) => (
          <div key={c.id} data-chapter={c.id} className="flex min-h-[calc(100dvh-var(--scene-h))] items-start px-5 pt-8 pb-10 md:px-8 wide:min-h-[80vh] wide:items-center wide:py-0">
            <div className={`max-w-[34rem] transition-opacity duration-500 ${chapter === i ? "opacity-100" : "opacity-35"}`}>
              <div className="display text-[clamp(44px,9vw,124px)] text-paper tnum">
                <Figure text={c.figure} active={chapter === i} />
              </div>
              <div className="mt-2 text-[18px] leading-snug text-paper md:text-[21px]">{c.figureLabel}</div>
              <div className="mt-5 space-y-2 text-[14.5px] leading-relaxed text-paper-2">
                {c.lines.map((l, j) => <p key={j}>{l}</p>)}
              </div>
              {c.caveat && <p className="mt-4 max-w-[30rem] text-[12.5px] leading-relaxed text-paper-3">{c.caveat}</p>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Drag through time: events after the cut disappear, the count follows. */
function Scrubber({ site: s }: { site: SiteJson }) {
  const cut = useStore((s) => s.timeCut);
  const setCut = useStore((s) => s.setTimeCut);
  const t0 = s.t[0], t1 = s.t[s.n - 1];
  const at = t0 + (t1 - t0) * cut;
  // events up to the cut, excluding issuer-internal rows (binary search on the sorted time column)
  let lo = 0, hi = s.n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s.t[mid] <= at) lo = mid + 1; else hi = mid; }
  const shown = lo;
  return (
    <div className="min-w-[14rem] md:ml-auto md:mr-8">
      <div className="mb-1.5 flex items-baseline justify-between text-[11px] text-paper-3">
        <span>Through</span>
        <span className="mono text-paper-2">{new Date(at * 1000).toISOString().slice(0, 10)} · {shown.toLocaleString()} events</span>
      </div>
      <input type="range" min={0} max={1000} value={Math.round(cut * 1000)} onChange={(e) => setCut(Number(e.target.value) / 1000)} className="w-full" aria-label="Show events through a date" />
    </div>
  );
}

function Legend({ colorMode }: { colorMode: ColorMode }) {
  const items =
    colorMode === "chain"
      ? [["Ethereum", "var(--color-eth)"], ["Base", "var(--color-base)"], ["Tron", "var(--color-tron)"], ["Solana", "var(--color-sol)"]]
      : colorMode === "action"
        ? [["Frozen", "var(--color-frost)"], ["Released", "var(--color-sage)"], ["Destroyed", "var(--color-ember)"]]
        : [["Public record", "var(--color-amber)"], ["No record found", "#3c3c5c"]];
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-paper-2">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** The page's first job is "is this address frozen?", so the question can be
 *  asked from the masthead without scrolling past the chapters. */
function MastheadLookup() {
  const [q, setQ] = useState("");
  const addr = normalizeAddress(q);
  const go = () => {
    if (!addr) return;
    const u = new URL(location.href);
    u.searchParams.set("a", addr);
    history.replaceState(null, "", u); // read by the lookup if it mounts after this
    dispatchEvent(new CustomEvent("fl:lookup", { detail: addr }));
    document.querySelector("#lookup")?.scrollIntoView({ behavior: "smooth" });
    setQ("");
  };
  return (
    <form role="search" onSubmit={(e) => { e.preventDefault(); go(); }} className="flex items-center">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Look up an address"
        aria-label="Look up an address"
        spellCheck={false}
        autoComplete="off"
        className={`mono w-[15rem] bg-ink/80 px-2.5 py-1 text-[12.5px] lg:w-[19rem] ${q && !addr ? "border-ember" : ""}`}
      />
    </form>
  );
}
