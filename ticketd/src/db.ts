// ticketd persistence — SQLite via node:sqlite (no native dependency).
// Replaced the JSON files on 2026-10-07 (audit T11/T12; one-time migration
// done — the plaintext key copy was deleted, the other *.migrated.json files
// hold no secret): atomic transactions, persisted
// nonces (no replay after a restart), content keys ENCRYPTED AT REST with
// a master key from the environment (AES-256-GCM, the CID bound as AAD so
// a ciphertext cannot be moved to another build).
//
// Files: data/ticketd.db (+ WAL). Avatars stay files in data/avatars.
// Backup: `npm run backup -w ticketd`. A backup is useless without
// KEYSTORE_MASTER_KEY, and losing that key loses every game key: keep it
// OUTSIDE this machine (password manager).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gcm } from "@noble/ciphers/aes";

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../data");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS content_keys (
  cid TEXT PRIMARY KEY,
  key_enc BLOB NOT NULL,          -- nonce(12) || AES-GCM(master, key, aad=cid)
  publisher TEXT,                 -- NULL = legacy unsigned publish
  studio_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_requests (
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (from_addr, to_addr)
);
CREATE TABLE IF NOT EXISTS friendships (
  lo TEXT NOT NULL,
  hi TEXT NOT NULL,
  since INTEGER NOT NULL,         -- unix seconds
  PRIMARY KEY (lo, hi)
);
CREATE INDEX IF NOT EXISTS friendships_hi ON friendships (hi);
CREATE TABLE IF NOT EXISTS profiles (
  addr TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_type TEXT,
  favorites TEXT NOT NULL,        -- JSON array of edition ids
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playstats (
  addr TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  PRIMARY KEY (addr, edition_id)
);
CREATE TABLE IF NOT EXISTS devices (
  wallet TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  paired_at INTEGER NOT NULL,     -- ms
  last_seen INTEGER NOT NULL,     -- ms
  PRIMARY KEY (wallet, pubkey)
);
`;

// ── Connection ─────────────────────────────────────────────────────────

let conn: DatabaseSync | null = null;

/** In the selftest (no chain, GAMEVAULT_SKIP_OWNER_CHECK) the DB is in
 *  memory: tests never touch the real data. */
export function db(): DatabaseSync {
  if (conn) return conn;
  const inMemory = process.env.GAMEVAULT_SKIP_OWNER_CHECK === "1";
  if (!inMemory) mkdirSync(DATA_DIR, { recursive: true });
  conn = new DatabaseSync(inMemory ? ":memory:" : join(DATA_DIR, "ticketd.db"));
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  conn.exec(SCHEMA);
  return conn;
}

/** Runs `fn` atomically — all of it or none of it. */
export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

// ── Master key (content keys at rest) ──────────────────────────────────

function masterKey(): Uint8Array {
  const hex = process.env.KEYSTORE_MASTER_KEY?.replace(/^0x/, "") ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("KEYSTORE_MASTER_KEY manquant ou invalide (32 octets hex) — clés de jeux inaccessibles");
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function sealKey(cid: string, key: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(randomBytes(12));
  const ct = gcm(masterKey(), nonce, utf8(cid)).encrypt(key);
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce);
  out.set(ct, 12);
  return out;
}

function openKey(cid: string, sealed: Uint8Array): Uint8Array {
  return gcm(masterKey(), sealed.slice(0, 12), utf8(cid)).decrypt(sealed.slice(12));
}

// ── Content keys ───────────────────────────────────────────────────────

export interface ContentKeyRow {
  key: Uint8Array;
  publisher: string | null;
  studioId: string | null;
}

export function getContentKey(cid: string): ContentKeyRow | undefined {
  const row = db().prepare("SELECT key_enc, publisher, studio_id FROM content_keys WHERE cid = ?").get(cid) as
    | { key_enc: Uint8Array; publisher: string | null; studio_id: string | null }
    | undefined;
  if (!row) return undefined;
  return { key: openKey(cid, row.key_enc), publisher: row.publisher, studioId: row.studio_id };
}

export function putContentKey(cid: string, key: Uint8Array, publisher: string | null, studioId: string | null): void {
  db()
    .prepare("INSERT OR REPLACE INTO content_keys (cid, key_enc, publisher, studio_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(cid, sealKey(cid, key), publisher, studioId, Date.now());
}

// ── Nonces (persisted: a signed message can never be replayed) ─────────

let lastPurge = 0;

/** Throws if the nonce was already used; records it until `ttlMs` from now. */
export function consumeNonce(nonce: string, ttlMs: number): void {
  const now = Date.now();
  if (now - lastPurge > 60_000) {
    db().prepare("DELETE FROM nonces WHERE expires_at < ?").run(now);
    lastPurge = now;
  }
  const res = db().prepare("INSERT OR IGNORE INTO nonces (nonce, expires_at) VALUES (?, ?)").run(nonce, now + ttlMs);
  if (Number(res.changes) === 0) throw new Error("nonce déjà utilisé");
}

export function nonceUsed(nonce: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM nonces WHERE nonce = ?").get(nonce));
}

// ── Friends ────────────────────────────────────────────────────────────

const pair = (a: string, b: string): [string, string] => {
  const [lo, hi] = [a.toLowerCase(), b.toLowerCase()].sort();
  return [lo, hi];
};

export const friends = {
  since(a: string, b: string): number | undefined {
    const row = db().prepare("SELECT since FROM friendships WHERE lo = ? AND hi = ?").get(...pair(a, b)) as { since: number } | undefined;
    return row?.since;
  },
  set(a: string, b: string, sinceSec: number): void {
    db().prepare("INSERT OR REPLACE INTO friendships (lo, hi, since) VALUES (?, ?, ?)").run(...pair(a, b), sinceSec);
  },
  remove(a: string, b: string): void {
    db().prepare("DELETE FROM friendships WHERE lo = ? AND hi = ?").run(...pair(a, b));
  },
  count(a: string): number {
    const x = a.toLowerCase();
    return Number((db().prepare("SELECT COUNT(*) AS n FROM friendships WHERE lo = ? OR hi = ?").get(x, x) as { n: number }).n);
  },
  list(a: string): { addr: string; since: number }[] {
    const x = a.toLowerCase();
    return (db().prepare("SELECT lo, hi, since FROM friendships WHERE lo = ? OR hi = ?").all(x, x) as { lo: string; hi: string; since: number }[]).map(
      (r) => ({ addr: r.lo === x ? r.hi : r.lo, since: r.since }),
    );
  },
  request(from: string, to: string): void {
    db().prepare("INSERT OR REPLACE INTO friend_requests (from_addr, to_addr, at) VALUES (?, ?, ?)").run(from.toLowerCase(), to.toLowerCase(), Date.now());
  },
  hasRequest(from: string, to: string): boolean {
    return Boolean(db().prepare("SELECT 1 FROM friend_requests WHERE from_addr = ? AND to_addr = ?").get(from.toLowerCase(), to.toLowerCase()));
  },
  deleteRequest(from: string, to: string): void {
    db().prepare("DELETE FROM friend_requests WHERE from_addr = ? AND to_addr = ?").run(from.toLowerCase(), to.toLowerCase());
  },
  incoming(a: string): string[] {
    return (db().prepare("SELECT from_addr FROM friend_requests WHERE to_addr = ?").all(a.toLowerCase()) as { from_addr: string }[]).map((r) => r.from_addr);
  },
  outgoing(a: string): string[] {
    return (db().prepare("SELECT to_addr FROM friend_requests WHERE from_addr = ?").all(a.toLowerCase()) as { to_addr: string }[]).map((r) => r.to_addr);
  },
};

// ── Profiles & play stats ──────────────────────────────────────────────

export interface ProfileRow {
  name: string;
  avatarType: string | null;
  favorites: string[];
  updatedAt: number;
}

export const profiles = {
  get(addr: string): ProfileRow | undefined {
    const r = db().prepare("SELECT name, avatar_type, favorites, updated_at FROM profiles WHERE addr = ?").get(addr.toLowerCase()) as
      | { name: string; avatar_type: string | null; favorites: string; updated_at: number }
      | undefined;
    return r ? { name: r.name, avatarType: r.avatar_type, favorites: JSON.parse(r.favorites) as string[], updatedAt: r.updated_at } : undefined;
  },
  upsert(addr: string, p: ProfileRow): void {
    db()
      .prepare("INSERT OR REPLACE INTO profiles (addr, name, avatar_type, favorites, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(addr.toLowerCase(), p.name, p.avatarType, JSON.stringify(p.favorites), p.updatedAt);
  },
  /** Name lookup for a set of addresses (friends lists). */
  names(addrs: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const stmt = db().prepare("SELECT name FROM profiles WHERE addr = ?");
    for (const a of addrs.slice(0, 64)) {
      const r = stmt.get(a.toLowerCase()) as { name: string } | undefined;
      if (r) out[a.toLowerCase()] = r.name;
    }
    return out;
  },
  all(): { addr: string; name: string; hasAvatar: boolean }[] {
    return (db().prepare("SELECT addr, name, avatar_type FROM profiles").all() as { addr: string; name: string; avatar_type: string | null }[]).map(
      (r) => ({ addr: r.addr, name: r.name, hasAvatar: Boolean(r.avatar_type) }),
    );
  },
};

export const playstats = {
  add(addr: string, editionId: string, seconds: number): void {
    db()
      .prepare(
        "INSERT INTO playstats (addr, edition_id, seconds) VALUES (?, ?, ?) ON CONFLICT (addr, edition_id) DO UPDATE SET seconds = seconds + excluded.seconds",
      )
      .run(addr.toLowerCase(), editionId, seconds);
  },
  top(addr: string, limit = 8): { editionId: string; seconds: number }[] {
    return (db().prepare("SELECT edition_id, seconds FROM playstats WHERE addr = ? ORDER BY seconds DESC LIMIT ?").all(addr.toLowerCase(), limit) as {
      edition_id: string;
      seconds: number;
    }[]).map((r) => ({ editionId: r.edition_id, seconds: r.seconds }));
  },
};

// ── Devices ────────────────────────────────────────────────────────────

export interface DeviceRow {
  pubkey: string;
  pairedAt: number;
  lastSeen: number;
}

export const devices = {
  list(wallet: string): DeviceRow[] {
    return (db().prepare("SELECT pubkey, paired_at, last_seen FROM devices WHERE wallet = ? ORDER BY last_seen DESC").all(wallet.toLowerCase()) as {
      pubkey: string;
      paired_at: number;
      last_seen: number;
    }[]).map((r) => ({ pubkey: r.pubkey, pairedAt: r.paired_at, lastSeen: r.last_seen }));
  },
  get(wallet: string, pubkey: string): DeviceRow | undefined {
    return devices.list(wallet).find((d) => d.pubkey === pubkey.toLowerCase());
  },
  upsert(wallet: string, d: DeviceRow): void {
    db()
      .prepare("INSERT OR REPLACE INTO devices (wallet, pubkey, paired_at, last_seen) VALUES (?, ?, ?, ?)")
      .run(wallet.toLowerCase(), d.pubkey.toLowerCase(), d.pairedAt, d.lastSeen);
  },
  touch(wallet: string, pubkey: string, at: number): void {
    db().prepare("UPDATE devices SET last_seen = ? WHERE wallet = ? AND pubkey = ?").run(at, wallet.toLowerCase(), pubkey.toLowerCase());
  },
  remove(wallet: string, pubkey: string): void {
    db().prepare("DELETE FROM devices WHERE wallet = ? AND pubkey = ?").run(wallet.toLowerCase(), pubkey.toLowerCase());
  },
};
