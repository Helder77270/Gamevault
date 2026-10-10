// Social layer (v1, 2026-10-08) — everything OFF-CHAIN, zero gas.
//
// AUTH: one wallet signature opens a 24 h SESSION on the web; the launcher
// opens its session with the paired DEVICE KEY (no wallet in the launcher).
// Social actions (friends, profile, chat, presence) then use
// `Authorization: Bearer <token>` — no signature per action. What moves
// value or keys stays signed per action: pairing (/ticket), studio publish,
// device revoke.
//
// Profiles are PUBLIC by default (Steam-like): bio, favorites, play time,
// friends, activity. Each section can be narrowed to friends or to nobody
// (P7 B privacy); name and avatar stay visible so people can be recognised.
// Licence ownership stays public ON-CHAIN whatever is chosen here — only
// the social layer hides. Chat is between friends only, stored here (not
// end-to-end).
//
// Scale-out (2026-10-11): durable data in db.ts (SQLite or Postgres),
// presence / events / rate limits in live.ts (memory or Redis). The SSE
// streams themselves stay in the process that accepted them; events reach
// them through live().publish, whichever replica produced the event.

import type { ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { verifyMessage } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import {
  activity,
  avatars,
  consumeNonce,
  devices,
  friends,
  messages,
  nonceUsed,
  playstats,
  privacy,
  profiles,
  PRIVACY_SECTIONS,
  type Privacy,
  type PrivacyLevel,
  sessions,
  studioPages,
  tx,
  wishlist,
  type ChatMessage,
  type StudioPage,
} from "./db.ts";
import { live } from "./live.ts";
import { studioOwner, studiosOwnedBy } from "./service.ts";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const DEVICE_RE = /^0x0[23][0-9a-fA-F]{64}$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const MESSAGE_MAX_AGE_MS = 10 * 60 * 1000;
const NONCE_TTL_MS = MESSAGE_MAX_AGE_MS * 2;
const SESSION_TTL_MS = 24 * 3600 * 1000;
const MAX_FRIENDS = 16; // players (anti-farm: a lending ring needs many "friends")
const MAX_FRIENDS_STUDIO = 500; // studios: they invite, players can't spam them

const lc = (a: string): string => a.toLowerCase();
const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

function fresh(atMs: number): void {
  const age = Date.now() - atMs;
  if (!Number.isFinite(age) || age < -60_000 || age > MESSAGE_MAX_AGE_MS) throw new Error("message expiré");
}

/** Strict "Header\nkey: value…" parse, then rebuild and compare. */
function parseLines(message: string, header: string, keys: string[]): Record<string, string> {
  const lines = message.split("\n");
  if (lines.length !== keys.length + 1 || lines[0] !== header) throw new Error("message inattendu");
  const v: Record<string, string> = {};
  keys.forEach((k, i) => {
    const l = lines[i + 1];
    if (!l.startsWith(`${k}: `)) throw new Error(`champ ${k} attendu`);
    v[k] = l.slice(k.length + 2);
  });
  if ([header, ...keys.map((k) => `${k}: ${v[k]}`)].join("\n") !== message) throw new Error("message non canonique");
  return v;
}

async function issueSession(wallet: string, device: string | null): Promise<{ token: string; wallet: string; expiresAt: number }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await sessions.put(tokenHash(token), wallet, device, expiresAt);
  return { token, wallet: lc(wallet), expiresAt };
}

// ── Sessions ───────────────────────────────────────────────────────────

/** Web: GameVault Session\nme: 0x…\nat: ISO\nnonce: uuid — signed by the wallet. */
export async function openWebSession(message: string, signature: `0x${string}`): Promise<{ token: string; wallet: string; expiresAt: number }> {
  const f = parseLines(message, "GameVault Session", ["me", "at", "nonce"]);
  if (!ADDR_RE.test(f.me) || !UUID_RE.test(f.nonce)) throw new Error("message invalide");
  fresh(Date.parse(f.at));
  if (await nonceUsed(f.nonce)) throw new Error("nonce déjà utilisé");
  if (!(await verifyMessage({ address: f.me as `0x${string}`, message, signature }))) throw new Error("signature invalide");
  await consumeNonce(f.nonce, NONCE_TTL_MS);
  return issueSession(f.me, null);
}

