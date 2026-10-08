// Social layer (v1, 2026-10-08) — everything OFF-CHAIN, zero gas.
//
// AUTH: one wallet signature opens a 24 h SESSION on the web; the launcher
// opens its session with the paired DEVICE KEY (no wallet in the launcher).
// Social actions (friends, profile, chat, presence) then use
// `Authorization: Bearer <token>` — no signature per action. What moves
// value or keys stays signed per action: pairing (/ticket), studio publish,
// device revoke.
//
// Profiles are PUBLIC (Steam-like): bio, favorites, play time, friends,
// activity. Chat is between friends only, stored here (not end-to-end).

import type { ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyMessage } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import {
  DATA_DIR,
  activity,
  consumeNonce,
  devices,
  friends,
  messages,
  nonceUsed,
  playstats,
  profiles,
  sessions,
  studioPages,
  tx,
  type ChatMessage,
  type StudioPage,
} from "./db.ts";
import { studioOwner } from "./service.ts";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const DEVICE_RE = /^0x0[23][0-9a-fA-F]{64}$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const MESSAGE_MAX_AGE_MS = 10 * 60 * 1000;
const NONCE_TTL_MS = MESSAGE_MAX_AGE_MS * 2;
const SESSION_TTL_MS = 24 * 3600 * 1000;
const MAX_FRIENDS = 16;

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

function issueSession(wallet: string, device: string | null): { token: string; wallet: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.put(tokenHash(token), wallet, device, expiresAt);
  return { token, wallet: lc(wallet), expiresAt };
}

// ── Sessions ───────────────────────────────────────────────────────────

/** Web: GameVault Session\nme: 0x…\nat: ISO\nnonce: uuid — signed by the wallet. */
export async function openWebSession(message: string, signature: `0x${string}`): Promise<{ token: string; wallet: string; expiresAt: number }> {
  const f = parseLines(message, "GameVault Session", ["me", "at", "nonce"]);
  if (!ADDR_RE.test(f.me) || !UUID_RE.test(f.nonce)) throw new Error("message invalide");
  fresh(Date.parse(f.at));
  if (nonceUsed(f.nonce)) throw new Error("nonce déjà utilisé");
  if (!(await verifyMessage({ address: f.me as `0x${string}`, message, signature }))) throw new Error("signature invalide");
  consumeNonce(f.nonce, NONCE_TTL_MS);
  return issueSession(f.me, null);
}

/** Launcher: GameVault Device Session\nwallet\ndevice\nat: <ms>\nnonce: <hex>,
 *  signed by the DEVICE key in the Rust core (compact secp256k1 over sha256).
 *  The device must be registered to that wallet (it paired a ticket). */
export function openDeviceSession(message: string, signatureHex: string): { token: string; wallet: string; expiresAt: number } {
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
  if (!devices.get(f.wallet, f.device)) throw new Error("appareil non appairé à ce compte");
  if (nonceUsed(f.nonce)) throw new Error("nonce déjà utilisé");
  consumeNonce(f.nonce, NONCE_TTL_MS);
  return issueSession(f.wallet, f.device);
}

export class Unauthorized extends Error {}

/** Wallet behind `Authorization: Bearer <token>` (or ?token= for SSE). */
export function authWallet(bearer: string | undefined): { wallet: string; device: string | null } {
  const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : bearer;
  if (!token) throw new Unauthorized("session requise");
  const s = sessions.get(tokenHash(token));
  if (!s) throw new Unauthorized("session expirée — reconnectez-vous");
  return { wallet: s.wallet, device: s.device };
}

export function closeSession(bearer: string | undefined): { ok: true } {
  const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : bearer;
  if (token) sessions.remove(tokenHash(token));
  return { ok: true };
}

// ── Presence (memory only: online = heartbeat < 90 s) ───────────────────

const PRESENCE_TTL_MS = 90_000;
const presence = new Map<string, { playing: string | null; at: number }>();

export function setPresence(wallet: string, playing: string | null): { ok: true } {
  if (playing !== null && !/^\d{1,6}$/.test(playing)) throw new Error("édition invalide");
  const prev = presence.get(lc(wallet));
  presence.set(lc(wallet), { playing, at: Date.now() });
  if (prev?.playing !== playing) notifyFriends(wallet, "presence", { addr: lc(wallet), ...presenceOf(wallet) });
  return { ok: true };
}

export function presenceOf(wallet: string): { state: "offline" | "online" | "playing"; editionId: string | null } {
  const p = presence.get(lc(wallet));
  if (!p || Date.now() - p.at > PRESENCE_TTL_MS) return { state: "offline", editionId: null };
  return p.playing ? { state: "playing", editionId: p.playing } : { state: "online", editionId: null };
}

// ── Live stream (Server-Sent Events) ───────────────────────────────────
// One open response per launcher / browser tab. Events: message, presence.

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

