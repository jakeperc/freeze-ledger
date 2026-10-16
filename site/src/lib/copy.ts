/** Chapter copy is built from latest.json so every sentence carries a number
 *  the verification suite has re-derived. Nothing here is typed by hand
 *  except the sentence frames: what is or is not indexed comes from the
 *  `coverage` block (read from the checkpoints), never from this file. */

import type { Latest, LaneCoverage } from "./data";
import { fmtCompactUsd, fmtDate, fmtInt, fmtPct } from "./format";
import type { ColorMode, Layout } from "./store";

export interface Chapter {
  id: string;
  layout: Layout;
  colorMode: ColorMode;
  figure: string; // the big thing
  figureLabel: string;
  lines: string[]; // supporting sentences, plain
  caveat?: string; // what the number does not cover
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const listWords = (xs: string[]) =>
  xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const monthYear = (d: string) => new Date(d + "T00:00:00Z").toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
export const laneName = (l: Pick<LaneCoverage, "chain" | "token">) => `${cap(l.chain)} ${l.token}`;

/** One sentence on what is not covered yet, or that everything in scope is. */
export function coverageSentence(l: Latest): string {
  const lanes = Object.values(l.coverage ?? {});
  const open = lanes.filter((c) => !c.complete);
  if (!lanes.length) return "";
  if (!open.length) return "Every chain and token in scope is indexed from its first freeze.";
  const parts = open.map((c) => `${laneName(c)}: ${c.note || "not complete"}`);
  const done = lanes.filter((c) => c.complete && c.first).map((c) => `${laneName(c)} from ${fmtDate(c.first!)}`);
  return `${parts.join("; ")}. Indexed from the first freeze: ${listWords(done)}.`;
}

/** The busiest removal date in the SDN extract history, and how many left the list then. */
export function mainDelisting(l: Latest): { date: string; count: number } | null {
  const entries = Object.entries(l.sdn_delisted?.removed_on ?? {}).sort((a, b) => b[1] - a[1]);
  return entries.length ? { date: entries[0][0], count: entries[0][1] } : null;
}

export function buildChapters(l: Latest): Chapter[] {
  const lanes = Object.values(l.coverage ?? {}).filter((c) => c.events > 0);
  const chains = [...new Set(lanes.map((c) => cap(c.chain)))];
  const cov = l.attribution_coverage;
  const tether = l.by_issuer.tether, circle = l.by_issuer.circle;
  const destroyed = Object.values(l.destroyed_usdt_by_chain).reduce((a, b) => a + parseFloat(b), 0);
  const split = l.currently_frozen_split;
  const lag = l.sdn_listing_lag_days ?? {};
  const cEth = lag["circle:ethereum"], tEth = lag["tether:ethereum"], tTron = lag["tether:tron"];
  const delist = mainDelisting(l);
  const delistLanes = Object.values(l.sdn_delisted?.lanes ?? {});
  const releasedAll = delistLanes.length > 0 && delistLanes.every((d) => d.released_after_removal === d.frozen_when_removed);
  const slowest = Math.max(...delistLanes.map((d) => d.median_days_after_removal ?? 0), 0);
  const onList = cov.high + cov.moderate + cov.low;

  const chapters: Chapter[] = [
    {
      id: "frozen-now",
      layout: "timeline",
      colorMode: "action",
      figure: fmtInt(l.currently_frozen_total),
      figureLabel: "addresses are frozen right now",
      lines: [
        split
          ? `${fmtInt(split.balance_held)} still hold dollars they cannot move. On the other ${fmtInt(split.balance_destroyed)}, Tether destroyed the balance and the address stays blacklisted.`
          : "",
        `Tether and Circle froze them on ${listWords(chains)}. Every point in the field is one freeze, release or destroyed balance, read from the chain: ${fmtInt(l.events_public)} so far.`,
      ].filter(Boolean),
      caveat: coverageSentence(l) || undefined,
    },
    {
      id: "destroyed",
      layout: "timeline",
      colorMode: "action",
      figure: fmtCompactUsd(destroyed),
      figureLabel: "in USDT destroyed after a freeze",
      lines: [
        tether ? `Tether has zeroed frozen balances ${fmtInt(tether.destroys)} times and released ${fmtInt(tether.released_addresses)} addresses.` : "",
        circle ? `Circle's contract cannot destroy a balance. It has released ${fmtInt(circle.released_addresses)} of the ${fmtInt(circle.frozen_addresses)} addresses it froze.` : "",
        l.freeze_to_destroy_days?.median !== undefined
          ? `From freeze to destruction the median wait is ${fmtInt(l.freeze_to_destroy_days.median)} days; from freeze to release, ${fmtInt(l.freeze_to_release_days?.median ?? 0)}.`
          : "",
      ].filter(Boolean),
      caveat: "The larger points in orange are the destroyed balances, sized by amount.",
    },
    {
      id: "no-record",
      layout: "entities",
      colorMode: "record",
      figure: fmtPct(cov.unattributed_share, 0),
      figureLabel: "of the addresses ever frozen are named in no public record we can find",
      lines: [
        `That is ${fmtInt(cov.unattributed)} of ${fmtInt(cov.frozen_addresses)} addresses. ${fmtInt(onList)} are on the OFAC sanctions list, or were${delist ? `: ${fmtInt(l.sdn_delisted.removed_addresses)} have since been removed from it` : ""}.`,
        "Tether says most of its freezes follow requests from law enforcement. Circle says it freezes when a court order or sanctions require it. Neither publishes the requests, so no public record names the rest.",
      ],
      caveat: "Attribution reads the OFAC list as it stands and as it stood. DOJ filings and court orders are added by hand and will lower this share.",
    },
    {
      id: "listing-to-freeze",
      layout: "timeline",
      colorMode: "record",
      figure: cEth?.median !== undefined && tEth?.median !== undefined ? `${fmtInt(Math.max(0, cEth.median))} vs ${fmtInt(tEth.median)}` : fmtInt(cov.high),
      figureLabel: "days from an OFAC listing to the freeze on Ethereum, Circle vs Tether (median)",
      lines: [
        cEth ? `Circle froze ${fmtInt(cEth.within_2_days)} of ${fmtInt(cEth.n)} newly listed Ethereum addresses within two days of the listing.` : "",
        tTron
          ? `Tether is slower on Ethereum but not on Tron, where most of its freezes happen. There it froze ${fmtInt(tTron.within_2_days)} of ${fmtInt(tTron.n)} listed addresses within two days, and ${fmtInt(tTron.before_listing)} a week or more before OFAC listed them.`
          : "",
        delist && releasedAll
          ? `When OFAC took ${fmtInt(delist.count)} addresses off the list in ${monthYear(delist.date)}, both issuers released every one they had frozen, within ${fmtInt(slowest)} day${slowest === 1 ? "" : "s"}.`
          : "",
      ].filter(Boolean),
      caveat: "Counted for addresses whose listing date is known to the day (added after September 2022), on chains that were live when they were listed. Lit points match a public record.",
    },
    {
      id: "receipt",
      layout: "timeline",
      colorMode: "chain",
      figure: fmtInt(l.events_total),
      figureLabel: "rows, each with a receipt",
      lines: [
        "Every row names the transaction, the log, and the SHA-256 of the raw response it was decoded from.",
        "Click any point, or any row below, and the page re-derives it from a public node in your browser.",
      ],
    },
  ];
  return chapters;
}
