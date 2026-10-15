/** The field: every public event is one point. Points morph between the
 *  three layouts with a per-point delay so the picture folds rather than
 *  snaps, and recolor the same way. Hover and click go through the store so
 *  the DOM (tooltip, drawer) stays in React. */

import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { SiteJson } from "../lib/data";
import { computeColors, computeLayouts, type LayoutResult } from "../lib/layouts";
import { useStore, type ColorMode, type Layout } from "../lib/store";

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
  varying vec3 vColor;
  varying float vAlpha;
  varying float vHot;
  float ease(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0; }
  void main() {
    float t = ease(clamp((uProgress - aDelay * 0.45) / 0.55, 0.0, 1.0));
    vec3 p = mix(aFrom, aTo, t);
    p.z += sin(t * 3.14159) * 1.4;              // lift while travelling
    p.y += sin(uTime * 0.6 + aDelay * 12.0) * 0.012; // barely-there breathing
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
  const { gl, size } = useThree();
  const narrow = size.width < size.height;
  const layout = useStore((s) => s.layout);
  const colorMode = useStore((s) => s.colorMode);
  const hovered = useStore((s) => s.hovered);
  const setHovered = useStore((s) => s.setHovered);
  const openDrawer = useStore((s) => s.openDrawer);
  const reduced = useStore((s) => s.reducedMotion);
  const drawer = useStore((s) => s.drawer);

  const { layouts, colors, geometry, n } = useMemo(() => {
    const layouts = computeLayouts(site, narrow);
    const colors = computeColors(site);
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
      size[i] = act === "destroy" ? 2.4 : act === "unfreeze" ? 1.8 : 2.0;
      if (site.conf[i] === 3) size[i] += 0.5;
      // delay follows time so the fold sweeps across the picture
      delay[i] = (site.t[i] - site.t[0]) / Math.max(1, site.t[n - 1] - site.t[0]);
      hidden[i] = site.internal[i] ? 1 : 0;
    }
    geometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geometry.setAttribute("aDelay", new THREE.BufferAttribute(delay, 1));
    geometry.setAttribute("aHidden", new THREE.BufferAttribute(hidden, 1));
    geometry.computeBoundingSphere();
    return { layouts, colors, geometry, n };
  }, [site, narrow]);

  useEffect(() => { onReady?.({ layouts }); }, [layouts, onReady]);

  const uniforms = useMemo(
    () => ({
      uProgress: { value: 1 },
      uPixelRatio: { value: Math.min(gl.getPixelRatio(), 2) },
      uTime: { value: 0 },
      uHover: { value: -1 },
      uDim: { value: 0 },
      uCut: { value: 1.01 },
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

  useEffect(() => {
    if (state.current.layout === layout && state.current.colorMode === colorMode) return;
    state.current.layout = layout;
    state.current.colorMode = colorMode;
    morph(layout, colorMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, colorMode]);

  useFrame((_, dt) => {
    uniforms.uTime.value += dt;
    uniforms.uHover.value = hovered ?? -1;
    uniforms.uCut.value += ((cut >= 1 ? 1.01 : cut) - uniforms.uCut.value) * Math.min(1, dt * 10);
    const wantDim = drawer?.kind === "address" ? 1 : 0;
    uniforms.uDim.value += (wantDim - uniforms.uDim.value) * Math.min(1, dt * 6);
  });

  // --- pointer -------------------------------------------------------------
  const lastHover = useRef<number | null>(null);
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (uniforms.uProgress.value < 0.98) return;
    const idx = e.index ?? null;
    if (idx !== null && site.internal[idx]) return;
    if (idx !== lastHover.current) { lastHover.current = idx; setHovered(idx); }
  };
  const onOut = () => { lastHover.current = null; setHovered(null); };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.index === undefined || site.internal[e.index]) return;
    e.stopPropagation();
    openDrawer({ kind: "event", index: e.index });
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
