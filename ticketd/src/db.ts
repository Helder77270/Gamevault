// ticketd persistence — repositories over sql.ts (SQLite by default,
// Postgres when DATABASE_URL is set; 2026-10-11). Every call is async.
//
// History: JSON files until 2026-10-07, then SQLite (audit T11/T12):
// atomic transactions, persisted nonces (no replay after a restart),
// content keys ENCRYPTED AT REST with a master key from the environment
// (AES-256-GCM, the CID bound as AAD so a ciphertext cannot be moved to
// another build). The same holds on Postgres.
//
// A backup (SQLite file or pg_dump) is useless without KEYSTORE_MASTER_KEY,
// and losing that key loses every game key: keep it OUTSIDE the servers.

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gcm } from "@noble/ciphers/aes";
import { openStore, store } from "./sql.ts";

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../data");

/** Opens the database (once, at start-up): Postgres if DATABASE_URL,
 *  otherwise data/ticketd.db — in memory for the selftest. */
export async function initDb(): Promise<void> {
  // selftest: in memory, unless GAMEVAULT_TEST_BACKENDS=1 (then DATABASE_URL)
  const inMemory = process.env.GAMEVAULT_SKIP_OWNER_CHECK === "1" && process.env.GAMEVAULT_TEST_BACKENDS !== "1";
  if (!inMemory && !process.env.DATABASE_URL) mkdirSync(DATA_DIR, { recursive: true });
  const s = await openStore({
    sqliteFile: inMemory ? ":memory:" : join(DATA_DIR, "ticketd.db"),
    databaseUrl: inMemory ? undefined : process.env.DATABASE_URL || undefined,
  });
  if (s.kind === "sqlite" && !inMemory) await importAvatarFiles();
}

/** Runs fn atomically. lockKey (Postgres): serializes the replicas working
 *  on the same entity — a wallet, a friendship pair. */
export const tx = <T>(fn: () => Promise<T>, lockKey?: string): Promise<T> => store().tx(fn, lockKey);

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

export async function getContentKey(cid: string): Promise<ContentKeyRow | undefined> {
  const row = await store().get<{ key_enc: Uint8Array; publisher: string | null; studio_id: string | null }>(
    "SELECT key_enc, publisher, studio_id FROM content_keys WHERE cid = ?",
    [cid],
  );
  if (!row) return undefined;
  return { key: openKey(cid, new Uint8Array(row.key_enc)), publisher: row.publisher, studioId: row.studio_id };
}

export async function putContentKey(cid: string, key: Uint8Array, publisher: string | null, studioId: string | null): Promise<void> {
  await store().run(
    `INSERT INTO content_keys (cid, key_enc, publisher, studio_id, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (cid) DO UPDATE SET key_enc = excluded.key_enc, publisher = excluded.publisher, studio_id = excluded.studio_id, created_at = excluded.created_at`,
    [cid, sealKey(cid, key), publisher, studioId, Date.now()],
  );
}

// ── Nonces (persisted: a signed message can never be replayed) ─────────

let lastPurge = 0;

/** Throws if the nonce was already used; records it until `ttlMs` from now.
 *  The primary key makes it atomic across replicas. */
export async function consumeNonce(nonce: string, ttlMs: number): Promise<void> {
  const now = Date.now();
  if (now - lastPurge > 60_000) {
    lastPurge = now;
    await store().run("DELETE FROM nonces WHERE expires_at < ?", [now]);
  }
  const res = await store().run("INSERT INTO nonces (nonce, expires_at) VALUES (?, ?) ON CONFLICT (nonce) DO NOTHING", [nonce, now + ttlMs]);
  if (res.changes === 0) throw new Error("nonce déjà utilisé");
}

export async function nonceUsed(nonce: string): Promise<boolean> {
  return Boolean(await store().get("SELECT 1 AS x FROM nonces WHERE nonce = ?", [nonce]));
}

// ── Friends ────────────────────────────────────────────────────────────