/** Launcher: GameVault Device Session\nwallet\ndevice\nat: <ms>\nnonce: <hex>,
 *  signed by the DEVICE key in the Rust core (compact secp256k1 over sha256).
 *  The device must be registered to that wallet (it paired a ticket). */
export async function openDeviceSession(message: string, signatureHex: string): Promise<{ token: string; wallet: string; expiresAt: number }> {
  const f = parseLines(message, "GameVault Device Session", ["wallet", "device", "at", "nonce"]);
  if (!ADDR_RE.test(f.wallet) || !DEVICE_RE.test(f.device) || !/^[0-9a-f]{32}$/.test(f.nonce)) throw new Error("message invalide");
  fresh(Number(f.at));
  if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) throw new Error("signature invalide");
  const ok = secp256k1.verify(
    Uint8Array.from(Buffer.from(signatureHex, "hex")),
    sha256(new TextEncoder().encode(message)),
    Uint8Array.from(Buffer.from(f.device.slice(2), "hex")),
  );
  if (!ok) throw new Error("signature d'appareil invalide");
  if (!(await devices.get(f.wallet, f.device))) throw new Error("appareil non appairé à ce compte");
  if (await nonceUsed(f.nonce)) throw new Error("nonce déjà utilisé");
  await consumeNonce(f.nonce, NONCE_TTL_MS);
  return issueSession(f.wallet, f.device);
}

export class Unauthorized extends Error {}

/** Wallet behind `Authorization: Bearer <token>` (or ?token= for SSE). */
export async function authWallet(bearer: string | undefined): Promise<{ wallet: string; device: string | null }> {
  const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : bearer;
  if (!token) throw new Unauthorized("session requise");
  const s = await sessions.get(tokenHash(token));
  if (!s) throw new Unauthorized("session expirée — reconnectez-vous");
  return { wallet: s.wallet, device: s.device };
}

export async function closeSession(bearer: string | undefined): Promise<{ ok: true }> {
  const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : bearer;
  if (token) await sessions.remove(tokenHash(token));
  return { ok: true };
}

// ── Presence (online = heartbeat < 90 s; live.ts: memory or Redis) ──────

const PRESENCE_TTL_MS = 90_000;
type PresenceState = { state: "offline" | "online" | "playing"; editionId: string | null };
const OFFLINE: PresenceState = { state: "offline", editionId: null };
const asPresence = (rec: { playing: string | null } | undefined): PresenceState =>
  !rec ? OFFLINE : rec.playing ? { state: "playing", editionId: rec.playing } : { state: "online", editionId: null };

export async function setPresence(wallet: string, playing: string | null): Promise<{ ok: true }> {
  if (playing !== null && !/^\d{1,6}$/.test(playing)) throw new Error("édition invalide");
  const prev = await live().presenceSet(lc(wallet), { playing }, PRESENCE_TTL_MS);
  if ((prev === undefined || prev.playing !== playing) && (await privacy.get(wallet)).presence !== "private") {
    await notifyFriends(wallet, "presence", { addr: lc(wallet), ...asPresence({ playing }) });
  }
  return { ok: true };
}

export async function presenceOf(wallet: string): Promise<PresenceState> {
  return asPresence((await live().presenceGet([lc(wallet)])).get(lc(wallet)));
}

/** Presence as `viewer` may see it (hidden = shown offline). */
export async function presenceFor(wallet: string, viewer: string | null): Promise<PresenceState> {
  return (await canSee(wallet, viewer, (await privacy.get(wallet)).presence)) ? presenceOf(wallet) : OFFLINE;
}

// ── Privacy ────────────────────────────────────────────────────────────

