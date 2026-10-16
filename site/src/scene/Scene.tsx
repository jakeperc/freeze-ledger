import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { SiteJson } from "../lib/data";
import { SCENE_H, SCENE_W, type LayoutResult } from "../lib/layouts";
import { isWide, TEXT_COLUMN_PX, useStore } from "../lib/store";
import { Field, type FieldHandle } from "./Field";
import { Tooltip } from "./Tooltip";

interface Projected {
  /** screen space; `r` is the on-screen radius of the cluster centred at (x, y) */
  labels: { text: string; sub?: string; weight?: number; x: number; y: number; r?: number; top?: number; left?: number }[];
  ticks: { text: string; x: number; y: number }[];
  /** lane separators on screen: y and the x span */
  rules: { y: number; x0: number; x1: number }[];
  hover: { x: number; y: number } | null;
}

/** Projects layout labels, time ticks and the hovered point into screen
 *  space a few times a second, so the DOM overlay can sit on the picture. */
function Projector({ layouts, onProject }: { layouts: Record<string, LayoutResult> | null; onProject: (p: Projected) => void }) {
  const { camera, size } = useThree();
  const layout = useStore((s) => s.layout);
  const hovered = useStore((s) => s.hovered);
  const frame = useRef(0);
  const v = useMemo(() => new THREE.Vector3(), []);
  const project = (x: number, y: number, z = 0) => {
    v.set(x, y, z).project(camera);
    return { x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height };
  };
  useFrame(() => {
    if (!layouts) return;
    frame.current++;
    if (frame.current % 4 !== 0) return;
    const L = layouts[layout];
    const labels = L.labels.map((l) => {
      const p = project(l.x, l.y, 0);
      const edge = l.r ? project(l.x + l.r, l.y, 0) : null;
      return { text: l.text, sub: l.sub, weight: l.weight, ...p, r: edge ? Math.hypot(edge.x - p.x, edge.y - p.y) : undefined, top: l.top === undefined ? undefined : project(l.x, l.top, 0).y, left: l.left === undefined ? undefined : project(l.left, l.y, 0).x };
    });
    let ticks: Projected["ticks"] = [];
    if (layout === "timeline") {
      const y0 = new Date(L.tMin * 1000).getUTCFullYear(), y1 = new Date(L.tMax * 1000).getUTCFullYear();
      for (let y = y0 + 1; y <= y1; y++) {
        const t = Date.UTC(y, 0, 1) / 1000;
        const x = -SCENE_W / 2 + 1.2 + ((t - L.tMin) / (L.tMax - L.tMin)) * (SCENE_W - 1.8);
        ticks.push({ text: String(y), ...project(x, SCENE_H / 2 + 0.62, 0) });
      }
      // a narrow field labels every other year, always keeping the latest
      if (ticks.length > 1 && ticks[1].x - ticks[0].x < 36) ticks = ticks.filter((_, i) => (ticks.length - 1 - i) % 2 === 0);
    }
    const rules: Projected["rules"] = [];
    if (layout === "timeline") {
      for (const r of L.rules ?? []) {
        const a = project(r.x0, r.y, 0), b = project(r.x1, r.y, 0);
        rules.push({ y: a.y, x0: a.x, x1: b.x });
      }
    }
    let hover: Projected["hover"] = null;
    if (hovered !== null) {
      const p = L.positions;
      hover = project(p[hovered * 3], p[hovered * 3 + 1], p[hovered * 3 + 2]);
    }
    onProject({ labels, ticks, rules, hover });
  });
  return null;
}

/** Frame the whole field whatever the aspect ratio: fit whichever of the
 *  scene's width and height runs out first. The field box is always wider
 *  than tall (styles.css), so the field is never turned. */
function Framing() {
  const { camera, size, raycaster } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.width / size.height;
    const halfFov = (cam.fov * Math.PI) / 360;
    const zForWidth = (SCENE_W / 2 + 0.8) / (Math.tan(halfFov) * aspect);
    const zForHeight = (SCENE_H / 2 + 1.0) / Math.tan(halfFov);
    cam.position.z = Math.max(zForWidth, zForHeight);
    cam.updateProjectionMatrix();
    // a point is picked within ~8 CSS px of the pointer, so a fingertip can
    // hit one on a phone-sized field as easily as a cursor does on a desktop
    const worldPerPx = (2 * cam.position.z * Math.tan(halfFov)) / size.height;
    raycaster.params.Points = { threshold: Math.max(0.14, 8 * worldPerPx) };
  }, [camera, size, raycaster]);
  return null;
}

function Rig({ children }: { children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null!);
  const target = useRef({ x: 0, y: 0 });
  const reduced = useStore((s) => s.reducedMotion);
  useEffect(() => {
    if (reduced) return;
    const onMove = (e: PointerEvent) => {
      target.current.x = (e.clientX / innerWidth - 0.5) * 2;
      target.current.y = (e.clientY / innerHeight - 0.5) * 2;
    };
    addEventListener("pointermove", onMove, { passive: true });
    return () => removeEventListener("pointermove", onMove);
  }, [reduced]);
  useFrame((_, dt) => {
    const g = group.current;
    const k = Math.min(1, dt * 3);
    g.rotation.y += (target.current.x * 0.05 - g.rotation.y) * k;
    g.rotation.x += (-target.current.y * 0.035 - g.rotation.x) * k;
  });
  return <group ref={group}>{children}</group>;
}

type Box = { x: number; y: number; w: number; h: number };
/** Below this field width labels drop their counts and shrink to fit. */
const COMPACT_W = 640;
const LABEL_PX_COMPACT = 10.5;
const overlaps = (a: Box, b: Box, pad = 2) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
/** rough rendered width: Plex Sans ~0.56em, Plex Mono 0.6em, CJK a full em */
function textWidth(s: string, px: number, mono: boolean) {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? px : px * (mono ? 0.6 : 0.56);
  return w;
}

