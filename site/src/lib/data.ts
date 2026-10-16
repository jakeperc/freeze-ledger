/** Loading the ledger, smallest first. latest.json (the derived views the
 *  page quotes) arrives in a blink and the chapters render from it alone;
 *  site.json (the columns the scene draws) follows; site_ids.json (every
 *  address and transaction hash, most of the bytes) last, and only then do
 *  the lookup, registry and receipts appear. All three are written by
 *  `python -m freeze_ledger export` and checked by verify.py. */

export type Chain = "ethereum" | "base" | "tron" | "solana";
export type Token = "USDT" | "USDC";
export type Action = "freeze" | "unfreeze" | "destroy";

export interface SiteJson {
  v: number;
  n: number;
  chains: Chain[];
  tokens: Token[];
  actions: Action[];
  entities: { name: string; source: string; program: string }[];
  t: number[];
  c: number[];
  k: number[];
  a: number[];
  /** address id per event: index into site_ids.json `addrs` */
  aid: number[];
  /** filled from site_ids.json */
  addr: string[];
  amt: (number | null)[];
  /** filled from site_ids.json */
  tx: string[];
  /** address id -> wallet that owns the frozen Solana token account */
  owner: Record<string, string>;
  li: number[];
  blk: number[];
  conf: number[]; // 0 none, 1 low, 2 moderate, 3 high
  ent: number[]; // -1 none
  internal: number[];
  evid: number[]; // index into evidence, -1 none
  evidence: { id: string; kind: string; locator: string; sha256: string; fetched_at: string; bytes: number }[];
}

export interface Latest {
  generated_at: string;
  events_total: number;
  events_public: number;
  events_issuer_internal: number;
  by_chain_action: Record<string, Record<Action, number>>;
  by_token_action: Record<string, Record<Action, number>>;
  currently_frozen: Record<string, Record<string, number>>;
  currently_frozen_total: number;
  destroyed_usdt_by_chain: Record<string, string>;
  monthly_freezes: ({ month: string } & Record<string, number | string>)[];
  attribution_coverage: { frozen_addresses: number; high: number; moderate: number; low: number; unattributed: number; unattributed_share: number | null };
  attribution_coverage_by_chain: Record<string, { frozen_addresses: number; attributed: number; unattributed: number }>;
  top_programs: [string, number][];
  coverage_span: Record<string, { first: string | null; last: string | null; events: number; detail: Record<string, { first: string; last: string; events: number }> }>;
  by_issuer: Record<string, { events: number; freezes: number; unfreezes: number; destroys: number; frozen_addresses: number; released_addresses: number; currently_frozen: number; attributed_addresses: number; destroyed_total: string }>;
  multi_chain_addresses: number;
  multi_chain_pairs: Record<string, number>;
  freeze_to_destroy_days: Quantiles | null;
  freeze_to_release_days: Quantiles | null;
  sdn_screening: Record<string, number>;
  sdn_listing_lag_days: Record<string, Quantiles & { within_2_days: number; within_7_days: number; before_listing: number; not_frozen: number }>;
  sdn_delisted: {
    removed_addresses: number;
    removed_on: Record<string, number>;
    lanes: Record<string, { frozen_when_removed: number; released_after_removal: number; still_frozen: number; median_days_after_removal: number | null }>;
  };
  currently_frozen_split: { balance_held: number; balance_destroyed: number };
  coverage: Record<string, LaneCoverage>;
  files: Record<string, { sha256: string; rows?: number }>;
  registry: any[];
  checkpoints: Record<string, any>;
}

export interface Quantiles { n: number; p25?: number; median?: number; p75?: number; max?: number }

export interface LaneCoverage { chain: Chain; token: Token; issuer: string; events: number; first: string | null; last: string | null; complete: boolean; note: string }

export interface VerificationReport {
  verified_at: string;
  seed: number;
  offline: boolean;
  events: number;
  failed: number;
  checks: { check: string; status: string; detail: string }[];
}

export interface Ledger {
  site: SiteJson;
  latest: Latest;
  report: VerificationReport | null;
  /** address -> indices of its events, in time order. On Solana the wallet
   *  that owns a frozen token account is indexed too, so pasting the wallet
   *  finds it. */
  byAddress: Map<string, number[]>;
  /** current state per (chain, token, address) key */
  frozenNow: Map<string, boolean>;
  /** attribution rows by `${chain}|${address}` */
  attributions: Map<string, Attribution[]>;
}

export interface Attribution {
  attribution_id: string;
  address: string;
  chain: string;
  source_class: string;
  entity: string;
  program: string;
  record_date: string;
  confidence: "high" | "moderate" | "low";
  basis: string;
  evidence_url: string;
  judged_at: string;
  superseded_by: string;
}

