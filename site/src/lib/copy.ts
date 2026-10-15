/** Chapter copy is built from latest.json so every sentence carries a number
 *  the verification suite has re-derived. Nothing here is typed by hand
 *  except the sentence frames, and each frame says what it is counting. */

import type { Latest } from "./data";
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
const chainsIndexed = (l: Latest) => Object.entries(l.coverage_span).filter(([, s]) => s.events > 0).map(([c]) => cap(c));

export function buildChapters(l: Latest): Chapter[] {
  const chains = chainsIndexed(l);
  const chainWord = chains.length === 1 ? chains[0] : chains.length === 2 ? `${chains[0]} and ${chains[1]}` : `${chains.slice(0, -1).join(", ")} and ${chains.at(-1)}`;
  const cov = l.attribution_coverage;
  const tether = l.by_issuer.tether, circle = l.by_issuer.circle;
  const usdtFreezeSpan = l.coverage_span.ethereum?.detail?.["USDT:freeze"];
  const destroyed = Object.values(l.destroyed_usdt_by_chain).reduce((a, b) => a + parseFloat(b), 0);
  const screening = l.sdn_screening;
  const circleEth = screening["circle:ethereum"], circleBase = screening["circle:base"], tetherEth = screening["tether:ethereum"];

  const chapters: Chapter[] = [
    {
      id: "frozen-now",
      layout: "timeline",
      colorMode: "action",
      figure: fmtInt(l.currently_frozen_total),
      figureLabel: "addresses cannot move their dollars right now",
      lines: [
        `Tether and Circle have frozen them on ${chainWord}, and have not released them.`,
        `Every point in the field is one freeze, release, or destroyed balance, read from the chain: ${fmtInt(l.events_public)} so far.`,
      ],
      caveat: usdtFreezeSpan ? `Ethereum USDT freezes are indexed from ${fmtDate(usdtFreezeSpan.first)}; earlier ones arrive with the full backfill. Tron and Solana are not indexed yet.` : undefined,
    },
    {
      id: "two-instincts",
      layout: "chains",
      colorMode: "action",
      figure: fmtCompactUsd(destroyed),
      figureLabel: "in USDT destroyed after a freeze",
      lines: [
        tether ? `Tether has zeroed frozen balances ${fmtInt(tether.destroys)} times and released ${fmtInt(tether.released_addresses)} addresses.` : "",
        circle ? `Circle cannot destroy a balance; it has released ${fmtInt(circle.released_addresses)} of the ${fmtInt(circle.frozen_addresses)} addresses it froze.` : "",
        l.freeze_to_destroy_days ? `From freeze to destruction the median wait is ${fmtInt(l.freeze_to_destroy_days.median)} days; from freeze to release, ${fmtInt(l.freeze_to_release_days?.median ?? 0)}.` : "",
      ].filter(Boolean),
    },
    {
      id: "no-record",
      layout: "entities",
      colorMode: "record",
      figure: fmtPct(cov.unattributed_share, 0),
      figureLabel: "of frozen addresses match no public record we can find",
      lines: [
        `${fmtInt(cov.unattributed)} of ${fmtInt(cov.frozen_addresses)} frozen addresses have no OFAC listing, court filing, notice or issuer statement attached to them yet.`,
        `${fmtInt(cov.high)} match the OFAC sanctions list exactly. The rest were frozen for reasons that are not public.`,
      ],
      caveat: "Attribution so far uses the OFAC digital-currency address list only; DOJ filings and issuer statements are added by hand and will lower this share.",
    },
    {
      id: "screening",
      layout: "timeline",
      colorMode: "record",
      figure: circleEth !== undefined && tetherEth !== undefined ? `${fmtInt(circleEth)} vs ${fmtInt(tetherEth)}` : fmtInt(cov.high),
      figureLabel: "OFAC-listed addresses frozen by Circle vs Tether on Ethereum",
      lines: [
        circleEth !== undefined && circleBase !== undefined ? `Circle has frozen every one of the ${fmtInt(circleEth)} sanctioned EVM addresses on Ethereum and the same ${fmtInt(circleBase)} on Base.` : "",
        tetherEth !== undefined ? `Tether has frozen ${fmtInt(tetherEth)} of them on Ethereum. One issuer screens the list; the other acts on requests.` : "",
        l.multi_chain_addresses ? `${fmtInt(l.multi_chain_addresses)} addresses are frozen on more than one chain.` : "",
      ].filter(Boolean),
      caveat: "Lit points match a public record. Circle's screening shows as vertical bands: many addresses frozen in the same block.",
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
