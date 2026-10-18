/** Three ways to place the same events. Every layout returns one position
 *  per event index, so a particle keeps its identity when the layout changes
 *  and the scene can morph between them.
 *
 *  Scene units: the camera frames roughly x ∈ [-11, 11], y ∈ [-6, 6].
 */

import { hierarchy, pack } from "d3-hierarchy";
import { scaleLinear } from "d3-scale";
import type { SiteJson } from "./data";
import { ACTION_COLOR, CHAIN_COLOR, NONE_COLOR, RECORD_COLOR } from "./data";

export const SCENE_W = 22;
export const SCENE_H = 11;

/** deterministic per-index noise in [0,1) */
function hash(i: number, salt: number) {
  let x = (i + 1) * 374761393 + salt * 668265263;
  x = (x ^ (x >>> 13)) * 1274126177;
  x = x ^ (x >>> 16);
  return ((x >>> 0) % 100000) / 100000;
}

/** lanes are chain+token pairs in a fixed order so the picture is stable
 *  as chains come online; empty lanes still exist (and are labelled empty). */
export const LANES: { chain: string; token: string; label: string }[] = [
  { chain: "ethereum", token: "USDT", label: "Ethereum USDT" },
  { chain: "ethereum", token: "USDC", label: "Ethereum USDC" },
  { chain: "base", token: "USDC", label: "Base USDC" },
  { chain: "tron", token: "USDT", label: "Tron USDT" },
  { chain: "solana", token: "USDC", label: "Solana USDC" },
  { chain: "solana", token: "USDT", label: "Solana USDT" },
];

export function laneOf(site: SiteJson, i: number) {
  const chain = site.chains[site.c[i]], token = site.tokens[site.k[i]];
  return LANES.findIndex((l) => l.chain === chain && l.token === token);
}

export interface LayoutResult {
  positions: Float32Array; // xyz per event
  /** `weight` ranks labels when they collide on screen (higher is kept); with
   *  `r`, (x, y) is the centre of a cluster of that radius and the label is
   *  placed beside it wherever it covers no other cluster; `top` and `left`
   *  are a lane's upper-left corner, which compact labels hang from, clear of
   *  the dense recent end of the lane */
  labels: { text: string; x: number; y: number; sub?: string; weight?: number; r?: number; top?: number; left?: number }[];
  /** time scale used by the timeline layout, for axis ticks */
  tMin: number;
  tMax: number;
  /** hairlines between timeline lanes: y in scene units, spanning x0..x1 */
  rules?: { y: number; x0: number; x1: number }[];
}

export function timelineLayout(site: SiteJson): LayoutResult {
  const n = site.n;
  const pos = new Float32Array(n * 3);
  const tMin = site.t[0], tMax = site.t[n - 1];
  const x = scaleLinear().domain([tMin, tMax]).range([-SCENE_W / 2 + 1.2, SCENE_W / 2 - 0.6]);
  const counts = LANES.map((_, li) => countLane(site, li));
  // lane height grows with the square root of its events, with a floor, so
  // Tron's eleven thousand do not crush Solana's thirty out of sight
  const most = Math.max(1, ...counts);
  const weights = counts.map((c) => (c ? 0.45 + 0.55 * Math.sqrt(c / most) : 0.22));
  const total = weights.reduce((a, b) => a + b, 0);
  const laneTop: number[] = [], laneH: number[] = [];
  let yCursor = SCENE_H / 2;
  weights.forEach((w) => { const h = (SCENE_H * w) / total; laneTop.push(yCursor); laneH.push(h); yCursor -= h; });
  const laneY = (l: number) => laneTop[l] - laneH[l] / 2;
  for (let i = 0; i < n; i++) {
    const l = laneOf(site, i);
    const jy = (hash(i, 1) - 0.5) * laneH[l] * 0.72;
    pos[i * 3] = x(site.t[i]);
    pos[i * 3 + 1] = laneY(l) + jy;
    pos[i * 3 + 2] = (hash(i, 2) - 0.5) * 1.2;
  }
  const labels = LANES.map((l, li) => {
    const count = counts[li];
    return { text: l.label, x: SCENE_W / 2 - 0.6, y: laneTop[li] - 0.3, top: laneTop[li], left: -SCENE_W / 2 + 1.0, sub: count ? `${count.toLocaleString()} events` : "no events indexed" };
  });
  const rules = laneTop.slice(1).map((y) => ({ y, x0: -SCENE_W / 2 + 1.0, x1: SCENE_W / 2 - 0.4 }));
  return { positions: pos, labels, tMin, tMax, rules };
}

function countLane(site: SiteJson, li: number) {
  let c = 0;
  for (let i = 0; i < site.n; i++) if (laneOf(site, i) === li) c++;
  return c;
}

/** Circle-packed clusters: one cluster per public-record entity, and one
 *  large cluster for every frozen address with no record. Each address is
 *  packed once; its events share the address's spot with a small spread so
 *  the cluster sizes read as *addresses*, which is what attribution counts. */