/** May `viewer` (null = not signed in) see a section `owner` set to `level`? */
async function canSee(owner: string, viewer: string | null, level: PrivacyLevel): Promise<boolean> {
  if (viewer && lc(viewer) === lc(owner)) return true;
  if (level === "public") return true;
  if (level === "friends") return Boolean(viewer && (await friends.since(owner, viewer)));
  return false;
}

async function visibility(owner: string, viewer: string | null): Promise<Record<keyof Privacy, boolean>> {
  const p = await privacy.get(owner);
  const out = {} as Record<keyof Privacy, boolean>;
  for (const s of PRIVACY_SECTIONS) out[s] = await canSee(owner, viewer, p[s]);
  return out;
}

export async function privacyOf(me: string): Promise<Privacy> {
  return privacy.get(me);
}

export async function setPrivacy(me: string, body: Record<string, unknown>): Promise<Privacy> {
  const next = await privacy.get(me);
  for (const s of PRIVACY_SECTIONS) {
    if (body[s] === undefined) continue;
    const v = String(body[s]);
    if (v !== "public" && v !== "friends" && v !== "private") throw new Error(`niveau invalide pour ${s}`);
    next[s] = v;
  }
  await privacy.set(me, next);
  // going invisible: friends see this account offline right away
  if (next.presence === "private") await notifyFriends(me, "presence", { addr: lc(me), ...OFFLINE });
  return next;
}

// ── Live stream (Server-Sent Events) ───────────────────────────────────
// One open response per launcher / browser tab, held by THIS process.
// Events go through live().publish, so the replica that holds the stream
// delivers them (Redis pub/sub when several replicas run).

const streams = new Map<string, Set<ServerResponse>>();

export function subscribe(wallet: string, res: ServerResponse): void {
  const set = streams.get(lc(wallet)) ?? new Set();
  set.add(res);
  streams.set(lc(wallet), set);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    set.delete(res);
    if (set.size === 0) streams.delete(lc(wallet));
  });
}