const pair = (a: string, b: string): [string, string] => {
  const [lo, hi] = [a.toLowerCase(), b.toLowerCase()].sort();
  return [lo, hi];
};

export const friends = {
  async since(a: string, b: string): Promise<number | undefined> {
    const row = await store().get<{ since: number }>("SELECT since FROM friendships WHERE lo = ? AND hi = ?", pair(a, b));
    return row ? Number(row.since) : undefined;
  },
  async set(a: string, b: string, sinceSec: number): Promise<void> {
    await store().run("INSERT INTO friendships (lo, hi, since) VALUES (?, ?, ?) ON CONFLICT (lo, hi) DO UPDATE SET since = excluded.since", [...pair(a, b), sinceSec]);
  },
  async remove(a: string, b: string): Promise<void> {
    await store().run("DELETE FROM friendships WHERE lo = ? AND hi = ?", pair(a, b));
  },
  async count(a: string): Promise<number> {
    const x = a.toLowerCase();
    return Number((await store().get<{ n: number }>("SELECT COUNT(*) AS n FROM friendships WHERE lo = ? OR hi = ?", [x, x]))?.n ?? 0);
  },
  async list(a: string): Promise<{ addr: string; since: number }[]> {
    const x = a.toLowerCase();
    const rows = await store().all<{ lo: string; hi: string; since: number }>("SELECT lo, hi, since FROM friendships WHERE lo = ? OR hi = ?", [x, x]);
    return rows.map((r) => ({ addr: r.lo === x ? r.hi : r.lo, since: Number(r.since) }));
  },
  async request(from: string, to: string): Promise<void> {
    await store().run(
      "INSERT INTO friend_requests (from_addr, to_addr, at) VALUES (?, ?, ?) ON CONFLICT (from_addr, to_addr) DO UPDATE SET at = excluded.at",
      [from.toLowerCase(), to.toLowerCase(), Date.now()],
    );
  },
  async hasRequest(from: string, to: string): Promise<boolean> {
    return Boolean(await store().get("SELECT 1 AS x FROM friend_requests WHERE from_addr = ? AND to_addr = ?", [from.toLowerCase(), to.toLowerCase()]));
  },
  async deleteRequest(from: string, to: string): Promise<void> {
    await store().run("DELETE FROM friend_requests WHERE from_addr = ? AND to_addr = ?", [from.toLowerCase(), to.toLowerCase()]);
  },
  async incoming(a: string): Promise<string[]> {
    return (await store().all<{ from_addr: string }>("SELECT from_addr FROM friend_requests WHERE to_addr = ?", [a.toLowerCase()])).map((r) => r.from_addr);
  },
  async outgoing(a: string): Promise<string[]> {
    return (await store().all<{ to_addr: string }>("SELECT to_addr FROM friend_requests WHERE from_addr = ?", [a.toLowerCase()])).map((r) => r.to_addr);
  },
};

// ── Profiles & play stats ──────────────────────────────────────────────

export interface ProfileRow {
  name: string;
  avatarType: string | null;
  favorites: string[];
  bio: string;
  updatedAt: number;
  createdAt: number | null;
}

type ProfileDbRow = { name: string; avatar_type: string | null; favorites: string; bio: string; updated_at: number; created_at: number | null };

