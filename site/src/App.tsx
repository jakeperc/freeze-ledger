import { useEffect, useState } from "react";
import { loadLedger } from "./lib/data";
import { useStore } from "./lib/store";
import { Hero } from "./sections/Hero";
import { Lookup } from "./sections/Lookup";
import { Method } from "./sections/Method";
import { Patterns } from "./sections/Patterns";
import { Registry } from "./sections/Registry";
import { Screen } from "./sections/Screen";
import { Verification } from "./sections/Verification";
import { Drawer } from "./ui/Drawer";
import { Palette } from "./ui/Palette";

export function App() {
  const ledger = useStore((s) => s.ledger);
  const setLedger = useStore((s) => s.setLedger);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadLedger().then(setLedger).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [setLedger]);
  if (error)
    return (
      <div className="p-8 text-paper-2">
        The ledger's data files did not load ({error}). Run <code className="mono">python -m freeze_ledger export</code> and reload.
      </div>
    );
  if (!ledger) return <div className="p-8 text-paper-3">Loading the ledger…</div>;
  return (
    <main>
      <Hero ledger={ledger} />
      <div className="rule mx-5 md:mx-8" />
      <Lookup ledger={ledger} />
      <div className="rule mx-5 md:mx-8" />
      <Registry ledger={ledger} />
      <div className="rule mx-5 md:mx-8" />
      <Patterns ledger={ledger} />
      <div className="rule mx-5 md:mx-8" />
      <Verification ledger={ledger} />
      <div className="rule mx-5 md:mx-8" />
      <Screen ledger={ledger} />
      <div className="rule mx-5 md:mx-8" />
      <Method ledger={ledger} />
      <Drawer ledger={ledger} />
      <Palette ledger={ledger} />
    </main>
  );
}
