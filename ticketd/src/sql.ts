// SQL backend for ticketd (2026-10-11) — one async interface, two engines:
//
//   • SQLite (node:sqlite, a file in data/) — the default: local dev, the
//     POC, the selftest (in memory). One process, one connection.
//   • Postgres (DATABASE_URL=postgres://…) — production: several ticketd
//     replicas share it, so the service scales out behind Kubernetes.
//
// Repositories (db.ts) write portable SQL with `?` placeholders; the
// Postgres adapter numbers them. `tx(fn, lockKey)` runs fn atomically: on
// Postgres it also takes a transaction-scoped advisory lock on `lockKey`
// (e.g. a wallet), so two replicas cannot race on the same account; on
// SQLite every statement is serialized anyway.
//
// Schema changes are VERSIONED (schema_migrations). Add a migration to
// MIGRATIONS — never edit an applied one. They run at start-up under an
// advisory lock (replicas starting together apply them once), or by hand:
// `npm run migrate -w @gamevault/ticketd`.

import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import type { PoolClient } from "pg";

export type Row = Record<string, unknown>;
type Param = string | number | bigint | null | Uint8Array;

export interface Store {
  readonly kind: "sqlite" | "postgres";
  get<T extends Row>(sql: string, params?: Param[]): Promise<T | undefined>;
  all<T extends Row>(sql: string, params?: Param[]): Promise<T[]>;
  run(sql: string, params?: Param[]): Promise<{ changes: number }>;
  /** Atomic: all of fn's statements or none. lockKey serializes callers
   *  that touch the same entity across replicas (Postgres advisory lock). */
  tx<T>(fn: () => Promise<T>, lockKey?: string): Promise<T>;
  /** Readiness: the database answers. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

// ── Versioned schema ────────────────────────────────────────────────────
// Each migration has a SQLite and a Postgres form. Types: timestamps are
// milliseconds (BIGINT on Postgres — INTEGER would overflow), binary data
// is BLOB / BYTEA, auto ids are AUTOINCREMENT / IDENTITY.

interface Migration {
  version: number;
  name: string;
  sqlite: string;
  postgres: string;
}

const V1_TABLES = (t: { int: string; blob: string; id: string }) => `
CREATE TABLE IF NOT EXISTS content_keys (
  cid TEXT PRIMARY KEY,
  key_enc ${t.blob} NOT NULL,      -- nonce(12) || AES-GCM(master, key, aad=cid)
  publisher TEXT,
  studio_id TEXT,
  created_at ${t.int} NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at ${t.int} NOT NULL);
CREATE INDEX IF NOT EXISTS nonces_expiry ON nonces (expires_at);
CREATE TABLE IF NOT EXISTS friend_requests (
  from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, at ${t.int} NOT NULL,
  PRIMARY KEY (from_addr, to_addr)
);
CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests (to_addr);
CREATE TABLE IF NOT EXISTS friendships (lo TEXT NOT NULL, hi TEXT NOT NULL, since ${t.int} NOT NULL, PRIMARY KEY (lo, hi));
CREATE INDEX IF NOT EXISTS friendships_hi ON friendships (hi);
CREATE TABLE IF NOT EXISTS profiles (
  addr TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_type TEXT,
  favorites TEXT NOT NULL,         -- JSON array of edition ids
  updated_at ${t.int} NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  created_at ${t.int}
);
CREATE TABLE IF NOT EXISTS playstats (addr TEXT NOT NULL, edition_id TEXT NOT NULL, seconds ${t.int} NOT NULL, PRIMARY KEY (addr, edition_id));
CREATE TABLE IF NOT EXISTS devices (
  wallet TEXT NOT NULL, pubkey TEXT NOT NULL, paired_at ${t.int} NOT NULL, last_seen ${t.int} NOT NULL,
  PRIMARY KEY (wallet, pubkey)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,     -- sha256(token): the token itself is never stored
  wallet TEXT NOT NULL,
  device TEXT,
  expires_at ${t.int} NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS sessions_device ON sessions (wallet, device);
CREATE TABLE IF NOT EXISTS activity (id ${t.id}, wallet TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, at ${t.int} NOT NULL);
CREATE INDEX IF NOT EXISTS activity_wallet ON activity (wallet, id);
CREATE TABLE IF NOT EXISTS studio_pages (
  studio_id TEXT PRIMARY KEY, description TEXT NOT NULL, links TEXT NOT NULL, team TEXT NOT NULL,
  updated_at ${t.int} NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id ${t.id}, conv TEXT NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL,
  kind TEXT NOT NULL, body TEXT NOT NULL, at ${t.int} NOT NULL, read_at ${t.int}
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conv, id);
CREATE INDEX IF NOT EXISTS messages_unread ON messages (to_addr, read_at);
CREATE INDEX IF NOT EXISTS messages_from ON messages (from_addr);
CREATE TABLE IF NOT EXISTS wishlist (
  addr TEXT NOT NULL, edition_id TEXT NOT NULL, seen_wei TEXT NOT NULL, at ${t.int} NOT NULL,
  PRIMARY KEY (addr, edition_id)
);
CREATE TABLE IF NOT EXISTS privacy (addr TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at ${t.int} NOT NULL);
`;

const SQLITE_T = { int: "INTEGER", blob: "BLOB", id: "INTEGER PRIMARY KEY AUTOINCREMENT" };
const PG_T = { int: "BIGINT", blob: "BYTEA", id: "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY" };

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial schema (social v1, devices, wishlist, privacy)", sqlite: V1_TABLES(SQLITE_T), postgres: V1_TABLES(PG_T) },
  {
    version: 2,
    name: "avatars in the database (shared by every replica)",
    sqlite: "CREATE TABLE IF NOT EXISTS avatars (addr TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BLOB NOT NULL, updated_at INTEGER NOT NULL);",
    postgres: "CREATE TABLE IF NOT EXISTS avatars (addr TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BYTEA NOT NULL, updated_at BIGINT NOT NULL);",
  },
];

const MIGRATION_LOCK = 7_270_011; // arbitrary, constant: one migrator at a time

// ── SQLite ──────────────────────────────────────────────────────────────

/** FIFO async mutex: the single SQLite connection runs one transaction at
 *  a time, and no stray statement can land inside someone else's. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    return release;
  }
}

const inTx = new AsyncLocalStorage<{ pg?: PoolClient }>();

function sqliteStore(file: string): Store {
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  migrateSqlite(conn); // same connection: an in-memory database keeps its schema
  const mutex = new Mutex();
  const exec = async <T>(f: () => T): Promise<T> => {
    if (inTx.getStore()) return f(); // already holding the connection
    const release = await mutex.lock();
    try {
      return f();
    } finally {
      release();
    }
  };
  return {
    kind: "sqlite",
    get: <T extends Row>(sql: string, params: Param[] = []) => exec(() => conn.prepare(sql).get(...params) as T | undefined),
    all: <T extends Row>(sql: string, params: Param[] = []) => exec(() => conn.prepare(sql).all(...params) as T[]),
    run: (sql, params = []) => exec(() => ({ changes: Number(conn.prepare(sql).run(...params).changes) })),
    async tx<T>(fn: () => Promise<T>): Promise<T> {
      if (inTx.getStore()) return fn(); // nested: part of the outer transaction
      const release = await mutex.lock();
      try {
        conn.exec("BEGIN IMMEDIATE");
        try {
          const out = await inTx.run({}, fn);
          conn.exec("COMMIT");
          return out;
        } catch (e) {
          conn.exec("ROLLBACK");
          throw e;
        }
      } finally {
        release();
      }
    },
    async ping() {
      conn.prepare("SELECT 1").get();
    },
    async close() {
      conn.close();
    },
  };
}

/** SQLite: the schema of older local databases (pre-migrations) is
 *  compatible with v1; legacy columns are added if missing. */
function migrateSqlite(s: DatabaseSync): void {
  s.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const done = new Set((s.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    s.exec(m.sqlite);
    if (m.version === 1) {
      const cols = (s.prepare("PRAGMA table_info(profiles)").all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes("bio")) s.exec("ALTER TABLE profiles ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
      if (!cols.includes("created_at")) s.exec("ALTER TABLE profiles ADD COLUMN created_at INTEGER");
      s.exec("UPDATE profiles SET created_at = updated_at WHERE created_at IS NULL");
    }
    s.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, Date.now());
  }
}

// ── Postgres ────────────────────────────────────────────────────────────

// BIGINT / COUNT / SUM come back as JavaScript numbers (ms timestamps and
// counters stay far below 2^53).
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric (SUM)

/** `?` -> `$1, $2…` (our SQL never contains a literal question mark). */
const numbered = (sql: string): string => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};
const pgParams = (params: Param[]): unknown[] => params.map((p) => (p instanceof Uint8Array ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : typeof p === "bigint" ? p.toString() : p));

function postgresStore(url: string): Store {
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10_000),
    application_name: `ticketd${process.env.HOSTNAME ? `@${process.env.HOSTNAME}` : ""}`,
  });
  pool.on("error", (e) => console.error(`⛔ postgres (connexion inactive) : ${e.message}`));
  const runner = () => inTx.getStore()?.pg ?? pool;
  return {
    kind: "postgres",
    async get<T extends Row>(sql: string, params: Param[] = []) {
      return (await runner().query(numbered(sql), pgParams(params))).rows[0] as T | undefined;
    },
    async all<T extends Row>(sql: string, params: Param[] = []) {
      return (await runner().query(numbered(sql), pgParams(params))).rows as T[];
    },
    async run(sql, params = []) {
      return { changes: (await runner().query(numbered(sql), pgParams(params))).rowCount ?? 0 };
    },
    async tx<T>(fn: () => Promise<T>, lockKey?: string): Promise<T> {
      if (inTx.getStore()?.pg) return fn();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (lockKey) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
        const out = await inTx.run({ pg: client }, fn);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async ping() {
      await pool.query("SELECT 1");
    },
    async close() {
      await pool.end();
    },
  };
}