export const DATA_BASE = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");

export function stateKey(chain: string, token: string, address: string) {
  return `${chain}|${token}|${address}`;
}

/** RFC-4180 CSV parser (quoted fields, embedded commas and newlines). */
export function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() ?? [];
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, j) => [h, r[j]])));
}

const getJson = <T,>(name: string) =>
  fetch(DATA_BASE + name).then((r) => {
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  });

/** The derived views: enough for every number in the chapters. */
export const loadLatest = () => getJson<Latest>("latest.json");

/** The columns the scene draws; addresses and hashes arrive later. */
export async function loadSiteCore(): Promise<SiteJson> {
  const core = await getJson<SiteJson>("site.json");
  return { ...core, addr: [], tx: [], owner: {} };
}

type Ids = { addrs: string[]; tx: string[]; owner: Record<string, string> };
let idsPromise: Promise<Ids> | null = null;
/** Start the big download early; loadLedger picks it up. */
export const prefetchIds = () => (idsPromise ??= getJson<Ids>("site_ids.json"));

/** Everything else, merged into the core columns. */
export async function loadLedger(latest: Latest, core: SiteJson): Promise<Ledger> {
  const [ids, report, attrText] = await Promise.all([
    prefetchIds(),
    fetch(DATA_BASE + "verification_report.json").then((r) => (r.ok ? (r.json() as Promise<VerificationReport>) : null)).catch(() => null),
    fetch(DATA_BASE + "attributions.csv").then((r) => (r.ok ? r.text() : "")).catch(() => ""),
  ]);
  const site: SiteJson = { ...core, addr: core.aid.map((i) => ids.addrs[i]), tx: ids.tx, owner: ids.owner };
  const byAddress = new Map<string, number[]>();
  const frozenNow = new Map<string, boolean>();
  const push = (key: string, i: number) => {
    let list = byAddress.get(key);
    if (!list) byAddress.set(key, (list = []));
    list.push(i);
  };
  for (let i = 0; i < site.n; i++) {
    const addr = site.addr[i];
    push(addr, i);
    const wallet = site.owner[String(site.aid[i])];
    if (wallet && wallet !== addr) push(wallet, i);
    const key = stateKey(site.chains[site.c[i]], site.tokens[site.k[i]], addr);
    const action = site.actions[site.a[i]];
    frozenNow.set(key, action !== "unfreeze");
  }
  const attributions = new Map<string, Attribution[]>();
  for (const r of parseCSV(attrText) as unknown as Attribution[]) {
    if (r.superseded_by) continue;
    const key = `${r.chain}|${r.address}`;
    const l = attributions.get(key) ?? [];
    l.push(r);
    attributions.set(key, l);
  }
  return { site, latest, report, byAddress, frozenNow, attributions };
}

/** "OFAC SDN list, since removed" for a row whose listing was withdrawn. */
export const REMOVED_MARK = "removed from the SDN list on";
export function recordLabel(a: Pick<Attribution, "entity" | "basis" | "source_class">): string {
  if (a.entity) return a.entity;
  const m = a.basis.match(/removed from the SDN list on (\d{4}-\d{2}-\d{2})/);
  if (m) return `OFAC SDN list, removed ${m[1]}`;
  return a.source_class === "ofac_sdn" ? "OFAC SDN list" : a.source_class;
}

export const CHAIN_COLOR: Record<Chain, string> = { ethereum: "#8ea2ff", base: "#4f8cff", tron: "#ff6b6b", solana: "#8ee3c8" };
export const ACTION_COLOR: Record<Action, string> = { freeze: "#a9d6ff", unfreeze: "#9fd3b4", destroy: "#ff7a59" };
export const RECORD_COLOR = "#ffcf70";
export const NONE_COLOR = "#3c3c5c";
export const CONF_LABEL = ["no public record", "low", "moderate", "high"] as const;

export const EXPLORER: Record<Chain, { address: (a: string) => string; tx: (t: string) => string }> = {
  ethereum: { address: (a) => `https://etherscan.io/address/${a}`, tx: (t) => `https://etherscan.io/tx/${t}` },
  base: { address: (a) => `https://basescan.org/address/${a}`, tx: (t) => `https://basescan.org/tx/${t}` },
  tron: { address: (a) => `https://tronscan.org/#/address/${a}`, tx: (t) => `https://tronscan.org/#/transaction/${t}` },
  solana: { address: (a) => `https://solscan.io/account/${a}`, tx: (t) => `https://solscan.io/tx/${t}` },
};