const coversCircle = (b: Box, cx: number, cy: number, r: number) => {
  const dx = Math.max(b.x - cx, 0, cx - (b.x + b.w)), dy = Math.max(b.y - cy, 0, cy - (b.y + b.h));
  return dx * dx + dy * dy < r * r;
};

/** Keep the labels that fit: heaviest first, none on top of another, none
 *  off the field or over the masthead, the controls or the floating text.
 *  A cluster label tries above, below, right and left of its cluster and takes
 *  the first spot that covers no other cluster's points. */
function placeLabels(labels: Projected["labels"], layout: string, container: HTMLElement | null, compact: boolean): { l: Projected["labels"][number]; box: Box }[] {
  if (!container) return [];
  const W = container.clientWidth, H = container.clientHeight;
  const origin = container.getBoundingClientRect();
  const reserved: Box[] = [];
  const pin = container.closest(".scene-pin");
  pin?.querySelectorAll("header, [data-controls]").forEach((el) => {
    const r = el.getBoundingClientRect();
    reserved.push({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
  });
  if (isWide()) reserved.push({ x: 0, y: 0, w: TEXT_COLUMN_PX, h: H });
  const order = labels.map((l, i) => ({ l, i })).sort((a, b) => (b.l.weight ?? Infinity) - (a.l.weight ?? Infinity) || a.i - b.i);
  const clusters = labels.filter((l) => l.r);
  const kept: Box[] = [];
  const out: { l: Projected["labels"][number]; box: Box }[] = [];
  for (const { l } of order) {
    const w = compact ? textWidth(l.text, LABEL_PX_COMPACT, false) + 8 : textWidth(l.text, 12, false) + 8 + (l.sub ? textWidth(l.sub, 10.5, true) + 8 : 0);
    const h = compact ? 15 : 23;
    const r = l.r ?? 0, gap = 4;
    const candidates: Box[] = l.r
      ? [
          { x: l.x - w / 2, y: l.y - r - gap - h, w, h },
          { x: l.x - w / 2, y: l.y + r + gap, w, h },
          { x: l.x + r + gap, y: l.y - h / 2, w, h },
          { x: l.x - r - gap - w, y: l.y - h / 2, w, h },
        ]
      : [layout === "timeline" ? (compact ? { x: l.left!, y: l.top! + 1, w, h } : { x: l.x - w, y: l.y - h, w, h }) : { x: l.x, y: l.y - h, w, h }];
    const box = candidates.find(
      (b) =>
        b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H &&
        !reserved.some((q) => overlaps(b, q, 0)) &&
        !kept.some((k) => overlaps(b, k)) &&
        !clusters.some((c) => c !== l && coversCircle(b, c.x, c.y, c.r! + 2)),
    );
    if (!box) continue;
    kept.push(box);
    out.push({ l, box });
  }
  return out;
}

export function Scene({ site }: { site: SiteJson }) {
  const [layouts, setLayouts] = useState<Record<string, LayoutResult> | null>(null);
  const [proj, setProj] = useState<Projected>({ labels: [], ticks: [], rules: [], hover: null });
  const onReady = useCallback((h: FieldHandle) => setLayouts(h.layouts), []);
  const hovered = useStore((s) => s.hovered);
  const layout = useStore((s) => s.layout);
  const overlay = useRef<HTMLDivElement>(null);
  const compact = (overlay.current?.clientWidth ?? Infinity) < COMPACT_W;
  const labels = placeLabels(proj.labels, layout, overlay.current, compact);

  return (
    <div className="absolute inset-0" aria-hidden="false">
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [0, 0, 14.5], fov: 48, near: 0.1, far: 100 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        style={{ position: "absolute", inset: 0 }}
      >
        <Framing />
        <Rig>
          <Field site={site} onReady={onReady} />
        </Rig>
        <Projector layouts={layouts} onProject={setProj} />
      </Canvas>

      {/* labels; on a narrow field just the names, smaller */}
      <div ref={overlay} className="pointer-events-none absolute inset-0 select-none">
        {labels.map(({ l, box }) => (
          <div
            key={layout + l.text}
            className="absolute whitespace-nowrap"
            style={{ left: box.x, top: box.y, width: box.w, textAlign: layout === "timeline" && !compact ? "right" : "left" }}
          >
            <div className="inline-block bg-ink/70 px-1 leading-tight text-paper-2" style={{ fontSize: compact ? LABEL_PX_COMPACT : 12 }}>{l.text}</div>
            {l.sub && !compact && <div className="mono inline-block bg-ink/70 px-1 text-[10.5px] text-paper-3">{l.sub}</div>}
          </div>
        ))}
        {proj.rules.map((r, i) => (
          <div key={i} className="absolute h-px bg-rule" style={{ left: r.x0, top: r.y, width: Math.max(0, r.x1 - r.x0) }} />
        ))}
        {proj.ticks.map((t) => (
          // a narrow field has little headroom: centre the year in the gap above the lanes
          <div key={t.text} className={`mono absolute text-paper-3 ${compact ? "leading-none" : ""}`} style={{ left: t.x, top: t.y, fontSize: compact ? 9.5 : 10.5, transform: compact ? "translate(-50%, -50%)" : "translate(-50%, 0)" }}>
            {t.text}
          </div>
        ))}
        {hovered !== null && proj.hover && site && <Tooltip site={site} index={hovered} x={proj.hover.x} y={proj.hover.y} />}
      </div>
    </div>
  );
}