/** Applies pending migrations once, even with several replicas starting
 *  together (session-level advisory lock). Returns the versions applied. */
export async function migratePostgres(url: string): Promise<number[]> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  const applied: number[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)");
    const done = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((r: { version: number }) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.postgres);
        await client.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)", [m.version, m.name, Date.now()]);
        await client.query("COMMIT");
        applied.push(m.version);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.version} (${m.name}) : ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    await client.end();
  }
  return applied;
}

// ── Selection ───────────────────────────────────────────────────────────

let current: Store | null = null;

/** Opens the configured backend and brings its schema up to date. */
export async function openStore(opts: { sqliteFile: string; databaseUrl?: string }): Promise<Store> {
  if (current) return current;
  if (opts.databaseUrl) {
    // Postgres may start after ticketd (same rollout): wait for it instead
    // of crash-looping. DB_CONNECT_RETRIES x 2 s (default 60 s).
    const tries = Number(process.env.DB_CONNECT_RETRIES ?? 30);
    let applied: number[] = [];
    for (let i = 1; ; i++) {
      try {
        applied = await migratePostgres(opts.databaseUrl);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (i >= tries || msg.startsWith("migration ")) throw e; // a broken migration is not a connection problem
        console.warn(`… postgres injoignable (${msg}) — nouvel essai ${i}/${tries} dans 2 s`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (applied.length) console.log(`✔ postgres : migrations ${applied.join(", ")} appliquées`);
    current = postgresStore(opts.databaseUrl);
  } else {
    current = sqliteStore(opts.sqliteFile);
  }
  return current;
}

export function store(): Store {
  if (!current) throw new Error("base non initialisée (openStore)");
  return current;
}

export async function closeStore(): Promise<void> {
  await current?.close();
  current = null;
}
