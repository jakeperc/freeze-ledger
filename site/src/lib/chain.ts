/** Browser-side chain reads, so the page can prove its own rows.
 *
 *  Two things run against public endpoints straight from the visitor's
 *  browser, with no server in between:
 *   - live status: `isBlackListed(address)` on Tether's contract and
 *     `isBlacklisted(address)` on Circle's FiatToken (Ethereum, Base), the
 *     same Tether call on Tron through TronGrid's constant-call endpoint, and
 *     on Solana the `state` of the token account (the address itself, or the
 *     ones the ledger knows a wallet owns)
 *   - re-derivation: `eth_getTransactionReceipt`, then the log at the row's
 *     index is decoded and compared field by field with the row
 *
 *  Selectors are keccak256 of the ABI signature (computed by the Python
 *  package's keccak module; see freeze_ledger/keccak.py):
 *   isBlackListed(address) -> 0xe47d6060   (Tether, capital L)
 *   isBlacklisted(address) -> 0xfe575a87   (Circle FiatToken)
 */

import type { Action, Chain } from "./data";

export const RPC: Record<"ethereum" | "base", string[]> = {
  ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://cloudflare-eth.com"],
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
};

export const CONTRACTS: Record<"ethereum" | "base", { token: "USDT" | "USDC"; issuer: "tether" | "circle"; address: string; selector: string }[]> = {
  ethereum: [
    { token: "USDT", issuer: "tether", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", selector: "0xe47d6060" },
    { token: "USDC", issuer: "circle", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", selector: "0xfe575a87" },
  ],
  base: [{ token: "USDC", issuer: "circle", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", selector: "0xfe575a87" }],
};

/** topic0 -> {action, indexed} for the two ABIs (from registry.py) */
export const TOPICS: Record<string, { action: Action; name: string; indexed: boolean; hasAmount: boolean }> = {
  "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc": { action: "freeze", name: "AddedBlackList", indexed: false, hasAmount: false },
  "0xd7e9ec6e6ecd65492dce6bf513cd6867560d49544421d0783ddf06e76c24470c": { action: "unfreeze", name: "RemovedBlackList", indexed: false, hasAmount: false },
  "0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6": { action: "destroy", name: "DestroyedBlackFunds", indexed: false, hasAmount: true },
  "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855": { action: "freeze", name: "Blacklisted", indexed: true, hasAmount: false },
  "0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e": { action: "unfreeze", name: "UnBlacklisted", indexed: true, hasAmount: false },
};

export interface RpcResult<T> { result: T; endpoint: string; ms: number }

export async function rpc<T = any>(chain: "ethereum" | "base", method: string, params: unknown[]): Promise<RpcResult<T>> {
  let lastErr: unknown = null;
  for (const url of RPC[chain]) {
    const t0 = performance.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`${url} ${res.status}`);
      const obj = await res.json();
      if (obj.error) throw new Error(obj.error.message || "rpc error");
      return { result: obj.result as T, endpoint: url, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      lastErr = e;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(/fetch|network|abort/i.test(msg) ? "no public node could be reached from this browser" : msg);
}

const word = (addr: string) => "0".repeat(24) + addr.toLowerCase().replace(/^0x/, "");

export interface LiveStatus {
  chain: Chain;
  token: "USDT" | "USDC";
  frozen: boolean;
  endpoint: string;
  ms: number;
  /** block or slot the answer is from; 0 when the endpoint does not say */
  block: number;
  /** Solana: the token account the state belongs to */
  account?: string;
}

const TRONGRID = "https://api.trongrid.io";
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
// api.mainnet-beta.solana.com refuses requests from browser origins
const SOLANA_RPC = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
const SOLANA_MINTS: { token: "USDT" | "USDC"; mint: string }[] = [
  { token: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { token: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
];

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 to bytes (no checksum check; TronGrid rejects a bad address anyway). */
function base58(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error("not base58");
    n = n * 58n + BigInt(v);
  }
  const hex = n.toString(16);
  const body = (hex.length % 2 ? "0" : "") + hex;
  const bytes = body.match(/../g)!.map((b) => parseInt(b, 16));
  const zeros = s.match(/^1*/)![0].length;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

async function post<T>(url: string, body: unknown): Promise<{ json: T; ms: number }> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return { json: (await res.json()) as T, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

/** Tether's isBlackListed on Tron, through TronGrid's read-only constant call. */
async function tronStatus(address: string): Promise<LiveStatus[]> {
  const raw = base58(address); // 0x41 + 20 bytes + 4 checksum bytes
  const hex20 = [...raw.slice(1, 21)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const url = `${TRONGRID}/wallet/triggerconstantcontract`;
  const { json, ms } = await post<{ constant_result?: string[]; result?: { result?: boolean; message?: string } }>(url, {
    owner_address: address,
    contract_address: TRON_USDT,
    function_selector: "isBlackListed(address)",
    parameter: hex20.padStart(64, "0"),
    visible: true,
  });
  const word = json.constant_result?.[0];
  if (!word) throw new Error(json.result?.message ? "TronGrid: " + json.result.message : "TronGrid gave no result");
  return [{ chain: "tron", token: "USDT", frozen: /1$/.test(word.replace(/^0+/, "") || "0"), endpoint: TRONGRID, ms, block: 0 }];
}

type ParsedAccount = { data: { parsed?: { type?: string; info?: { mint?: string; state?: string; owner?: string } } } };

/** Solana: the `state` of token accounts, read with getAccountInfo. Listing a
 *  wallet's token accounts (getTokenAccountsByOwner) is an indexed call the
 *  free public endpoints refuse from a browser, so the accounts checked are
 *  the address itself (if it is a token account) and any token accounts the
 *  ledger knows the address owns. */
async function solanaStatus(address: string, known: string[]): Promise<LiveStatus[]> {
  const accounts = [...new Set([address, ...known])];
  let lastErr: unknown = null;
  for (const url of SOLANA_RPC) {
    try {
      const out: LiveStatus[] = [];
      for (const acct of accounts) {
        const { json, ms } = await post<{ result?: { context: { slot: number }; value: ParsedAccount | null }; error?: { message: string } }>(url, {
          jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [acct, { encoding: "jsonParsed", commitment: "confirmed" }],
        });
        if (json.error) throw new Error(json.error.message);
        const info = json.result?.value?.data.parsed?.info;
        const m = SOLANA_MINTS.find((x) => x.mint === info?.mint);
        if (m && json.result?.value?.data.parsed?.type === "account")
          out.push({ chain: "solana", token: m.token, frozen: info?.state === "frozen", endpoint: url, ms, block: json.result.context.slot, account: acct });
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(/fetch|network|abort/i.test(msg) ? "no public Solana node could be reached from this browser" : msg);
}

/** Ask the issuers directly, on the address's own chain, whether it is frozen right now. */
export async function liveStatus(address: string, solanaAccounts: string[] = []): Promise<LiveStatus[]> {
  if (isTronAddress(address)) return tronStatus(address);
  if (!isEvmAddress(address)) return solanaStatus(address, solanaAccounts);
  const out: LiveStatus[] = [];
  for (const chain of ["ethereum", "base"] as const) {
    let block = 0;
    try {
      const b = await rpc<string>(chain, "eth_blockNumber", []);
      block = parseInt(b.result, 16);
    } catch { /* keep 0 */ }
    for (const c of CONTRACTS[chain]) {
      const r = await rpc<string>(chain, "eth_call", [{ to: c.address, data: c.selector + word(address) }, "latest"]);
      const frozen = /1$/.test(r.result.replace(/^0x/, "").replace(/^0+/, "") || "0");
      out.push({ chain, token: c.token, frozen, endpoint: r.endpoint, ms: r.ms, block });
    }
  }
  return out;
}

export interface Rederivation {
  ok: boolean;
  endpoint: string;
  ms: number;
  checks: { field: string; row: string; chain: string; ok: boolean }[];
  error?: string;
}

function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

/** 20-byte hex (as TronGrid's event API gives it) to a Base58Check T-address. */
async function tronFromHex(hex: string): Promise<string> {
  const body = Uint8Array.from([0x41, ...(hex.replace(/^0x/, "").replace(/^41(?=[0-9a-f]{40}$)/i, "").match(/../g) ?? []).map((b) => parseInt(b, 16))]);
  const h1 = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const h2 = new Uint8Array(await crypto.subtle.digest("SHA-256", h1));
  return b58encode(Uint8Array.from([...body, ...h2.slice(0, 4)]));
}

const TRON_EVENTS: Record<string, { action: Action; hasAmount: boolean }> = {
  AddedBlackList: { action: "freeze", hasAmount: false },
  RemovedBlackList: { action: "unfreeze", hasAmount: false },
  DestroyedBlackFunds: { action: "destroy", hasAmount: true },
};

/** Tron: TronGrid's events for the transaction, the one at the row's index. */
async function rederiveTron(row: { tx: string; logIndex: number; block: number; address: string; action: Action; amount: number | null }): Promise<Rederivation> {
  const url = `${TRONGRID}/v1/transactions/${row.tx}/events`;
  const t0 = performance.now();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`TronGrid ${res.status}`);
  const obj = (await res.json()) as { data?: { event_index: number; event_name: string; block_number: number; contract_address: string; result: Record<string, string> }[] };
  const ms = Math.round(performance.now() - t0);
  const ev = (obj.data ?? []).find((e) => e.event_index === row.logIndex);
  const checks: Rederivation["checks"] = [];
  if (!ev) return { ok: false, endpoint: TRONGRID, ms, checks: [{ field: "log index", row: String(row.logIndex), chain: "no event at that index", ok: false }] };
  const spec = TRON_EVENTS[ev.event_name];
  checks.push({ field: "block", row: String(row.block), chain: String(ev.block_number), ok: ev.block_number === row.block });
  checks.push({ field: "contract", row: TRON_USDT, chain: ev.contract_address, ok: ev.contract_address === TRON_USDT });
  checks.push({ field: "event", row: row.action, chain: spec ? `${ev.event_name} → ${spec.action}` : ev.event_name, ok: !!spec && spec.action === row.action });
  const addr = await tronFromHex(ev.result["0"] ?? "");
  checks.push({ field: "address", row: row.address, chain: addr, ok: addr === row.address });
  if (spec?.hasAmount) {
    const amount = Number(BigInt(ev.result["1"] ?? "0")) / 1e6;
    checks.push({ field: "amount", row: String(row.amount), chain: String(amount), ok: Math.abs((row.amount ?? 0) - amount) < 1e-6 });
  }
  return { ok: checks.every((c) => c.ok), endpoint: TRONGRID, ms, checks };
}

/** Re-fetch the transaction and compare the log at `logIndex` to the row. */
export async function rederive(row: { chain: Chain; tx: string; logIndex: number; block: number; address: string; action: Action; amount: number | null; contract: string }): Promise<Rederivation> {
  if (row.chain === "tron") {
    try {
      return await rederiveTron(row);
    } catch (e) {
      return { ok: false, endpoint: TRONGRID, ms: 0, checks: [], error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (row.chain !== "ethereum" && row.chain !== "base") {
    return { ok: false, endpoint: "", ms: 0, checks: [], error: `in-browser re-derivation covers Ethereum, Base and Tron; ${row.chain} is checked by verify.py` };
  }
  try {
    const r = await rpc<any>(row.chain, "eth_getTransactionReceipt", [row.tx]);
    if (!r.result) return { ok: false, endpoint: r.endpoint, ms: r.ms, checks: [], error: "receipt not found on this endpoint" };
    const rec = r.result;
    const log = (rec.logs as any[]).find((l) => parseInt(l.logIndex, 16) === row.logIndex);
    const checks: Rederivation["checks"] = [];
    checks.push({ field: "block", row: String(row.block), chain: String(parseInt(rec.blockNumber, 16)), ok: parseInt(rec.blockNumber, 16) === row.block });
    if (!log) {
      checks.push({ field: "log index", row: String(row.logIndex), chain: "no log at that index", ok: false });
      return { ok: false, endpoint: r.endpoint, ms: r.ms, checks };
    }
    const spec = TOPICS[(log.topics[0] as string).toLowerCase()];
    checks.push({ field: "contract", row: row.contract, chain: (log.address as string).toLowerCase(), ok: (log.address as string).toLowerCase() === row.contract });
    checks.push({ field: "event", row: row.action, chain: spec ? `${spec.name} → ${spec.action}` : "unknown topic", ok: !!spec && spec.action === row.action });
    let addr = "";
    let amount: number | null = null;
    if (spec) {
      const data = (log.data as string).replace(/^0x/, "");
      addr = spec.indexed ? "0x" + (log.topics[1] as string).slice(-40) : "0x" + data.slice(24, 64);
      if (spec.hasAmount) amount = Number(BigInt("0x" + data.slice(64, 128))) / 1e6;
    }
    checks.push({ field: "address", row: row.address, chain: addr.toLowerCase(), ok: addr.toLowerCase() === row.address });
    if (spec?.hasAmount) checks.push({ field: "amount", row: String(row.amount), chain: String(amount), ok: amount !== null && Math.abs((row.amount ?? 0) - amount) < 1e-6 });
    return { ok: checks.every((c) => c.ok), endpoint: r.endpoint, ms: r.ms, checks };
  } catch (e) {
    return { ok: false, endpoint: "", ms: 0, checks: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
export const isTronAddress = (s: string) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s.trim());
export const isSolanaAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim()) && !isTronAddress(s);

export function normalizeAddress(s: string): string | null {
  const t = s.trim();
  if (isEvmAddress(t)) return t.toLowerCase();
  if (isTronAddress(t)) return t;
  if (isSolanaAddress(t)) return t;
  return null;
}

/** Pull every address-looking token out of free text (one per line, CSV, JSON, prose).
 *  A Solana address is any 32 to 44 base58 characters, which ordinary words
 *  and hashes can also be, so one counts only when it stands alone: a whole
 *  line, a CSV or TSV cell, or a quoted JSON string. */
export function extractAddresses(text: string): string[] {
  // address -> where it first appears, so results come back in the order pasted
  const found = new Map<string, number>();
  const add = (a: string, at: number) => { if (!found.has(a)) found.set(a, at); };
  for (const m of text.matchAll(/0x[0-9a-fA-F]{40}/g)) add(m[0].toLowerCase(), m.index ?? 0);
  for (const m of text.matchAll(/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g)) add(m[0], m.index ?? 0);
  for (const m of text.matchAll(/(?:^|[\s,;\t"'\[])([1-9A-HJ-NP-Za-km-z]{32,44})(?=$|[\s,;\t"'\]])/gm)) {
    const a = m[1];
    if (isSolanaAddress(a) && /\d/.test(a) && /[a-z]/.test(a) && /[A-Z]/.test(a)) add(a, (m.index ?? 0) + m[0].indexOf(a));
  }
  return [...found.entries()].sort((x, y) => x[1] - y[1]).map(([a]) => a);
}
