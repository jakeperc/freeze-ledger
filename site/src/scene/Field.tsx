/** The field: every public event is one point. Points morph between the
 *  three layouts with a per-point delay so the picture folds rather than
 *  snaps, and recolor the same way. Hover and click go through the store so
 *  the DOM (tooltip, drawer) stays in React. */

import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { SiteJson } from "../lib/data";
import { computeColors, computeLayouts, SCENE_H, SCENE_W, type LayoutResult } from "../lib/layouts";
import { isWide, TEXT_COLUMN_PX, useStore, type ColorMode, type Layout } from "../lib/store";

const vert = /* glsl */ `
  attribute vec3 aFrom;
  attribute vec3 aTo;
  attribute vec3 aColorFrom;
  attribute vec3 aColorTo;
  attribute float aSize;
  attribute float aDelay;
  attribute float aHidden;
  uniform float uProgress;
  uniform float uPixelRatio;
  uniform float uTime;
  uniform float uHover;
  uniform float uDim;
  uniform float uCut;
  uniform float uBreath;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vHot;
  float ease(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0; }
  void main() {
    float t = ease(clamp((uProgress - aDelay * 0.45) / 0.55, 0.0, 1.0));
    vec3 p = mix(aFrom, aTo, t);
    p.z += sin(t * 3.14159) * 1.4;              // lift while travelling
    p.y += sin(uTime * 0.6 + aDelay * 12.0) * 0.012 * uBreath; // barely-there breathing, off under reduced motion
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float hot = float(gl_VertexID) == uHover ? 1.0 : 0.0;
    vHot = hot;
    float size = aSize * (1.0 + hot * 1.6);
    gl_PointSize = size * uPixelRatio * (36.0 / -mv.z);
    vColor = mix(aColorFrom, aColorTo, t);
    float cut = aDelay > uCut ? 0.0 : 1.0;             // the time scrubber hides later events
    vAlpha = (1.0 - aHidden) * cut * mix(1.0, 0.25, uDim * (1.0 - hot));
  }
`;

const frag = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vHot;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float edge = smoothstep(0.5, 0.32, d);
    float core = smoothstep(0.28, 0.0, d) * 0.55;
    vec3 col = vColor + core * (0.35 + vHot * 0.4);
    gl_FragColor = vec4(col, (edge * 0.92 + core) * vAlpha);
  }
