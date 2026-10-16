/** ⌘K: jump, arrange, color, paste an address, download. */

import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { normalizeAddress } from "../lib/chain";
import { DATA_BASE, type Ledger } from "../lib/data";
import { short } from "../lib/format";
import { useStore } from "../lib/store";
import { prefersReducedMotion, scrollToEl } from "../lib/browser";

/** Opens before the rows have loaded: jumping and arranging work at once,
 *  address matching joins when the ledger arrives. ⌘K / Ctrl+K lives in App. */
export function Palette({ ledger }: { ledger: Ledger | null }) {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const setLayout = useStore((s) => s.setLayout);
  const setColorMode = useStore((s) => s.setColorMode);
  const openDrawer = useStore((s) => s.openDrawer);
  const [q, setQ] = useState("");

  // each opening starts empty
  useEffect(() => { if (!open) setQ(""); }, [open]);

  const go = (hash: string) => { setOpen(false); scrollToEl(hash); };
  const toTop = () => scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  const addr = normalizeAddress(q);
  const matches = ledger && q.length >= 4 && !addr ? [...ledger.byAddress.keys()].filter((a) => a.toLowerCase().includes(q.toLowerCase())).slice(0, 6) : [];
  const lookup = (a: string) => {
    setOpen(false);
    const u = new URL(location.href); u.searchParams.set("a", a); history.replaceState(history.state, "", u);
    dispatchEvent(new CustomEvent("fl:lookup", { detail: a }));
    scrollToEl("#lookup");
  };

  // a modal dialog (focus trapped and returned, page scroll locked, Esc and
  // the scrim close it); on phones it sits at the top, clear of the keyboard
  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      shouldFilter={!addr}
      overlayClassName="fixed inset-0 z-[60] bg-ink/70"
      contentClassName="fixed inset-x-4 top-4 z-[61] mx-auto max-w-[36rem] border border-rule-2 bg-ink sm:top-[12vh]"
    >
        <div className="flex items-center border-b border-rule-2">
          <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Type a command, or paste an address" className="min-w-0 flex-1 border-0 bg-transparent px-4 py-3 text-[14px] outline-none" />
          <button className="mr-2 shrink-0 sm:hidden" onClick={() => setOpen(false)}>Close</button>
        </div>
        <Command.List className="panel max-h-[min(50vh,calc(100dvh-8rem))] overflow-y-auto p-2 text-[13.5px]">
          <Command.Empty className="px-3 py-3 text-paper-3">Nothing matches.</Command.Empty>
          {addr && (
            <Command.Group heading="Address" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-paper-3">
              <Item onSelect={() => lookup(addr)}>Look up <span className="mono">{short(addr, 10, 6)}</span>{!ledger ? null : ledger.byAddress.has(addr) ? <span className="ml-2 text-paper-3">{ledger.byAddress.get(addr)!.length} event(s)</span> : <span className="ml-2 text-paper-3">not in ledger</span>}</Item>
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
            <Item onSelect={() => { setLayout("timeline"); setOpen(false); toTop(); }}>Timeline</Item>
            <Item onSelect={() => { setLayout("entities"); setOpen(false); toTop(); }}>By record</Item>
            <Item onSelect={() => { setColorMode("chain"); setOpen(false); }}>Color by chain</Item>
            <Item onSelect={() => { setColorMode("action"); setOpen(false); }}>Color by outcome</Item>
            <Item onSelect={() => { setColorMode("record"); setOpen(false); }}>Color by public record</Item>
          </Command.Group>
          <Command.Group heading="Data" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-paper-3">
            <Item onSelect={() => { location.href = DATA_BASE + "freeze_events.csv"; }}>Download freeze_events.csv</Item>
            <Item onSelect={() => { location.href = DATA_BASE + "attributions.csv"; }}>Download attributions.csv</Item>
            <Item onSelect={() => { window.open("https://github.com/jakeperc/freeze-ledger", "_blank"); }}>Open the repository</Item>
            {ledger && <Item onSelect={() => { setOpen(false); const s = ledger.site; let i = s.n - 1; while (i > 0 && s.internal[i]) i--; openDrawer({ kind: "event", index: i }); }}>Show the newest receipt</Item>}
          </Command.Group>
        </Command.List>
    </Command.Dialog>
  );
}

function Item({ children, onSelect, value }: { children: React.ReactNode; onSelect: () => void; value?: string }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="cursor-pointer rounded px-3 py-2 data-[selected=true]:bg-ink-2 data-[selected=true]:text-paper">
      {children}
    </Command.Item>
  );
}
