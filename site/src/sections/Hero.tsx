/** The field pinned under a column of chapters. Scrolling through the
 *  chapters changes the layout and color of the field; the controls let a
 *  visitor do the same by hand. */

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildChapters } from "../lib/copy";
import type { Ledger } from "../lib/data";
import { useStore, type ColorMode, type Layout } from "../lib/store";
import { Scene } from "../scene/Scene";

gsap.registerPlugin(ScrollTrigger);

const LAYOUTS: { id: Layout; label: string; hint: string }[] = [
  { id: "timeline", label: "Timeline", hint: "one lane per chain and token, left to right in time" },
  { id: "entities", label: "By record", hint: "clusters by the public record behind each address" },
  { id: "chains", label: "Rings", hint: "one ring per chain and token, time around the clock" },
];
const COLORS: { id: ColorMode; label: string }[] = [
  { id: "chain", label: "Chain" },
  { id: "action", label: "Outcome" },
  { id: "record", label: "Record" },
];

function Figure({ text, active }: { text: string; active: boolean }) {
  // numbers count up when their chapter arrives; text with letters just appears
  const numeric = /^[\d,.]+$/.test(text.replace(/[$%]/g, ""));
  const target = numeric ? parseFloat(text.replace(/[^0-9.]/g, "")) : 0;
  const mv = useMotionValue(0);
  const shown = useTransform(mv, (v) => {
    if (!numeric) return text;
    const digits = text.includes(".") ? text.split(".")[1].replace(/[^0-9]/g, "").length : 0;
    const s = v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
    return text.replace(/[\d,.]+/, s);
  });
  const reduced = useStore((s) => s.reducedMotion);
  useEffect(() => {
    if (!active) return;
    if (!numeric || reduced) { mv.set(target); return; }
    const c = animate(mv, target, { duration: 1.4, ease: [0.16, 1, 0.3, 1] });
    return () => c.stop();
  }, [active, target, numeric, reduced, mv]);
  return <motion.span>{shown}</motion.span>;
}

export function Hero({ ledger }: { ledger: Ledger }) {
  const chapters = useMemo(() => buildChapters(ledger.latest), [ledger]);
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
    const narrow = innerWidth < 768;
    blocks.forEach((b, i) => {
      triggers.push(
        ScrollTrigger.create({
          trigger: b,
          start: narrow ? "top 85%" : "top 55%",
          end: narrow ? "bottom 85%" : "bottom 55%",
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
      <div className="scene-pin z-20 overflow-hidden bg-ink md:z-0">
        <Scene site={ledger.site} />

        {/* masthead */}
        <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between px-5 pt-4 md:px-8">
          <div className="pointer-events-auto">
            <div className="display text-[22px] leading-none">Freeze Ledger</div>
            <div className="mt-1 text-[12px] text-paper-3">Every stablecoin issuer freeze, with its receipt</div>
          </div>
          <nav className="pointer-events-auto hidden items-center gap-5 text-[13px] text-paper-2 md:flex">
            <a href="#lookup" className="no-underline hover:text-paper">Look up an address</a>
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
        <div className="absolute bottom-5 left-5 z-10 flex flex-wrap items-end gap-x-6 gap-y-3 md:left-8 md:bottom-7">
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
          <Scrubber ledger={ledger} />
        </div>
      </div>

      {/* chapters scroll over the pinned scene on wide screens, under it on phones */}
      <div className="relative z-10 md:-mt-[100vh]">
        {chapters.map((c, i) => (
          <div key={c.id} data-chapter={c.id} className="flex min-h-[60vh] items-center px-5 py-10 md:min-h-[100vh] md:py-0 md:px-8">
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
function Scrubber({ ledger }: { ledger: Ledger }) {
  const cut = useStore((s) => s.timeCut);
  const setCut = useStore((s) => s.setTimeCut);
  const s = ledger.site;
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