function push(wallet: string, event: string, data: unknown): void {
  for (const res of streams.get(lc(wallet)) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function notifyFriends(wallet: string, event: string, data: unknown): void {
  for (const f of friends.list(wallet)) push(f.addr, event, data);
}

// ── Friends (session) ──────────────────────────────────────────────────

const FRIEND_ACTIONS = ["request", "accept", "decline", "cancel", "remove"] as const;

export function friendAction(me: string, action: string, other: string): { ok: true } {
  if (!(FRIEND_ACTIONS as readonly string[]).includes(action)) throw new Error("action inconnue");
  if (!ADDR_RE.test(other)) throw new Error("adresse invalide");
  if (lc(me) === lc(other)) throw new Error("pas d'amitié avec soi-même");
  tx(() => {
    if (action === "request") {
      if (friends.since(me, other)) throw new Error("déjà amis");
      friends.request(me, other);
    } else if (action === "accept") {
      if (!friends.hasRequest(other, me)) throw new Error("aucune demande de cette adresse");
      // Anti-farm cap (audit T10): a lending ring needs many "friends".
      if (friends.count(me) >= MAX_FRIENDS || friends.count(other) >= MAX_FRIENDS) throw new Error(`limite de ${MAX_FRIENDS} amis atteinte`);
      friends.deleteRequest(other, me);
      friends.deleteRequest(me, other);
      friends.set(me, other, Math.floor(Date.now() / 1000));
      activity.add(me, "friend", { with: lc(other) });
      activity.add(other, "friend", { with: lc(me) });
    } else if (action === "decline") {
      friends.deleteRequest(other, me);
    } else if (action === "cancel") {
      friends.deleteRequest(me, other);
    } else {
      friends.remove(me, other);
    }
  });
  push(other, "friends", { from: lc(me), action });
  console.log(`✔ amis: ${action} ${me} <-> ${other}`);
  return { ok: true };
}

type Person = { addr: string; name: string | null; hasAvatar: boolean };

function people(addrs: string[]): Person[] {
  const names = profiles.names(addrs);
  return addrs.map((a) => ({ addr: lc(a), name: names[lc(a)] ?? null, hasAvatar: Boolean(profiles.get(a)?.avatarType) }));
}

export function friendsOf(addr: string): {
  friends: (Person & { since: number; presence: ReturnType<typeof presenceOf> })[];
  incoming: Person[];
  outgoing: Person[];
} {
  if (!ADDR_RE.test(addr)) throw new Error("adresse invalide");
  const list = friends.list(addr);
  const info = new Map(people(list.map((f) => f.addr)).map((p) => [p.addr, p]));
  return {
    friends: list.map((f) => ({ ...info.get(lc(f.addr))!, since: f.since, presence: presenceOf(f.addr) })),
    incoming: people(friends.incoming(addr)),
    outgoing: people(friends.outgoing(addr)),
  };
}

// ── Profiles (public read, session write) ──────────────────────────────

const AVATARS_DIR = join(DATA_DIR, "avatars");
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

/** avatar: "keep" | "none" | base64 image (resized client-side to 256 px). */
export function saveProfile(me: string, body: { name?: unknown; bio?: unknown; favorites?: unknown; avatar?: unknown }): { ok: true } {
  const name = String(body.name ?? "").trim();
  if (!NAME_RE.test(name)) throw new Error("pseudo invalide (2-24 caractères, lettres/chiffres/espaces/-_.)");
  const bio = String(body.bio ?? "").replace(/\r\n/g, "\n").trim();
  if (bio.length > BIO_MAX) throw new Error(`bio trop longue (${BIO_MAX} caractères max)`);
  const favorites = (Array.isArray(body.favorites) ? body.favorites : [])
    .map(String)
    .filter((s) => /^\d{1,6}$/.test(s))
    .slice(0, 12);
  const avatar = String(body.avatar ?? "keep");

  let avatarType = profiles.get(me)?.avatarType ?? null;
  if (avatar === "none") {
    avatarType = null;
  } else if (avatar !== "keep") {
    const bytes = Buffer.from(avatar, "base64");
    if (bytes.length > AVATAR_MAX_BYTES) throw new Error(`avatar trop lourd (max ${AVATAR_MAX_BYTES / 1024} Ko)`);
    if (bytes.length < AVATAR_MIN_BYTES) throw new Error("avatar trop petit pour être une image");
    const kind = avatarKind(bytes);
    if (!kind) throw new Error("avatar: formats acceptés jpeg/png/webp");
    mkdirSync(AVATARS_DIR, { recursive: true });
    writeFileSync(join(AVATARS_DIR, lc(me)), bytes);
    avatarType = kind;
  }
  profiles.upsert(me, { name, avatarType, favorites, bio, updatedAt: Date.now() });
  console.log(`✔ profil: ${me} -> « ${name} »`);
  return { ok: true };
}

export function getAvatar(addr: string): { bytes: Uint8Array; type: string } | null {
  if (!ADDR_RE.test(addr)) return null;
  const p = profiles.get(addr);
  const file = join(AVATARS_DIR, lc(addr));
  if (!p?.avatarType || !existsSync(file)) return null;
  return { bytes: new Uint8Array(readFileSync(file)), type: p.avatarType };
}

/** The public profile (Steam-like). On-chain parts (licences, listings,
 *  loans) are read by the web page from the subgraph. */
export function getProfile(addr: string) {
  if (!ADDR_RE.test(addr)) throw new Error("adresse invalide");
  const p = profiles.get(addr);
  const friendList = friends.list(addr);
  const names = profiles.names(activity.recent(addr).flatMap((a) => (typeof a.data.with === "string" ? [a.data.with] : [])));
  return {
    addr,
    name: p?.name ?? null,
    hasAvatar: Boolean(p?.avatarType),
    bio: p?.bio ?? "",
    favorites: p?.favorites ?? [],
    memberSince: p?.createdAt ?? null,
    presence: presenceOf(addr),
    topPlayed: playstats.top(addr, 8),
    totalSeconds: playstats.total(addr),
    devicesCount: devices.list(addr).length,
    friendsCount: friendList.length,
    friends: people(friendList.slice(0, 12).map((f) => f.addr)),
    activity: activity.recent(addr).map((a) => ({
      ...a,
      data: typeof a.data.with === "string" ? { ...a.data, withName: names[a.data.with] ?? null } : a.data,
    })),
    updatedAt: p?.updatedAt ?? null,
  };
}

/** Names for a list of addresses (sellers, team members, chat). */
export function namesOf(addrs: string[]): Record<string, { name: string | null; hasAvatar: boolean }> {
  const out: Record<string, { name: string | null; hasAvatar: boolean }> = {};
  for (const p of people(addrs.filter((a) => ADDR_RE.test(a)).slice(0, 64))) out[p.addr] = { name: p.name, hasAvatar: p.hasAvatar };
  return out;
}

const fold = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Search by pseudo (substring, accents ignored) OR address prefix. */
export function searchProfiles(q: string): { addr: string; name: string; hasAvatar: boolean }[] {
  const query = q.trim();
  if (query.length < 2) return [];
  const byAddr = query.toLowerCase().startsWith("0x");
  return profiles
    .all()
    .filter((p) => (byAddr ? p.addr.startsWith(query.toLowerCase()) : fold(p.name).includes(fold(query))))
    .slice(0, 10);
}

/** Play time pushed by the launcher at the end of a session (device session). */
export function addPlaystat(wallet: string, editionId: string, seconds: number): { ok: true } {
  if (!/^\d{1,6}$/.test(editionId)) throw new Error("édition invalide");
  const s = Math.floor(seconds);
  if (!Number.isFinite(s) || s <= 0 || s > 24 * 3600) throw new Error("durée invalide");
  playstats.add(wallet, editionId, s);
  activity.add(wallet, "played", { editionId, seconds: s });
  return { ok: true };
}

// ── Studio public pages ────────────────────────────────────────────────

const URL_RE = /^https:\/\/[^\s<>"']{3,200}$/;

export function getStudioPage(studioId: string): StudioPage {
  if (!/^\d{1,9}$/.test(studioId)) throw new Error("studio invalide");
  return studioPages.get(studioId) ?? { description: "", links: [], team: [], updatedAt: 0 };
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
  studioPages.put(studioId, { description, links, team }, me);
  console.log(`✔ page studio #${studioId} mise à jour`);
  return { ok: true };
}

// ── Chat (friends only) ────────────────────────────────────────────────

const BODY_MAX = 1000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const sent = new Map<string, number[]>();

function rateLimit(wallet: string): void {
  const now = Date.now();
  const recent = (sent.get(wallet) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) throw new Error("trop de messages — patientez une minute");
  recent.push(now);
  sent.set(wallet, recent);
}

export function chatSummary(me: string) {
  const rows = messages.summary(me);
  const names = namesOf(rows.map((r) => r.other));
  return rows.map((r) => ({ ...r, name: names[r.other]?.name ?? null }));
}

export function chatThread(me: string, other: string, afterId: number): ChatMessage[] {
  if (!ADDR_RE.test(other)) throw new Error("adresse invalide");
  return messages.thread(me, other, Number.isFinite(afterId) ? afterId : 0);
}

/** kind "text": free text. kind "loan": a lend just happened, shown as a
 *  card in the thread (cosmetic; the loan itself is on-chain). */
export function sendMessage(me: string, other: string, body: { kind?: unknown; text?: unknown; loan?: unknown }): ChatMessage {
  if (!ADDR_RE.test(other)) throw new Error("adresse invalide");
  if (!friends.since(me, other)) throw new Error("le chat est réservé aux amis");
  rateLimit(lc(me));
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
  const msg = messages.add(me, other, kind, text);
  push(other, "message", msg);
  push(me, "message", msg); // the sender's other windows
  return msg;
}

export function markRead(me: string, other: string, upTo: number): { ok: true } {
  if (!ADDR_RE.test(other) || !Number.isFinite(upTo)) throw new Error("requête invalide");
  messages.markRead(me, other, upTo);
  push(other, "read", { by: lc(me), upTo });
  return { ok: true };
}