export const profiles = {
  async get(addr: string): Promise<ProfileRow | undefined> {
    const r = await store().get<ProfileDbRow>("SELECT name, avatar_type, favorites, bio, updated_at, created_at FROM profiles WHERE addr = ?", [addr.toLowerCase()]);
    return r
      ? {
          name: r.name,
          avatarType: r.avatar_type,
          favorites: JSON.parse(r.favorites) as string[],
          bio: r.bio,
          updatedAt: Number(r.updated_at),
          createdAt: r.created_at === null ? null : Number(r.created_at),
        }
      : undefined;
  },
  /** created_at is set on the first save only ("member since"). */
  async upsert(addr: string, p: Omit<ProfileRow, "createdAt">): Promise<void> {
    await store().run(
      `INSERT INTO profiles (addr, name, avatar_type, favorites, bio, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (addr) DO UPDATE SET name = excluded.name, avatar_type = excluded.avatar_type,
         favorites = excluded.favorites, bio = excluded.bio, updated_at = excluded.updated_at,
         created_at = COALESCE(profiles.created_at, excluded.created_at)`,
      [addr.toLowerCase(), p.name, p.avatarType, JSON.stringify(p.favorites), p.bio, p.updatedAt, p.updatedAt],
    );
  },
  /** Name + avatar flag for a set of addresses (friends lists, sellers). */
  async people(addrs: string[]): Promise<Record<string, { name: string; hasAvatar: boolean }>> {
    const list = [...new Set(addrs.slice(0, 64).map((a) => a.toLowerCase()))];
    if (!list.length) return {};
    const rows = await store().all<{ addr: string; name: string; avatar_type: string | null }>(
      `SELECT addr, name, avatar_type FROM profiles WHERE addr IN (${list.map(() => "?").join(", ")})`,
      list,
    );
    return Object.fromEntries(rows.map((r) => [r.addr, { name: r.name, hasAvatar: Boolean(r.avatar_type) }]));
  },
  async search(query: string, byAddr: boolean): Promise<{ addr: string; name: string; hasAvatar: boolean }[]> {
    // name matching ignores accents in JS (portable); the table stays small
    // (one row per player) — move to a trigram index past ~100k profiles
    const rows = byAddr
      ? await store().all<{ addr: string; name: string; avatar_type: string | null }>("SELECT addr, name, avatar_type FROM profiles WHERE addr LIKE ? LIMIT 10", [`${query.toLowerCase()}%`])
      : await store().all<{ addr: string; name: string; avatar_type: string | null }>("SELECT addr, name, avatar_type FROM profiles");
    return rows.map((r) => ({ addr: r.addr, name: r.name, hasAvatar: Boolean(r.avatar_type) }));
  },
};

export const avatars = {
  async get(addr: string): Promise<{ bytes: Uint8Array; type: string } | undefined> {
    const r = await store().get<{ type: string; bytes: Uint8Array }>("SELECT type, bytes FROM avatars WHERE addr = ?", [addr.toLowerCase()]);
    return r ? { type: r.type, bytes: new Uint8Array(r.bytes) } : undefined;
  },
  async put(addr: string, type: string, bytes: Uint8Array): Promise<void> {
    await store().run(
      "INSERT INTO avatars (addr, type, bytes, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (addr) DO UPDATE SET type = excluded.type, bytes = excluded.bytes, updated_at = excluded.updated_at",
      [addr.toLowerCase(), type, bytes, Date.now()],
    );
  },
  async remove(addr: string): Promise<void> {
    await store().run("DELETE FROM avatars WHERE addr = ?", [addr.toLowerCase()]);
  },
};

/** Avatars used to be files (data/avatars/<addr>); copied into the table
 *  once, the files are left in place as a fallback copy. */
async function importAvatarFiles(): Promise<void> {
  const dir = join(DATA_DIR, "avatars");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!/^0x[0-9a-f]{40}$/.test(name)) continue;
    const p = await profiles.get(name);
    if (!p?.avatarType || (await avatars.get(name))) continue;
    await avatars.put(name, p.avatarType, new Uint8Array(readFileSync(join(dir, name))));
    console.log(`✔ avatar ${name} importé dans la base`);
  }
}

