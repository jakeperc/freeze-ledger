import type { SiteJson } from "../lib/data";
import { CONF_LABEL } from "../lib/data";
import { fmtCompactUsd, fmtDateTime, short } from "../lib/format";

export function Tooltip({ site, index, x, y }: { site: SiteJson; index: number; x: number; y: number }) {
  const chain = site.chains[site.c[index]], token = site.tokens[site.k[index]], action = site.actions[site.a[index]];
  const conf = site.conf[index];
  const ent = site.ent[index] >= 0 ? site.entities[site.ent[index]].name : null;
  const flipX = x > innerWidth - 260;
  const flipY = y < 120;
  return (
    <div
      className="absolute z-10 w-[240px] border border-rule-2 bg-ink/95 px-3 py-2 text-[12px] leading-snug backdrop-blur"
      style={{ left: x + (flipX ? -14 : 14), top: y + (flipY ? 14 : -14), transform: `translate(${flipX ? "-100%" : "0"}, ${flipY ? "0" : "-100%"})` }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={`state-${action} font-medium`}>{action === "freeze" ? "Frozen" : action === "unfreeze" ? "Released" : "Destroyed"}</span>
        <span className="mono text-paper-3">{token} · {chain}</span>
      </div>
      <div className="mono mt-1 text-paper">{short(site.addr[index], 10, 6)}</div>
      <div className="mono text-paper-3">{fmtDateTime(site.t[index])}</div>
      {site.amt[index] !== null && <div className="mono text-ember">{fmtCompactUsd(site.amt[index])} zeroed</div>}
      <div className={`mt-1 ${conf ? "record" : "text-paper-3"}`}>{conf ? `${ent} · ${CONF_LABEL[conf]} confidence` : "No public record found"}</div>
      <div className="mt-1 text-paper-3">Click for the receipt</div>
    </div>
  );
}
