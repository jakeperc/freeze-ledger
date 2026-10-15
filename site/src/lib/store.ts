import { create } from "zustand";
import type { Ledger } from "./data";

export type Layout = "timeline" | "entities" | "chains";
export type ColorMode = "chain" | "action" | "record";

export interface Drawer {
  kind: "event" | "address";
  index?: number; // event index for kind=event
  address?: string; // for kind=address
}

interface State {
  ledger: Ledger | null;
  setLedger: (l: Ledger) => void;
  layout: Layout;
  setLayout: (l: Layout) => void;
  colorMode: ColorMode;
  setColorMode: (c: ColorMode) => void;
  hovered: number | null;
  setHovered: (i: number | null) => void;
  drawer: Drawer | null;
  openDrawer: (d: Drawer | null) => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  /** chapter index currently in view over the scene; -1 when the scene is out of view */
  chapter: number;
  setChapter: (c: number) => void;
  reducedMotion: boolean;
  /** 0..1 share of the time span shown by the scrubber; 1 = everything */
  timeCut: number;
  setTimeCut: (v: number) => void;
}

/** Wide landscape screens float the chapters over the field; everything else
 *  stacks the field above them. Matches the `wide:` variant in styles.css. */
export const WIDE_QUERY = "(min-width: 768px) and (orientation: landscape)";
export const isWide = () => typeof matchMedia !== "undefined" && matchMedia(WIDE_QUERY).matches;
/** Right edge of the chapter text column in CSS px when it floats over the field
 *  (34rem of text plus the 2rem gutter, with a little air). */
export const TEXT_COLUMN_PX = 600;

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const initialLayout = (["timeline", "entities", "chains"].includes(params.get("hero") ?? "") ? params.get("hero") : "timeline") as Layout;

export const useStore = create<State>((set) => ({
  ledger: null,
  setLedger: (ledger) => set({ ledger }),
  layout: initialLayout,
  setLayout: (layout) => set({ layout }),
  colorMode: "chain",
  setColorMode: (colorMode) => set({ colorMode }),
  hovered: null,
  setHovered: (hovered) => set({ hovered }),
  drawer: null,
  openDrawer: (drawer) => set({ drawer }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  chapter: 0,
  setChapter: (chapter) => set({ chapter }),
  reducedMotion: typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  timeCut: 1,
  setTimeCut: (timeCut) => set({ timeCut }),
}));