export const playstats = {
  async total(addr: string): Promise<number> {
    return Number((await store().get<{ s: number }>("SELECT COALESCE(SUM(seconds), 0) AS s FROM playstats WHERE addr = ?", [addr.toLowerCase()]))?.s ?? 0);
  },
  async add(addr: string, editionId: string, seconds: number): Promise<void> {
    await store().run(
      "INSERT INTO playstats (addr, edition_id, seconds) VALUES (?, ?, ?) ON CONFLICT (addr, edition_id) DO UPDATE SET seconds = playstats.seconds + excluded.seconds",
      [addr.toLowerCase(), editionId, seconds],
    );
  },
  async top(addr: string, limit = 8): Promise<{ editionId: string; seconds: number }[]> {
    const rows = await store().all<{ edition_id: string; seconds: number }>("SELECT edition_id, seconds FROM playstats WHERE addr = ? ORDER BY seconds DESC LIMIT ?", [addr.toLowerCase(), limit]);
    return rows.map((r) => ({ editionId: r.edition_id, seconds: Number(r.seconds) }));
  },
};

// ── Wishlist ───────────────────────────────────────────────────────────

export interface WishRow {
  editionId: string;
  seenWei: string;
  at: number;
}

export const wishlist = {
  async list(addr: string): Promise<WishRow[]> {
    const rows = await store().all<{ edition_id: string; seen_wei: string; at: number }>("SELECT edition_id, seen_wei, at FROM wishlist WHERE addr = ? ORDER BY at DESC", [addr.toLowerCase()]);
    return rows.map((r) => ({ editionId: r.edition_id, seenWei: r.seen_wei, at: Number(r.at) }));
  },
  async count(addr: string): Promise<number> {
    return Number((await store().get<{ n: number }>("SELECT COUNT(*) AS n FROM wishlist WHERE addr = ?", [addr.toLowerCase()]))?.n ?? 0);
  },
  /** Adding again keeps the original date; the seen price is refreshed. */
  async put(addr: string, editionId: string, seenWei: string): Promise<void> {
    await store().run(
      "INSERT INTO wishlist (addr, edition_id, seen_wei, at) VALUES (?, ?, ?, ?) ON CONFLICT (addr, edition_id) DO UPDATE SET seen_wei = excluded.seen_wei",
      [addr.toLowerCase(), editionId, seenWei, Date.now()],
    );
  },
  async remove(addr: string, editionId: string): Promise<void> {
    await store().run("DELETE FROM wishlist WHERE addr = ? AND edition_id = ?", [addr.toLowerCase(), editionId]);
  },
  async seen(addr: string, editionId: string, seenWei: string): Promise<void> {
    await store().run("UPDATE wishlist SET seen_wei = ? WHERE addr = ? AND edition_id = ?", [seenWei, addr.toLowerCase(), editionId]);
  },
};

// ── Privacy ────────────────────────────────────────────────────────────

export type PrivacyLevel = "public" | "friends" | "private";
export const PRIVACY_SECTIONS = ["profile", "presence", "activity", "library"] as const;
export type Privacy = Record<(typeof PRIVACY_SECTIONS)[number], PrivacyLevel>;
const LEVELS: PrivacyLevel[] = ["public", "friends", "private"];

export const privacy = {
  async get(addr: string): Promise<Privacy> {
    const row = await store().get<{ data: string }>("SELECT data FROM privacy WHERE addr = ?", [addr.toLowerCase()]);
    const saved = (row ? JSON.parse(row.data) : {}) as Partial<Record<string, string>>;
    const out = {} as Privacy;
    for (const s of PRIVACY_SECTIONS) out[s] = LEVELS.includes(saved[s] as PrivacyLevel) ? (saved[s] as PrivacyLevel) : "public";
    return out;
  },
  async set(addr: string, p: Privacy): Promise<void> {
    await store().run(
      "INSERT INTO privacy (addr, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (addr) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      [addr.toLowerCase(), JSON.stringify(p), Date.now()],
    );
  },
};

// ── Devices ────────────────────────────────────────────────────────────

export interface DeviceRow {
  pubkey: string;
  pairedAt: number;
  lastSeen: number;
}

