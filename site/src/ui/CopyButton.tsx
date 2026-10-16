import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/browser";

/** A button that copies text and says whether it worked. The result is also
 *  announced through a hidden live region beside it, not on the button. */
export function CopyButton({ text, label, className = "" }: { text: () => string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<number>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const go = async () => {
    const ok = await copyText(text());
    setState(ok ? "ok" : "fail");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), ok ? 1600 : 4000);
  };
  return (
    <>
      <button type="button" onClick={go} className={className}>
        {state === "ok" ? "Copied" : state === "fail" ? "Copy failed, select the text" : label}
      </button>
      <span className="sr-only" aria-live="polite">{state === "ok" ? "Copied to the clipboard" : state === "fail" ? "Copy failed" : ""}</span>
    </>
  );
}
