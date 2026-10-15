/** Loading the ledger. site.json is the compact columnar export; latest.json
 *  holds the derived views the page quotes. Both are written by
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
  addr: string[];
  amt: (number | null)[];
  tx: string[];
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
  freeze_to_destroy_days: { n: number; p25: number; median: number; p75: number; max: number } | null;
  freeze_to_release_days: { n: number; p25: number; median: number; p75: number; max: number } | null;
  sdn_screening: Record<string, number>;
  files: Record<string, { sha256: string; rows?: number }>;
  registry: any[];
  checkpoints: Record<string, any>;
}

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
  /** address -> indices of its events, in time order */
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

export async function loadLedger(): Promise<Ledger> {
  const [site, latest, report, attrText] = await Promise.all([
    fetch(DATA_BASE + "site.json").then((r) => r.json() as Promise<SiteJson>),
    fetch(DATA_BASE + "latest.json").then((r) => r.json() as Promise<Latest>),
    fetch(DATA_BASE + "verification_report.json").then((r) => (r.ok ? (r.json() as Promise<VerificationReport>) : null)).catch(() => null),
    fetch(DATA_BASE + "attributions.csv").then((r) => (r.ok ? r.text() : "")).catch(() => ""),
  ]);
  const byAddress = new Map<string, number[]>();
  const frozenNow = new Map<string, boolean>();
  for (let i = 0; i < site.n; i++) {
    const addr = site.addr[i];
    let list = byAddress.get(addr);
    if (!list) byAddress.set(addr, (list = []));
    list.push(i);
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