export const devices = {
  async list(wallet: string): Promise<DeviceRow[]> {
    const rows = await store().all<{ pubkey: string; paired_at: number; last_seen: number }>(
      "SELECT pubkey, paired_at, last_seen FROM devices WHERE wallet = ? ORDER BY last_seen DESC",
      [wallet.toLowerCase()],
    );
    return rows.map((r) => ({ pubkey: r.pubkey, pairedAt: Number(r.paired_at), lastSeen: Number(r.last_seen) }));
  },
  async get(wallet: string, pubkey: string): Promise<DeviceRow | undefined> {
    return (await devices.list(wallet)).find((d) => d.pubkey === pubkey.toLowerCase());
  },
  async upsert(wallet: string, d: DeviceRow): Promise<void> {
    await store().run(
      "INSERT INTO devices (wallet, pubkey, paired_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT (wallet, pubkey) DO UPDATE SET paired_at = excluded.paired_at, last_seen = excluded.last_seen",
      [wallet.toLowerCase(), d.pubkey.toLowerCase(), d.pairedAt, d.lastSeen],
    );
  },
  async touch(wallet: string, pubkey: string, at: number): Promise<void> {
    await store().run("UPDATE devices SET last_seen = ? WHERE wallet = ? AND pubkey = ?", [at, wallet.toLowerCase(), pubkey.toLowerCase()]);
  },
  async remove(wallet: string, pubkey: string): Promise<void> {
    await store().run("DELETE FROM devices WHERE wallet = ? AND pubkey = ?", [wallet.toLowerCase(), pubkey.toLowerCase()]);
  },
};

// ── Sessions (one wallet signature, or the launcher's device key) ───────

let lastSessionPurge = 0;

export const sessions = {
  async put(tokenHash: string, wallet: string, device: string | null, expiresAt: number): Promise<void> {
    const now = Date.now();
    if (now - lastSessionPurge > 60_000) {
      lastSessionPurge = now;
      await store().run("DELETE FROM sessions WHERE expires_at < ?", [now]);
    }
    await store().run("INSERT INTO sessions (token_hash, wallet, device, expires_at) VALUES (?, ?, ?, ?)", [
      tokenHash,
      wallet.toLowerCase(),
      device ? device.toLowerCase() : null,
      expiresAt,
    ]);
  },
  async get(tokenHash: string): Promise<{ wallet: string; device: string | null; expiresAt: number } | undefined> {
    const r = await store().get<{ wallet: string; device: string | null; expires_at: number }>("SELECT wallet, device, expires_at FROM sessions WHERE token_hash = ?", [tokenHash]);
    if (!r || Number(r.expires_at) < Date.now()) return undefined;
    return { wallet: r.wallet, device: r.device, expiresAt: Number(r.expires_at) };
  },
  async remove(tokenHash: string): Promise<void> {
    await store().run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
  },
  /** A revoked device loses its launcher sessions at once. */
  async removeDevice(wallet: string, device: string): Promise<void> {
    await store().run("DELETE FROM sessions WHERE wallet = ? AND device = ?", [wallet.toLowerCase(), device.toLowerCase()]);
  },
};

// ── Activity feed (public, newest first) ────────────────────────────────

export const activity = {
  async add(wallet: string, kind: string, data: Record<string, unknown>): Promise<void> {
    await store().run("INSERT INTO activity (wallet, kind, data, at) VALUES (?, ?, ?, ?)", [wallet.toLowerCase(), kind, JSON.stringify(data), Date.now()]);
  },
  async recent(wallet: string, limit = 12): Promise<{ kind: string; data: Record<string, unknown>; at: number }[]> {
    const rows = await store().all<{ kind: string; data: string; at: number }>("SELECT kind, data, at FROM activity WHERE wallet = ? ORDER BY id DESC LIMIT ?", [wallet.toLowerCase(), limit]);
    return rows.map((r) => ({ kind: r.kind, data: JSON.parse(r.data) as Record<string, unknown>, at: Number(r.at) }));
  },
};

// ── Studio public pages (description, links, team) ──────────────────────

export interface StudioPage {
  description: string;
  links: { label: string; url: string }[];
  team: { name: string; role: string; wallet: string | null }[];
  updatedAt: number;
}

