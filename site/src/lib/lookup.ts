import type { Attribution, Ledger } from "./data";
import { stateKey } from "./data";

export interface AddressView {
  address: string;
  events: number[]; // indices, time order
  states: { chain: string; token: string; frozen: boolean; since: number | null }[];
  attributions: Attribution[];
  chains: string[];
}

export function addressView(ledger: Ledger, address: string): AddressView | null {
  const idx = ledger.byAddress.get(address);
  if (!idx) return null;
  const site = ledger.site;
  const seen = new Map<string, { chain: string; token: string; frozen: boolean; since: number | null }>();
  for (const i of idx) {
    const chain = site.chains[site.c[i]], token = site.tokens[site.k[i]];
    const k = stateKey(chain, token, address);
    const frozen = ledger.frozenNow.get(k) ?? false;
    const cur = seen.get(k) ?? { chain, token, frozen, since: null };
    cur.frozen = frozen;
    if (site.actions[site.a[i]] !== "unfreeze") cur.since = cur.since === null ? site.t[i] : cur.since;
    else cur.since = null;
    seen.set(k, cur);
  }
  // `since` should be the start of the current frozen stretch, not the first ever freeze
  for (const [k, st] of seen) {
    if (!st.frozen) { st.since = null; continue; }
    let since: number | null = null;
    for (const i of idx) {
      const chain = site.chains[site.c[i]], token = site.tokens[site.k[i]];
      if (stateKey(chain, token, address) !== k) continue;
      const a = site.actions[site.a[i]];
      if (a === "unfreeze") since = null;
      else if (since === null) since = site.t[i];
    }
    st.since = since;
  }
  const attributions: Attribution[] = [];
  const chains = [...new Set(idx.map((i) => site.chains[site.c[i]]))];
  for (const c of chains) for (const a of ledger.attributions.get(`${c}|${address}`) ?? []) attributions.push(a);
  return { address, events: idx, states: [...seen.values()], attributions, chains };
}

export function eventRow(ledger: Ledger, i: number) {
  const s = ledger.site;
  return {
    index: i,
    chain: s.chains[s.c[i]],
    token: s.tokens[s.k[i]],
    action: s.actions[s.a[i]],
    address: s.addr[i],
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