export function entitiesLayout(site: SiteJson, textRight: number | null = null): LayoutResult {
  const n = site.n;
  const pos = new Float32Array(n * 3);
  // first index per (chain, address)
  const addrKey = (i: number) => `${site.c[i]}|${site.aid[i]}`;
  const groups = new Map<number, Map<string, number[]>>(); // ent -> addrKey -> indices
  // addresses that only ever appear as released (their freeze predates coverage) get their own group
  const RELEASED_ONLY = -2;
  const everFrozen = new Set<string>();
  for (let i = 0; i < n; i++) if (site.actions[site.a[i]] !== "unfreeze") everFrozen.add(addrKey(i));
  for (let i = 0; i < n; i++) {
    if (site.internal[i]) continue;
    const e = site.ent[i] === -1 && !everFrozen.has(addrKey(i)) ? RELEASED_ONLY : site.ent[i];
    let g = groups.get(e);
    if (!g) groups.set(e, (g = new Map()));
    const k = addrKey(i);
    const list = g.get(k) ?? [];
    list.push(i);
    g.set(k, list);
  }
  const children = [...groups.entries()]
    .sort((a, b) => (a[0] < 0 ? 1 : b[0] < 0 ? -1 : b[1].size - a[1].size))
    .map(([ent, m]) => ({ name: ent === -1 ? "No public record found" : ent === RELEASED_ONLY ? "Released; freeze predates coverage" : site.entities[ent].name, ent, children: [...m.entries()].map(([k, idx]) => ({ name: k, idx, value: 1 })) }));
  const root = hierarchy<any>({ name: "root", children }).sum((d) => d.value ?? 0);
  // packed to the right of the text column when it floats over the field
  const [x0, x1] = fieldSpan(textRight);
  const W = x1 - x0, H = SCENE_H - 0.6, OX = (x0 + x1) / 2;
  const packed = pack<any>().size([W, H]).padding((d) => (d.depth === 0 ? 0.6 : 0.012))(root);
  const labels: LayoutResult["labels"] = [];
  for (const g of packed.children ?? []) {
    const addrs = g.children?.length ?? 0;
    labels.push({ text: g.data.name, x: g.x - W / 2 + OX, y: g.y - H / 2, r: g.r, sub: `${addrs.toLocaleString()} address${addrs === 1 ? "" : "es"}`, weight: addrs });
    for (const leaf of g.children ?? []) {
      const idx: number[] = leaf.data.idx;
      idx.forEach((i, j) => {
        const spread = idx.length > 1 ? 0.05 : 0;
        pos[i * 3] = leaf.x - W / 2 + OX + (hash(i, 3) - 0.5) * spread + j * 0.005;
        pos[i * 3 + 1] = leaf.y - H / 2 + (hash(i, 4) - 0.5) * spread;
        pos[i * 3 + 2] = (hash(i, 5) - 0.5) * 0.4 + j * 0.02;
      });
    }
  }
  for (let i = 0; i < n; i++) if (site.internal[i]) { pos[i * 3] = 0; pos[i * 3 + 1] = -SCENE_H; pos[i * 3 + 2] = -5; }
  return { positions: pos, labels, tMin: site.t[0], tMax: site.t[n - 1] };
}

/** Horizontal span, in scene units, left for a layout that should not sit
 *  under the chapter text: right of `textRight` when the text floats over the
 *  field, the whole width otherwise. */
function fieldSpan(textRight: number | null): [number, number] {
  const x1 = SCENE_W / 2 - 0.3;
  if (textRight === null) return [-x1, x1];
  return [Math.min(Math.max(textRight + 0.3, -x1), x1 - 5), x1];
}

/** `textRight`: scene x of the chapter text column's right edge, or null when
 *  the text does not float over the field. */
export function computeLayouts(site: SiteJson, textRight: number | null = null) {
  return { timeline: timelineLayout(site), entities: entitiesLayout(site, textRight) };
}

/** per-event colors for each color mode, as flat rgb */
export function computeColors(site: SiteJson) {
  const n = site.n;
  const toRgb = (hex: string) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
  const chain = new Float32Array(n * 3), action = new Float32Array(n * 3), record = new Float32Array(n * 3);
  const C = Object.fromEntries(Object.entries(CHAIN_COLOR).map(([k, v]) => [k, toRgb(v)]));
  const A = Object.fromEntries(Object.entries(ACTION_COLOR).map(([k, v]) => [k, toRgb(v)]));
  const REC = toRgb(RECORD_COLOR), NONE = toRgb(NONE_COLOR), MOD = toRgb("#d9b35e"), LOW = toRgb("#8c7a4a");
  for (let i = 0; i < n; i++) {
    const c = C[site.chains[site.c[i]]], a = A[site.actions[site.a[i]]];
    const r = site.conf[i] === 3 ? REC : site.conf[i] === 2 ? MOD : site.conf[i] === 1 ? LOW : NONE;
    chain.set(c, i * 3); action.set(a, i * 3); record.set(r, i * 3);
  }
  return { chain, action, record };
}
