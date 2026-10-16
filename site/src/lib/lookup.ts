import type { Attribution, Ledger } from "./data";
import { stateKey } from "./data";

export interface AddressState {
  chain: string;
  token: string;
  frozen: boolean;
  /** start of the current frozen stretch */
  since: number | null;
  /** Solana: the frozen token account, when the lookup was for the wallet owning it */
  account?: string;
}

export interface AddressView {
  address: string;
  events: number[]; // indices, time order
  states: AddressState[];
  attributions: Attribution[];
  chains: string[];
}

/** Everything the ledger holds for an address. On Solana the address can be
 *  the wallet that owns a frozen token account: state and records are read
 *  per token account, which is what the issuer froze. */
export function addressView(ledger: Ledger, address: string): AddressView | null {
  const idx = ledger.byAddress.get(address);
  if (!idx) return null;
  const site = ledger.site;
  const states = new Map<string, AddressState>();
  for (const i of idx) {
    const chain = site.chains[site.c[i]], token = site.tokens[site.k[i]], held = site.addr[i];
    const k = stateKey(chain, token, held);
    const st = states.get(k) ?? { chain, token, frozen: false, since: null, ...(held !== address ? { account: held } : {}) };
    // `since` is the start of the current frozen stretch, not the first ever freeze
    if (site.actions[site.a[i]] === "unfreeze") st.since = null;
    else if (st.since === null) st.since = site.t[i];
    st.frozen = ledger.frozenNow.get(k) ?? false;
    states.set(k, st);
  }
  for (const st of states.values()) if (!st.frozen) st.since = null;
  const attributions: Attribution[] = [];
  const seen = new Set<string>();
  for (const i of idx) {
    const key = `${site.chains[site.c[i]]}|${site.addr[i]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const a of ledger.attributions.get(key) ?? []) attributions.push(a);
  }
  const chains = [...new Set(idx.map((i) => site.chains[site.c[i]]))];
  return { address, events: idx, states: [...states.values()], attributions, chains };
}

export function eventRow(ledger: Ledger, i: number) {
  const s = ledger.site;
  return {
    index: i,
    chain: s.chains[s.c[i]],
    token: s.tokens[s.k[i]],
    action: s.actions[s.a[i]],
    address: s.addr[i],
    owner: s.owner[String(s.aid[i])] ?? null,
    amount: s.amt[i],
    time: s.t[i],
    tx: s.tx[i],
    logIndex: s.li[i],
    block: s.blk[i],
    conf: s.conf[i],
    entity: s.ent[i] >= 0 ? s.entities[s.ent[i]].name : null,
    internal: !!s.internal[i],
  };
}

export type EventRow = ReturnType<typeof eventRow>;

/** `chain:tx:log`, the same id as freeze_events.csv's event_id. */
export function eventId(ledger: Ledger, i: number) {
  const s = ledger.site;
  return `${s.chains[s.c[i]]}:${s.tx[i]}:${s.li[i]}`;
}

/** The event index for an event_id, or null. EVM hashes match in any case. */
export function findEvent(ledger: Ledger, id: string): number | null {
  const a = id.indexOf(":"), b = id.lastIndexOf(":");
  if (a < 1 || b <= a) return null;
  const chain = id.slice(0, a), tx = id.slice(a + 1, b), li = Number(id.slice(b + 1));
  if (!Number.isInteger(li)) return null;
  const s = ledger.site, txl = tx.toLowerCase();
  for (let i = 0; i < s.n; i++) {
    if (s.li[i] !== li || s.chains[s.c[i]] !== chain) continue;
    if (s.tx[i] === tx || (tx.startsWith("0x") && s.tx[i].toLowerCase() === txl)) return s.internal[i] ? null : i;
  }
  return null;
}