`;

export interface FieldHandle {
  layouts: Record<Layout, LayoutResult>;
}

export function Field({ site, onReady }: { site: SiteJson; onReady?: (h: FieldHandle) => void }) {
  const pointsRef = useRef<THREE.Points>(null!);
  const matRef = useRef<THREE.ShaderMaterial>(null!);
  const { gl, size, camera } = useThree();
  const wide = isWide();
  // Where the floating chapter text ends, in scene units at z=0, so layouts that
  // can move (clusters, rings) sit beside it. Mirrors the camera fit in Scene's
  // Framing; rounded so a window resize does not recompute every pixel.
  const textRight = useMemo(() => {
    if (!wide) return null;
    const aspect = size.width / size.height;
    const tan = Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360);
    const z = Math.max((SCENE_W / 2 + 0.8) / (tan * aspect), (SCENE_H / 2 + 1.0) / tan);
    const halfW = z * tan * aspect;
    return Math.round((-halfW + (2 * halfW * TEXT_COLUMN_PX) / size.width) * 4) / 4;
  }, [wide, size.width, size.height, camera]);
  const layout = useStore((s) => s.layout);
  const colorMode = useStore((s) => s.colorMode);
  const hovered = useStore((s) => s.hovered);
  const setHovered = useStore((s) => s.setHovered);
  const openDrawer = useStore((s) => s.openDrawer);
  const reduced = useStore((s) => s.reducedMotion);
  const drawer = useStore((s) => s.drawer);

  const layouts = useMemo(() => computeLayouts(site, textRight), [site, textRight]);
  const colors = useMemo(() => computeColors(site), [site]);
  // built once per dataset; later layout changes morph the existing points
  const { geometry, n } = useMemo(() => {
    const n = site.n;
    const geometry = new THREE.BufferGeometry();
    const initial = layouts[useStore.getState().layout].positions;
    const initialColor = colors[useStore.getState().colorMode];
    // the one page-load moment: points arrive from an unsorted scatter into the first arrangement
    const scatter = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      scatter[i * 3] = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 30 - 15;
      scatter[i * 3 + 1] = (Math.sin(i * 78.233) * 43758.5453 % 1) * 16 - 8;
      scatter[i * 3 + 2] = (Math.sin(i * 39.425) * 43758.5453 % 1) * 10 - 12;
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(initial.slice(), 3));
    geometry.setAttribute("aFrom", new THREE.BufferAttribute(scatter, 3));
    geometry.setAttribute("aTo", new THREE.BufferAttribute(initial.slice(), 3));
    geometry.setAttribute("aColorFrom", new THREE.BufferAttribute(initialColor.slice(), 3));
    geometry.setAttribute("aColorTo", new THREE.BufferAttribute(initialColor.slice(), 3));
    const size = new Float32Array(n), delay = new Float32Array(n), hidden = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const act = site.actions[site.a[i]];
      // a destroyed balance is sized by its amount: $1k is a plain point, $87M about twice as wide
      const amt = site.amt[i];
      size[i] = act === "destroy" ? 1.9 + (amt && amt > 1000 ? 0.42 * Math.log10(amt / 1000) : 0) : act === "unfreeze" ? 1.8 : 2.0;
      if (site.conf[i] === 3) size[i] += 0.5;
      // delay follows time so the fold sweeps across the picture
      delay[i] = (site.t[i] - site.t[0]) / Math.max(1, site.t[n - 1] - site.t[0]);
      hidden[i] = site.internal[i] ? 1 : 0;
    }
    geometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geometry.setAttribute("aDelay", new THREE.BufferAttribute(delay, 1));
    geometry.setAttribute("aHidden", new THREE.BufferAttribute(hidden, 1));
    geometry.computeBoundingSphere();
    return { geometry, n };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  useEffect(() => { onReady?.({ layouts }); }, [layouts, onReady]);

  const uniforms = useMemo(
    () => ({
      uProgress: { value: 1 },
      uPixelRatio: { value: Math.min(gl.getPixelRatio(), 2) },
      uTime: { value: 0 },
      uHover: { value: -1 },
      uDim: { value: 0 },
      uCut: { value: 1.01 },
      uBreath: { value: 1 },
    }),
    [gl],
  );
  const cut = useStore((s) => s.timeCut);

  // page-load reveal
  useEffect(() => {
    uniforms.uProgress.value = reduced ? 1 : 0;
    if (!reduced) gsap.to(uniforms.uProgress, { value: 1, duration: 2.4, ease: "none", delay: 0.2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry]);

  // --- morphing ------------------------------------------------------------
  const state = useRef({ layout, colorMode, tween: null as gsap.core.Tween | null });
  const morph = (nextLayout: Layout, nextColor: ColorMode) => {
    const g = geometry;
    const from = g.getAttribute("aFrom") as THREE.BufferAttribute;
    const to = g.getAttribute("aTo") as THREE.BufferAttribute;
    const cFrom = g.getAttribute("aColorFrom") as THREE.BufferAttribute;
    const cTo = g.getAttribute("aColorTo") as THREE.BufferAttribute;
    const delay = g.getAttribute("aDelay") as THREE.BufferAttribute;
    const p = uniforms.uProgress.value;
    // freeze the in-flight picture as the new start
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    for (let i = 0; i < n; i++) {
      const t = ease(Math.min(1, Math.max(0, (p - delay.getX(i) * 0.45) / 0.55)));
      for (let k = 0; k < 3; k++) {
        const a = (from.array as Float32Array)[i * 3 + k], b = (to.array as Float32Array)[i * 3 + k];
        (from.array as Float32Array)[i * 3 + k] = a + (b - a) * t;
        const ca = (cFrom.array as Float32Array)[i * 3 + k], cb = (cTo.array as Float32Array)[i * 3 + k];
        (cFrom.array as Float32Array)[i * 3 + k] = ca + (cb - ca) * t;
      }
    }
    (to.array as Float32Array).set(layouts[nextLayout].positions);
    (cTo.array as Float32Array).set(colors[nextColor]);
    from.needsUpdate = to.needsUpdate = cFrom.needsUpdate = cTo.needsUpdate = true;
    // raycasting reads `position`; point it at the destination
    (g.getAttribute("position") as THREE.BufferAttribute).copyArray(layouts[nextLayout].positions);
    (g.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    g.computeBoundingSphere();
    state.current.tween?.kill();
    uniforms.uProgress.value = 0;
    if (reduced) { uniforms.uProgress.value = 1; return; }
    state.current.tween = gsap.to(uniforms.uProgress, { value: 1, duration: 1.9, ease: "none" });
  };

  // the window changed enough to move the clusters or rings: glide them over
  const builtWith = useRef(layouts);
  useEffect(() => {
    if (builtWith.current === layouts) return;
    builtWith.current = layouts;
    morph(state.current.layout, state.current.colorMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layouts]);

  useEffect(() => {
    if (state.current.layout === layout && state.current.colorMode === colorMode) return;
    state.current.layout = layout;
    state.current.colorMode = colorMode;
    morph(layout, colorMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, colorMode]);

  // under reduced motion the canvas renders on demand: ask for a frame
  // whenever something the picture shows has changed
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => { invalidate(); }, [invalidate, layout, colorMode, hovered, cut, drawer, layouts, reduced]);

  useFrame((_, dt) => {
    uniforms.uTime.value += dt;
    uniforms.uHover.value = hovered ?? -1;
    uniforms.uPixelRatio.value = Math.min(gl.getPixelRatio(), 2); // follows the window across monitors
    uniforms.uBreath.value = reduced ? 0 : 1;
    const wantCut = cut >= 1 ? 1.01 : cut;
    const wantDim = drawer?.kind === "address" ? 1 : 0;
    if (reduced) {
      uniforms.uCut.value = wantCut;
      uniforms.uDim.value = wantDim;
    } else {
      uniforms.uCut.value += (wantCut - uniforms.uCut.value) * Math.min(1, dt * 10);
      uniforms.uDim.value += (wantDim - uniforms.uDim.value) * Math.min(1, dt * 6);
    }
  });

  // --- pointer -------------------------------------------------------------
  const lastHover = useRef<number | null>(null);
  // the hit radius is several pixels (Scene's Framing), so take the point
  // nearest the pointer, not the first one along the ray
  const nearest = (e: ThreeEvent<PointerEvent | MouseEvent>): number | null => {
    let best: number | null = null, bestD = Infinity;
    for (const h of e.intersections) {
      if (h.object !== pointsRef.current || h.index === undefined || site.internal[h.index]) continue;
      const d = h.distanceToRay ?? 0;
      if (d < bestD) { bestD = d; best = h.index; }
    }
    return best;
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (uniforms.uProgress.value < 0.98) return;
    const idx = nearest(e);
    if (idx !== null && site.internal[idx]) return;
    if (idx !== lastHover.current) { lastHover.current = idx; setHovered(idx); }
  };
  const onOut = () => { lastHover.current = null; setHovered(null); };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    // open the point the tooltip is showing; the click's own ray can land on a neighbour
    const index = lastHover.current ?? nearest(e);
    if (index === null || site.internal[index]) return;
    e.stopPropagation();
    openDrawer({ kind: "event", index });
  };

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      onPointerMove={onMove}
      onPointerOut={onOut}
      onClick={onClick}
      frustumCulled={false}
    >
      <shaderMaterial
        ref={matRef}
        vertexShader={vert}
        fragmentShader={frag}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </points>
  );
}