/** live.ts calls this for every event (local or from another replica). */
export function deliverLocal(wallet: string, event: string, data: unknown): void {
  for (const res of streams.get(lc(wallet)) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Open streams of this process (graceful shutdown, metrics). */
export function openStreams(): { wallets: number; streams: number; closeAll: () => void } {
  let n = 0;
  for (const s of streams.values()) n += s.size;
  return {
    wallets: streams.size,
    streams: n,
    closeAll: () => {
      for (const s of streams.values()) for (const res of s) res.end(); // clients (EventSource) reconnect to another replica
    },
  };
}

/** Best effort: a live event that can't be published (Redis down) never
 *  fails the action itself — the data is saved, clients catch up on reload. */
async function push(wallet: string, event: string, data: unknown): Promise<void> {
  try {
    await live().publish(lc(wallet), event, data);
  } catch (e) {
    console.warn(`⚠ événement ${event} non diffusé : ${e instanceof Error ? e.message : e}`);
  }
}

async function notifyFriends(wallet: string, event: string, data: unknown): Promise<void> {
  await Promise.all((await friends.list(wallet)).map((f) => push(f.addr, event, data)));
}

// ── Friends (session) ──────────────────────────────────────────────────

const FRIEND_ACTIONS = ["request", "accept", "decline", "cancel", "remove"] as const;

/** Studios are protected from unsolicited requests: between a studio account
 *  and a player, only the STUDIO can send the friend request. Two studios
 *  stay free to add each other. Existing friendships are untouched. */
async function assertMayRequest(me: string, other: string): Promise<void> {
  const [mine, theirs] = await Promise.all([studiosOwnedBy(me), studiosOwnedBy(other)]);
  if (theirs.length > 0 && mine.length === 0) {
    throw new Error("les studios ne reçoivent pas de demandes d'amis : c'est le studio qui envoie l'invitation");
  }
}

export async function friendAction(me: string, action: string, other: string): Promise<{ ok: true }> {
  if (!(FRIEND_ACTIONS as readonly string[]).includes(action)) throw new Error("action inconnue");
  if (!ADDR_RE.test(other)) throw new Error("adresse invalide");
  if (lc(me) === lc(other)) throw new Error("pas d'amitié avec soi-même");
  if (action === "request") await assertMayRequest(me, other);
  const capOf = async (a: string) => ((await studiosOwnedBy(a)).length > 0 ? MAX_FRIENDS_STUDIO : MAX_FRIENDS);
  const [capMe, capOther] = action === "accept" ? await Promise.all([capOf(me), capOf(other)]) : [MAX_FRIENDS, MAX_FRIENDS];
  // the caps count both accounts' friends: serialize on the two wallets
  await tx(
    async () => {
      if (action === "request") {
        if (await friends.since(me, other)) throw new Error("déjà amis");
        await friends.request(me, other);
      } else if (action === "accept") {
        if (!(await friends.hasRequest(other, me))) throw new Error("aucune demande de cette adresse");
        // Anti-farm cap (audit T10), raised for studio accounts
        if ((await friends.count(me)) >= capMe) throw new Error(`limite de ${capMe} amis atteinte`);
        if ((await friends.count(other)) >= capOther) throw new Error(`cet ami a atteint sa limite de ${capOther} amis`);
        await friends.deleteRequest(other, me);
        await friends.deleteRequest(me, other);
        await friends.set(me, other, Math.floor(Date.now() / 1000));
        await activity.add(me, "friend", { with: lc(other) });
        await activity.add(other, "friend", { with: lc(me) });
      } else if (action === "decline") {
        await friends.deleteRequest(other, me);
      } else if (action === "cancel") {
        await friends.deleteRequest(me, other);
      } else {
        await friends.remove(me, other);
      }
    },
    `friends:${[lc(me), lc(other)].sort().join("|")}`,
  );
  await push(other, "friends", { from: lc(me), action });
  console.log(`✔ amis: ${action} ${me} <-> ${other}`);
  return { ok: true };
}

type Person = { addr: string; name: string | null; hasAvatar: boolean };

/** Studios owned by an address, for badges and the request rule in the UI. */
export async function studioAccount(addr: string): Promise<{ id: string; name: string }[]> {
  if (!ADDR_RE.test(addr)) throw new Error("adresse invalide");
  return studiosOwnedBy(addr);
}

async function people(addrs: string[]): Promise<Person[]> {
  const known = await profiles.people(addrs);
  return addrs.map((a) => ({ addr: lc(a), name: known[lc(a)]?.name ?? null, hasAvatar: known[lc(a)]?.hasAvatar ?? false }));
}

export async function friendsOf(
  addr: string,
  viewer: string | null = null,
): Promise<{ friends: (Person & { since: number; presence: PresenceState })[]; incoming: Person[]; outgoing: Person[] }> {
  if (!ADDR_RE.test(addr)) throw new Error("adresse invalide");
  // friends and pending requests belong to the "profile" section
  if (!(await canSee(addr, viewer, (await privacy.get(addr)).profile))) return { friends: [], incoming: [], outgoing: [] };
  const list = await friends.list(addr);
  const info = new Map((await people(list.map((f) => f.addr))).map((p) => [p.addr, p]));
  return {
    friends: await Promise.all(list.map(async (f) => ({ ...info.get(lc(f.addr))!, since: f.since, presence: await presenceFor(f.addr, viewer) }))),
    incoming: await people(await friends.incoming(addr)),
    outgoing: await people(await friends.outgoing(addr)),
  };
}

// ── Profiles (public read, session write) ──────────────────────────────

const AVATAR_MAX_BYTES = 300 * 1024;
const AVATAR_MIN_BYTES = 256;
const NAME_RE = /^[\p{L}\p{N} _.\-]{2,24}$/u;
const BIO_MAX = 500;

function avatarKind(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return "image/png";
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/** avatar: "keep" | "none" | base64 image (resized client-side to 256 px).
 *  Avatars live in the database (every replica serves them). */
export async function saveProfile(me: string, body: { name?: unknown; bio?: unknown; favorites?: unknown; avatar?: unknown }): Promise<{ ok: true }> {
  const name = String(body.name ?? "").trim();
  if (!NAME_RE.test(name)) throw new Error("pseudo invalide (2-24 caractères, lettres/chiffres/espaces/-_.)");
  const bio = String(body.bio ?? "").replace(/\r\n/g, "\n").trim();
  if (bio.length > BIO_MAX) throw new Error(`bio trop longue (${BIO_MAX} caractères max)`);
  const favorites = (Array.isArray(body.favorites) ? body.favorites : [])
    .map(String)
    .filter((s) => /^\d{1,6}$/.test(s))
    .slice(0, 12);
  const avatar = String(body.avatar ?? "keep");

  await tx(async () => {
    let avatarType = (await profiles.get(me))?.avatarType ?? null;
    if (avatar === "none") {
      avatarType = null;
      await avatars.remove(me);
    } else if (avatar !== "keep") {
      const bytes = Buffer.from(avatar, "base64");
      if (bytes.length > AVATAR_MAX_BYTES) throw new Error(`avatar trop lourd (max ${AVATAR_MAX_BYTES / 1024} Ko)`);
      if (bytes.length < AVATAR_MIN_BYTES) throw new Error("avatar trop petit pour être une image");
      const kind = avatarKind(bytes);
      if (!kind) throw new Error("avatar: formats acceptés jpeg/png/webp");
      await avatars.put(me, kind, new Uint8Array(bytes));
      avatarType = kind;
    }
    await profiles.upsert(me, { name, avatarType, favorites, bio, updatedAt: Date.now() });
  }, `profile:${lc(me)}`);
  console.log(`✔ profil: ${me} -> « ${name} »`);
  return { ok: true };
}

export async function getAvatar(addr: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  if (!ADDR_RE.test(addr)) return null;
  return (await avatars.get(addr)) ?? null;
}

/** The profile as `viewer` may see it (null = not signed in). On-chain
 *  parts (licences, listings, loans) are read by the web page from the
 *  subgraph; `visible.library` tells it whether to show them. */
export async function getProfile(addr: string, viewer: string | null = null) {
  if (!ADDR_RE.test(addr)) throw new Error("adresse invalide");
  const p = await profiles.get(addr);
  const vis = await visibility(addr, viewer);
  const friendList = vis.profile ? await friends.list(addr) : [];
  const recent = vis.activity ? await activity.recent(addr) : [];
  const names = await profiles.people(recent.flatMap((a) => (typeof a.data.with === "string" ? [a.data.with] : [])));
  return {
    addr,
    name: p?.name ?? null,
    hasAvatar: Boolean(p?.avatarType),
    bio: vis.profile ? (p?.bio ?? "") : "",
    favorites: vis.profile ? (p?.favorites ?? []) : [],
    memberSince: vis.profile ? (p?.createdAt ?? null) : null,
    presence: vis.presence ? await presenceOf(addr) : OFFLINE,
    topPlayed: vis.activity ? await playstats.top(addr, 8) : [],
    totalSeconds: vis.activity ? await playstats.total(addr) : null,
    devicesCount: vis.profile ? (await devices.list(addr)).length : null,
    friendsCount: vis.profile ? friendList.length : null,
    friends: await people(friendList.slice(0, 12).map((f) => f.addr)),
    activity: recent.map((a) => ({
      ...a,
      data: typeof a.data.with === "string" ? { ...a.data, withName: names[a.data.with]?.name ?? null } : a.data,
    })),
    privacy: await privacy.get(addr),
    visible: vis,
    updatedAt: p?.updatedAt ?? null,
  };
}

/** Names for a list of addresses (sellers, team members, chat). */
export async function namesOf(addrs: string[]): Promise<Record<string, { name: string | null; hasAvatar: boolean }>> {
  const out: Record<string, { name: string | null; hasAvatar: boolean }> = {};
  for (const p of await people(addrs.filter((a) => ADDR_RE.test(a)).slice(0, 64))) out[p.addr] = { name: p.name, hasAvatar: p.hasAvatar };
  return out;
}

const fold = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Search by pseudo (substring, accents ignored) OR address prefix. Each
 *  result says whether it is a studio account (requests: studio side only). */
export async function searchProfiles(q: string): Promise<{ addr: string; name: string; hasAvatar: boolean; isStudio: boolean }[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const byAddr = query.toLowerCase().startsWith("0x");
  if (byAddr && !/^0x[0-9a-f]{0,40}$/i.test(query)) return [];
  const hits = (await profiles.search(query, byAddr)).filter((p) => (byAddr ? true : fold(p.name).includes(fold(query)))).slice(0, 10);
  return Promise.all(hits.map(async (p) => ({ ...p, isStudio: (await studiosOwnedBy(p.addr)).length > 0 })));
}

/** Play time pushed by the launcher at the end of a session (device session). */
export async function addPlaystat(wallet: string, editionId: string, seconds: number): Promise<{ ok: true }> {
  if (!/^\d{1,6}$/.test(editionId)) throw new Error("édition invalide");
  const s = Math.floor(seconds);
  if (!Number.isFinite(s) || s <= 0 || s > 24 * 3600) throw new Error("durée invalide");
  await tx(async () => {
    await playstats.add(wallet, editionId, s);
    await activity.add(wallet, "played", { editionId, seconds: s });
  });
  return { ok: true };
}

// ── Wishlist (private) ─────────────────────────────────────────────────
// The primary price is fixed on-chain, so a "price drop" is a second-hand
// copy listed below the price the owner last saw. The clients (launcher,
// web) read the listings and report what they showed with /wishlist/seen.

const WISH_MAX = 50;
const EDITION_RE = /^\d{1,6}$/;
const WEI_RE = /^\d{1,40}$/;

export async function wishlistOf(me: string) {
  return wishlist.list(me);
}

export async function setWish(me: string, body: { editionId?: unknown; on?: unknown; priceWei?: unknown }) {
  const editionId = String(body.editionId ?? "");
  if (!EDITION_RE.test(editionId)) throw new Error("édition invalide");
  if (body.on === false) {
    await wishlist.remove(me, editionId);
  } else {
    const priceWei = String(body.priceWei ?? "");
    if (!WEI_RE.test(priceWei)) throw new Error("prix invalide");
    await tx(async () => {
      const already = (await wishlist.list(me)).some((w) => w.editionId === editionId);
      if (!already && (await wishlist.count(me)) >= WISH_MAX) throw new Error(`liste de souhaits pleine (${WISH_MAX} jeux max)`);
      await wishlist.put(me, editionId, priceWei);
    }, `wishlist:${lc(me)}`);
  }
  return wishlist.list(me);
}

export async function markWishSeen(me: string, body: { editionId?: unknown; priceWei?: unknown }): Promise<{ ok: true }> {
  const editionId = String(body.editionId ?? "");
  const priceWei = String(body.priceWei ?? "");
  if (!EDITION_RE.test(editionId) || !WEI_RE.test(priceWei)) throw new Error("souhait invalide");
  await wishlist.seen(me, editionId, priceWei);
  return { ok: true };
}

// ── Studio public pages ────────────────────────────────────────────────

const URL_RE = /^https:\/\/[^\s<>"']{3,200}$/;

export async function getStudioPage(studioId: string): Promise<StudioPage> {
  if (!/^\d{1,9}$/.test(studioId)) throw new Error("studio invalide");
  return (await studioPages.get(studioId)) ?? { description: "", links: [], team: [], updatedAt: 0 };
}

/** Only the studio's on-chain owner can edit its page. */
export async function saveStudioPage(me: string, studioId: string, body: { description?: unknown; links?: unknown; team?: unknown }): Promise<{ ok: true }> {
  if (!/^\d{1,9}$/.test(studioId)) throw new Error("studio invalide");
  if (lc(await studioOwner(studioId)) !== lc(me)) throw new Error("seul le propriétaire du studio peut modifier sa page");
  const description = String(body.description ?? "").trim();
  if (description.length > 1500) throw new Error("description trop longue (1500 max)");
  const links = (Array.isArray(body.links) ? body.links : []).slice(0, 5).map((l) => {
    const label = String((l as { label?: unknown }).label ?? "").trim().slice(0, 40);
    const url = String((l as { url?: unknown }).url ?? "").trim();
    if (!label || !URL_RE.test(url)) throw new Error(`lien invalide (https:// requis) : ${label || url}`);
    return { label, url };
  });
  const team = (Array.isArray(body.team) ? body.team : []).slice(0, 12).map((m) => {
    const name = String((m as { name?: unknown }).name ?? "").trim().slice(0, 40);
    const role = String((m as { role?: unknown }).role ?? "").trim().slice(0, 40);
    const wallet = (m as { wallet?: unknown }).wallet ? String((m as { wallet?: unknown }).wallet) : null;
    if (!name) throw new Error("membre sans nom");
    if (wallet && !ADDR_RE.test(wallet)) throw new Error(`wallet invalide pour ${name}`);
    return { name, role, wallet: wallet ? lc(wallet) : null };
  });
  await studioPages.put(studioId, { description, links, team }, me);
  console.log(`✔ page studio #${studioId} mise à jour`);
  return { ok: true };
}

// ── Chat (friends only) ────────────────────────────────────────────────

const BODY_MAX = 1000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;

export async function chatSummary(me: string) {
  const rows = await messages.summary(me);
  const names = await namesOf(rows.map((r) => r.other));
  return rows.map((r) => ({ ...r, name: names[r.other]?.name ?? null }));
}

export async function chatThread(me: string, other: string, afterId: number): Promise<ChatMessage[]> {
  if (!ADDR_RE.test(other)) throw new Error("adresse invalide");
  return messages.thread(me, other, Number.isFinite(afterId) ? afterId : 0);
}

/** kind "text": free text. kind "loan": a lend just happened, shown as a
 *  card in the thread (cosmetic; the loan itself is on-chain). */
export async function sendMessage(me: string, other: string, body: { kind?: unknown; text?: unknown; loan?: unknown }): Promise<ChatMessage> {
  if (!ADDR_RE.test(other)) throw new Error("adresse invalide");
  if (!(await friends.since(me, other))) throw new Error("le chat est réservé aux amis");
  // shared counter (Redis): the limit holds whichever replica takes the message
  // (fails open if Redis is down: chat keeps working, unthrottled)
  const allowed = await live()
    .rateHit(`chat:${lc(me)}`, RATE_MAX, RATE_WINDOW_MS)
    .catch(() => true);
  if (!allowed) throw new Error("trop de messages — patientez une minute");
  let kind = "text";
  let text: string;
  if (body.kind === "loan") {
    const l = (body.loan ?? {}) as { tokenId?: unknown; editionId?: unknown; expires?: unknown };
    const loan = { tokenId: String(l.tokenId ?? ""), editionId: String(l.editionId ?? ""), expires: Number(l.expires) };
    if (!/^\d{1,12}$/.test(loan.tokenId) || !/^\d{1,6}$/.test(loan.editionId) || !Number.isFinite(loan.expires)) throw new Error("prêt invalide");
    kind = "loan";
    text = JSON.stringify(loan);
  } else {
    text = String(body.text ?? "").trim();
    if (!text) throw new Error("message vide");
    if (text.length > BODY_MAX) throw new Error(`message trop long (${BODY_MAX} max)`);
  }
  const msg = await messages.add(me, other, kind, text);
  await push(other, "message", msg);
  await push(me, "message", msg); // the sender's other windows
  return msg;
}

export async function markRead(me: string, other: string, upTo: number): Promise<{ ok: true }> {
  if (!ADDR_RE.test(other) || !Number.isFinite(upTo)) throw new Error("requête invalide");
  await messages.markRead(me, other, upTo);
  await push(other, "read", { by: lc(me), upTo });
  return { ok: true };
}