export const studioPages = {
  async get(studioId: string): Promise<StudioPage | undefined> {
    const r = await store().get<{ description: string; links: string; team: string; updated_at: number }>(
      "SELECT description, links, team, updated_at FROM studio_pages WHERE studio_id = ?",
      [studioId],
    );
    return r ? { description: r.description, links: JSON.parse(r.links), team: JSON.parse(r.team), updatedAt: Number(r.updated_at) } : undefined;
  },
  async put(studioId: string, p: Omit<StudioPage, "updatedAt">, by: string): Promise<void> {
    await store().run(
      `INSERT INTO studio_pages (studio_id, description, links, team, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (studio_id) DO UPDATE SET description = excluded.description, links = excluded.links, team = excluded.team,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [studioId, p.description, JSON.stringify(p.links), JSON.stringify(p.team), Date.now(), by.toLowerCase()],
    );
  },
};

// ── Chat between friends ───────────────────────────────────────────────

export interface ChatMessage {
  id: number;
  from: string;
  to: string;
  kind: string;
  body: string;
  at: number;
  readAt: number | null;
}

type MessageRow = { id: number; from_addr: string; to_addr: string; kind: string; body: string; at: number; read_at: number | null };

const conv = (a: string, b: string): string => pair(a, b).join("|");
const toMessage = (r: MessageRow): ChatMessage => ({
  id: Number(r.id),
  from: r.from_addr,
  to: r.to_addr,
  kind: r.kind,
  body: r.body,
  at: Number(r.at),
  readAt: r.read_at === null ? null : Number(r.read_at),
});

export const messages = {
  async add(from: string, to: string, kind: string, body: string): Promise<ChatMessage> {
    const at = Date.now();
    const row = await store().get<{ id: number }>("INSERT INTO messages (conv, from_addr, to_addr, kind, body, at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", [
      conv(from, to),
      from.toLowerCase(),
      to.toLowerCase(),
      kind,
      body,
      at,
    ]);
    return { id: Number(row?.id), from: from.toLowerCase(), to: to.toLowerCase(), kind, body, at, readAt: null };
  },
  /** Messages after `afterId` (oldest first), at most the last `limit`. */
  async thread(a: string, b: string, afterId = 0, limit = 60): Promise<ChatMessage[]> {
    const rows = await store().all<MessageRow>(
      "SELECT id, from_addr, to_addr, kind, body, at, read_at FROM messages WHERE conv = ? AND id > ? ORDER BY id DESC LIMIT ?",
      [conv(a, b), afterId, limit],
    );
    return rows.map(toMessage).reverse();
  },
  async markRead(reader: string, other: string, upToId: number): Promise<void> {
    await store().run("UPDATE messages SET read_at = ? WHERE conv = ? AND to_addr = ? AND id <= ? AND read_at IS NULL", [
      Date.now(),
      conv(reader, other),
      reader.toLowerCase(),
      upToId,
    ]);
  },
  /** Per counterpart: last message + unread count, for the friends list. */
  async summary(wallet: string): Promise<{ other: string; last: ChatMessage; unread: number }[]> {
    const me = wallet.toLowerCase();
    const rows = await store().all<MessageRow & { unread: number }>(
      `SELECT m.id, m.from_addr, m.to_addr, m.kind, m.body, m.at, m.read_at,
         (SELECT COUNT(*) FROM messages u WHERE u.conv = m.conv AND u.to_addr = ? AND u.read_at IS NULL) AS unread
       FROM messages m
       WHERE m.id IN (SELECT MAX(id) FROM messages WHERE from_addr = ? OR to_addr = ? GROUP BY conv)
       ORDER BY m.id DESC`,
      [me, me, me],
    );
    return rows.map((r) => ({ other: r.from_addr === me ? r.to_addr : r.from_addr, last: toMessage(r), unread: Number(r.unread) }));
  },
};
