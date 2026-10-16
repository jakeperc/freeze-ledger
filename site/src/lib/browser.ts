/** Small browser helpers shared across sections: clipboard, downloads,
 *  scrolling that respects reduced motion, and media queries as state. */

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

/** Copy text to the clipboard. Falls back to a hidden textarea where the
 *  async clipboard is missing or refused; never throws. */
export async function copyText(s: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Save a generated file. The object URL is revoked a minute later, not
 *  straight after the click: Safari and Firefox start the download
 *  asynchronously and fail on a URL that is already gone. */
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

export const prefersReducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Scroll an element (or the first match of a selector) into view, smoothly
 *  unless the visitor asked for reduced motion. */
export function scrollToEl(target: string | Element | null, block: ScrollLogicalPosition = "start") {
  const el = typeof target === "string" ? document.querySelector(target) : target;
  el?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block });
}

/** The rendered width of an element, kept current. Charts draw at this width
 *  so their 10px text stays 10px on a phone instead of shrinking with a
 *  fixed viewBox. Never below `min`. */
export function useWidth<T extends HTMLElement>(initial: number, min = 280): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (v: number) => setW(Math.max(min, Math.round(v)));
    set(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => set(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w];
}

/** A media query as React state, kept current as the window changes. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}
