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
  labels: { text: string; sub?: string; weight?: number; x: number; y: number; r?: number }[];
  ticks: { text: string; x: number; y: number }[];
  hover: { x: number; y: number } | null;
}

/** Projects layout labels, time ticks and the hovered point into screen
 *  space a few times a second, so the DOM overlay can sit on the picture. */
function Projector({ layouts, onProject }: { layouts: Record<string, LayoutResult> | null; onProject: (p: Projected) => void }) {
  const { camera, size } = useThree();
  const layout = useStore((s) => s.layout);
  const hovered = useStore((s) => s.hovered);
  const ledger = useStore((s) => s.ledger);
  const frame = useRef(0);
  const v = useMemo(() => new THREE.Vector3(), []);
  const rotated = size.width < size.height;
  const project = (x: number, y: number, z = 0) => {
    if (rotated) [x, y] = [y, -x]; // the rig turns the field a quarter turn on portrait screens
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
      return { text: l.text, sub: l.sub, weight: l.weight, ...p, r: edge ? Math.hypot(edge.x - p.x, edge.y - p.y) : undefined };
    });
    const ticks: Projected["ticks"] = [];
    if (layout === "timeline") {
      const y0 = new Date(L.tMin * 1000).getUTCFullYear(), y1 = new Date(L.tMax * 1000).getUTCFullYear();
      for (let y = y0 + 1; y <= y1; y++) {
        const t = Date.UTC(y, 0, 1) / 1000;
        const x = -SCENE_W / 2 + 1.2 + ((t - L.tMin) / (L.tMax - L.tMin)) * (SCENE_W - 1.8);
        ticks.push({ text: String(y), ...project(x, SCENE_H / 2 + 0.62, 0) });
      }
    }
    let hover: Projected["hover"] = null;
    if (hovered !== null && ledger) {
      const p = L.positions;
      hover = project(p[hovered * 3], p[hovered * 3 + 1], p[hovered * 3 + 2]);
    }
    onProject({ labels, ticks, hover });
  });
  return null;
}

/** Frame the whole field whatever the aspect ratio: fit the scene width on
 *  wide screens and the scene height on narrow ones. */
function Framing() {
  const { camera, size } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.width / size.height;
    const halfFov = (cam.fov * Math.PI) / 360;
    const rotated = aspect < 1;
    const w = rotated ? SCENE_H : SCENE_W, h = rotated ? SCENE_W : SCENE_H;
    const zForWidth = (w / 2 + 0.8) / (Math.tan(halfFov) * aspect);
    const zForHeight = (h / 2 + 1.0) / Math.tan(halfFov);
    cam.position.z = Math.max(zForWidth, zForHeight);
    cam.updateProjectionMatrix();
  }, [camera, size]);
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
  const { size } = useThree();
  useFrame((_, dt) => {
    const g = group.current;
    const k = Math.min(1, dt * 3);
    g.rotation.y += (target.current.x * 0.05 - g.rotation.y) * k;
    g.rotation.x += (-target.current.y * 0.035 - g.rotation.x) * k;
    g.rotation.z = size.width < size.height ? -Math.PI / 2 : 0;
  });
  return <group ref={group}>{children}</group>;
}

type Box = { x: number; y: number; w: number; h: number };
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
function placeLabels(labels: Projected["labels"], layout: string, container: HTMLElement | null): { l: Projected["labels"][number]; box: Box }[] {
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
    const w = textWidth(l.text, 12, false) + 8 + (l.sub ? textWidth(l.sub, 10.5, true) + 8 : 0), h = 23;
    const r = l.r ?? 0, gap = 4;
    const candidates: Box[] = l.r
      ? [
          { x: l.x - w / 2, y: l.y - r - gap - h, w, h },
          { x: l.x - w / 2, y: l.y + r + gap, w, h },
          { x: l.x + r + gap, y: l.y - h / 2, w, h },
          { x: l.x - r - gap - w, y: l.y - h / 2, w, h },
        ]
      : [layout === "timeline" ? { x: l.x - w, y: l.y - h, w, h } : { x: l.x, y: l.y - h, w, h }];
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
  const [proj, setProj] = useState<Projected>({ labels: [], ticks: [], hover: null });
  const onReady = useCallback((h: FieldHandle) => setLayouts(h.layouts), []);
  const hovered = useStore((s) => s.hovered);
  const layout = useStore((s) => s.layout);
  const overlay = useRef<HTMLDivElement>(null);
  const labels = placeLabels(proj.labels, layout, overlay.current);

  return (
    <div className="absolute inset-0" aria-hidden="false">
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [0, 0, 14.5], fov: 48, near: 0.1, far: 100 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        onCreated={({ raycaster }) => { raycaster.params.Points = { threshold: 0.14 }; }}
        style={{ position: "absolute", inset: 0 }}
      >
        <Framing />
        <Rig>
          <Field site={site} onReady={onReady} />
        </Rig>
        <Projector layouts={layouts} onProject={setProj} />
      </Canvas>

      {/* labels (hidden on portrait screens, where the field is turned and small) */}
      <div ref={overlay} className="pointer-events-none absolute inset-0 hidden select-none md:block">
        {labels.map(({ l, box }) => (
          <div
            key={layout + l.text}
            className="absolute whitespace-nowrap"
            style={{ left: box.x, top: box.y, width: box.w, textAlign: layout === "timeline" ? "right" : "left" }}
          >
            <div className="inline-block bg-ink/70 px-1 text-[12px] leading-tight text-paper-2">{l.text}</div>
            {l.sub && <div className="mono inline-block bg-ink/70 px-1 text-[10.5px] text-paper-3">{l.sub}</div>}
          </div>
        ))}
        {proj.ticks.map((t) => (
          <div key={t.text} className="mono absolute text-[10.5px] text-paper-3" style={{ left: t.x, top: t.y, transform: "translate(-50%, 0)" }}>
            {t.text}
          </div>
        ))}
        {hovered !== null && proj.hover && site && <Tooltip site={site} index={hovered} x={proj.hover.x} y={proj.hover.y} />}
      </div>
    </div>
  );
}
