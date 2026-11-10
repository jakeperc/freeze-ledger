/** The SQL engine behind the Query section: DuckDB compiled to WebAssembly,
 *  run in a worker, over the same CSVs the Method section offers as
 *  downloads. This module is only imported when a visitor opens the panel,
 *  so neither the engine (~7.7 MB compressed) nor the CSVs load otherwise.
 *
 *  The engine's files are served from this site, not a CDN: the version is
 *  the one pinned in package-lock.json, and the page needs no third party
 *  to answer a query. */

import * as duckdb from "@duckdb/duckdb-wasm";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { DATA_BASE } from "./data";

/** A table the panel creates, the file it is read from, and how its text
 *  columns are typed. Every column is read as text first and cast here, so a
 *  sample-based type guess can never misread an address or an empty cell. */
export interface TableSpec {
  name: string;
  file: string;
  about: string;
  select: string;
}

// CAST, not TRY_CAST: a malformed cell stops the load with DuckDB's own error
// instead of quietly becoming NULL and undercounting every query after it
const t = (col: string, type: string) => `CAST(NULLIF(${col}, '') AS ${type}) AS ${col}`;

export const TABLES: TableSpec[] = [
  {
    name: "events",
    file: "freeze_events.csv",
    about: "one row per freeze, unfreeze or destroy; amount is set on destroys only",
    select: `event_id, chain, issuer, token, action, address, NULLIF(owner_address, '') AS owner_address,
      ${t("amount", "DECIMAL(38,6)")}, ${t("block_number", "BIGINT")}, ${t("block_time", "TIMESTAMP")},
      tx_hash, ${t("log_index", "INTEGER")}, coalesce(issuer_internal = 'true', false) AS issuer_internal,
      evidence_id, ${t("indexed_at", "TIMESTAMP")}`,
  },
  {
    name: "attributions_all",
    file: "attributions.csv",
    about: "every judgment ever made, including superseded ones",
    select: `attribution_id, address, chain, source_class, NULLIF(entity, '') AS entity, NULLIF(program, '') AS program,
      ${t("record_date", "DATE")}, confidence, basis, evidence_url, ${t("judged_at", "DATE")}, NULLIF(superseded_by, '') AS superseded_by`,
  },
  {
    name: "evidence",
    file: "evidence.csv",
    about: "the receipt behind each row: kind, locator, SHA-256, size",
    select: `evidence_id, kind, locator, ${t("fetched_at", "TIMESTAMP")}, sha256, ${t("bytes", "BIGINT")}`,
  },
  {
    name: "sdn_addresses",
    file: "sdn_addresses.csv",
    about: "OFAC SDN digital-currency addresses with entity, program and the party's designation date",
    select: `asset, address, address_norm, chain_hint, entity, program, ${t("listed_date", "DATE")}, fixed_ref, feature_id, source_url`,
  },
  {
    name: "sdn_history",
    file: "sdn_address_history.csv",
    about: "when each SDN address was listed and, if it was, removed",
    select: `chain_hint, address_norm, assets, ${t("first_seen", "DATE")}, ${t("not_before", "DATE")},
      ${t("last_seen", "DATE")}, ${t("removed_at", "DATE")}, first_commit, NULLIF(removed_commit, '') AS removed_commit`,
  },
];

/** Views over the tables, so the common cases need no WHERE clause to get right. */
const VIEWS = [
  // the judgments that stand: superseded and withdrawn rows are excluded
  `CREATE VIEW attributions AS SELECT * FROM attributions_all WHERE superseded_by IS NULL`,
];

export interface Engine {
  run(sql: string): Promise<Result>;
  close(): Promise<void>;
  version: string;
  rows: Record<string, number>;
}

export interface Result {
  columns: string[];
  rows: unknown[][];
  ms: number;
}

/** Arrow values the table cannot show as they are: 64-bit integers arrive as
 *  BigInt, timestamps as epoch milliseconds, decimals as scaled integers. */
function plain(v: unknown, type: string): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (type.startsWith("Timestamp") && typeof v === "number") return new Date(v).toISOString().replace(".000Z", "Z");
  if (type.startsWith("Date") && typeof v === "number") return new Date(v).toISOString().slice(0, 10);
  if (typeof v === "object") return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  return v;
}

/** Decimal columns come back from Arrow as unscaled integers; put the point back. */
function decimal(v: unknown, scale: number): unknown {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!/^-?\d+$/.test(s) || scale === 0) return s;
  const neg = s.startsWith("-");
  const digits = (neg ? s.slice(1) : s).padStart(scale + 1, "0");
  return `${neg ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export async function start(onStep: (step: string) => void): Promise<Engine> {
  onStep("Starting the SQL engine");
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  try {
    return await open(db, worker, bundle, onStep);
  } catch (e) {
    // a failed start leaves nothing running: the next press starts clean
    await db.terminate().catch(() => {});
    worker.terminate();
    throw e;
  }
}

/** Arrow types the table shows as they come; anything else (intervals,
 *  lists, structs, maps, times) is rendered by DuckDB itself as text. */
const SIMPLE = /^(Utf8|LargeUtf8|Bool|Int|Uint|Float|Decimal|Timestamp|Date|Null)/;

async function open(
  db: duckdb.AsyncDuckDB,
  worker: Worker,
  bundle: duckdb.DuckDBBundle,
  onStep: (step: string) => void,
): Promise<Engine> {
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();
  const version = String((await conn.query("SELECT version() AS v")).toArray()[0]?.v ?? "");

  const rows: Record<string, number> = {};
  for (const spec of TABLES) {
    onStep(`Loading ${spec.file}`);
    const res = await fetch(DATA_BASE + spec.file);
    if (!res.ok) throw new Error(`${spec.file}: HTTP ${res.status}`);
    await db.registerFileText(spec.file, await res.text());
    await conn.query(
      `CREATE TABLE ${spec.name} AS SELECT ${spec.select} FROM read_csv('${spec.file}', header = true, all_varchar = true, quote = '"', escape = '"')`,
    );
    rows[spec.name] = Number((await conn.query(`SELECT count(*) AS n FROM ${spec.name}`)).toArray()[0]?.n ?? 0);
  }
  for (const v of VIEWS) await conn.query(v);
  rows.attributions = Number((await conn.query(`SELECT count(*) AS n FROM attributions`)).toArray()[0]?.n ?? 0);

  return {
    version,
    rows,
    async run(sql: string) {
      const t0 = performance.now();
      let table = await conn.query(sql);
      if (table.schema.fields.some((f) => !SIMPLE.test(String(f.type)))) {
        // re-run with every column cast to text, so an INTERVAL or a list of
        // DECIMALs reads as DuckDB prints it, not as raw Arrow parts
        const inner = sql.trim().replace(/;s*$/, "");
        try {
          table = await conn.query(`SELECT CAST(COLUMNS(*) AS VARCHAR) FROM (${inner}) AS q`);
        } catch {
          /* not a plain SELECT: keep the first result */
        }
      }
      const fields = table.schema.fields;
      const types = fields.map((f) => String(f.type));
      const scales = fields.map((f) => (f.type as { scale?: number }).scale ?? 0);
      const out: unknown[][] = [];
      for (const r of table.toArray()) {
        const obj = r.toJSON() as Record<string, unknown>;
        out.push(fields.map((f, i) => (types[i].startsWith("Decimal") ? decimal(obj[f.name], scales[i]) : plain(obj[f.name], types[i]))));
      }
      return { columns: fields.map((f) => f.name), rows: out, ms: performance.now() - t0 };
    },
    async close() {
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
}
