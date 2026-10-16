/** ⌘K: jump, arrange, color, paste an address, download. */

import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { normalizeAddress } from "../lib/chain";
import { DATA_BASE, type Ledger } from "../lib/data";
import { short } from "../lib/format";
import { useStore } from "../lib/store";

export function Palette({ ledger }: { ledger: Ledger }) {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const setLayout = useStore((s) => s.setLayout);
  const setColorMode = useStore((s) => s.setColorMode);
  const openDrawer = useStore((s) => s.openDrawer);
  const [q, setQ] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(!useStore.getState().paletteOpen); }
      if (e.key === "Escape") setOpen(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [setOpen]);

  const go = (hash: string) => { setOpen(false); document.querySelector(hash)?.scrollIntoView({ behavior: "smooth" }); };
  const addr = normalizeAddress(q);
  const matches = q.length >= 4 && !addr ? [...ledger.byAddress.keys()].filter((a) => a.toLowerCase().includes(q.toLowerCase())).slice(0, 6) : [];
  const lookup = (a: string) => {
    setOpen(false);
    const u = new URL(location.href); u.searchParams.set("a", a); history.replaceState(null, "", u);
    dispatchEvent(new CustomEvent("fl:lookup", { detail: a }));
    document.querySelector("#lookup")?.scrollIntoView({ behavior: "smooth" });
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-ink/70 px-4 pt-[12vh]" onClick={() => setOpen(false)}>
      <Command label="Command palette" className="w-full max-w-[36rem] border border-rule-2 bg-ink" onClick={(e) => e.stopPropagation()} shouldFilter={!addr}>
        <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Type a command, or paste an address" className="w-full border-0 border-b border-rule-2 bg-transparent px-4 py-3 text-[14px] outline-none" />
        <Command.List className="panel max-h-[50vh] overflow-y-auto p-2 text-[13.5px]">
          <Command.Empty className="px-3 py-3 text-paper-3">Nothing matches.</Command.Empty>
          {addr && (
            <Command.Group heading="Address" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-paper-3">
              <Item onSelect={() => lookup(addr)}>Look up <span className="mono">{short(addr, 10, 6)}</span>{ledger.byAddress.has(addr) ? <span className="ml-2 text-paper-3">{ledger.byAddress.get(addr)!.length} event(s)</span> : <span className="ml-2 text-paper-3">not in ledger</span>}</Item>
            </Command.Group>
          )}
          {matches.length > 0 && (
            <Command.Group heading="Addresses in the ledger" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-paper-3">
              {matches.map((a) => <Item key={a} value={a} onSelect={() => lookup(a)}><span className="mono">{short(a, 12, 8)}</span></Item>)}
            </Command.Group>
          )}
          <Command.Group heading="Go to" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-paper-3">
            <Item onSelect={() => go("#lookup")}>Look up an address</Item>
            <Item onSelect={() => go("#registry")}>Registry</Item>
            <Item onSelect={() => go("#patterns")}>Patterns</Item>
            <Item onSelect={() => go("#verification")}>Verification</Item>
            <Item onSelect={() => go("#screen")}>Screen a list</Item>
            <Item onSelect={() => go("#method")}>Method and downloads</Item>
          </Command.Group>
          <Command.Group heading="Arrange the field" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-paper-3">
            <Item onSelect={() => { setLayout("timeline"); setOpen(false); scrollTo({ top: 0, behavior: "smooth" }); }}>Timeline</Item>
            <Item onSelect={() => { setLayout("entities"); setOpen(false); scrollTo({ top: 0, behavior: "smooth" }); }}>By record</Item>
            <Item onSelect={() => { setColorMode("chain"); setOpen(false); }}>Color by chain</Item>
            <Item onSelect={() => { setColorMode("action"); setOpen(false); }}>Color by outcome</Item>
            <Item onSelect={() => { setColorMode("record"); setOpen(false); }}>Color by public record</Item>
          </Command.Group>
          <Command.Group heading="Data" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-paper-3">
            <Item onSelect={() => { location.href = DATA_BASE + "freeze_events.csv"; }}>Download freeze_events.csv</Item>
            <Item onSelect={() => { location.href = DATA_BASE + "attributions.csv"; }}>Download attributions.csv</Item>
            <Item onSelect={() => { window.open("https://github.com/jakeperc/freeze-ledger", "_blank"); }}>Open the repository</Item>
            <Item onSelect={() => { setOpen(false); const s = ledger.site; let i = s.n - 1; while (i > 0 && s.internal[i]) i--; openDrawer({ kind: "event", index: i }); }}>Show the newest receipt</Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

function Item({ children, onSelect, value }: { children: React.ReactNode; onSelect: () => void; value?: string }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="cursor-pointer rounded px-3 py-2 data-[selected=true]:bg-ink-2 data-[selected=true]:text-paper">
      {children}
    </Command.Item>
  );
}
