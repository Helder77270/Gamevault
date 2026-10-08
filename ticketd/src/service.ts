// Core ticket issuance — the only place that turns on-chain ownership into
// a playable ticket. Kept HTTP-free for testability (see server.ts).

import { createPublicClient, http, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { signTicket, wrapKey, hex, unhex, encryptBuild, type SignedTicket, type Ticket } from "@gamevault/shared";
import { parsePairingMessage } from "@gamevault/shared/siwe";
import { DEV_PLATFORM_PRIV, devContentKeyFor } from "@gamevault/shared/devkeys";
import { LICENSE_ABI, REGISTRY_ABI } from "@gamevault/shared/abi";
import { CHAIN, DEPLOYMENTS } from "@gamevault/shared/deployments";
import { fetchBuild, putBuild, type StoredBuild } from "@gamevault/shared/storage";
import { DATA_DIR, consumeNonce, devices, friends, getContentKey, nonceUsed, playstats, profiles, putContentKey, tx } from "./db.ts";

const TICKET_TTL_SEC = 30 * 24 * 3600; // 30-day offline window
const MESSAGE_MAX_AGE_MS = 10 * 60 * 1000; // pairing message freshness

// --- Config (env) -----------------------------------------------------------

// GAMEVAULT_SKIP_OWNER_CHECK=1 is for the selftest only (no chain there)
const skipOwnerCheck = process.env.GAMEVAULT_SKIP_OWNER_CHECK === "1";
/** Dev fallbacks (public DEV keys) are allowed ONLY here — fail-closed otherwise. */
const DEV_MODE = process.env.GAMEVAULT_DEV === "1" || skipOwnerCheck;

// Separated service keys (audit K1). The ticket key never touches the chain
// (its pubkey is embedded in the launcher); the attestation key is the
// rotatable GameLicense.attestationSigner. Neither has any on-chain power.

/** Signs launch tickets. */
function ticketSignerPriv(): Uint8Array {
  const env = process.env.TICKET_SIGNER_PRIVKEY;
  if (env) return unhex(env);
  if (!DEV_MODE) throw new Error("TICKET_SIGNER_PRIVKEY manquant — refus de signer avec la clé DEV publique");
  console.warn("⚠ TICKET_SIGNER_PRIVKEY not set — using the DEV platform key (fixtures only)");
  return DEV_PLATFORM_PRIV;
}

/** Signs friendship attestations (EIP-712). No dev fallback: lending is on-chain. */
function attestSignerKey(): `0x${string}` {
  const env = process.env.ATTEST_SIGNER_PRIVKEY;
  if (!env) throw new Error("ATTEST_SIGNER_PRIVKEY manquant");
  return (env.startsWith("0x") ? env : `0x${env}`) as `0x${string}`;
}
const licenseAddress =
  !skipOwnerCheck && (process.env.GAMELICENSE_ADDRESS || DEPLOYMENTS.gameLicense)
    ? ((process.env.GAMELICENSE_ADDRESS || DEPLOYMENTS.gameLicense) as `0x${string}`)
    : undefined;
if (!licenseAddress) {
  console.warn("⚠ ownerOf() check SKIPPED (no license address or selftest mode)");
} else {
  console.log(`ownerOf() check ACTIVE against ${licenseAddress} (Base Sepolia)`);
}

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.RPC_URL),
});

// ── Content keys ─────────────────────────────────────────────────────────
// Studio-published editions: random key generated at publish time, stored
// BY BUILD CID (the edition id is unknown until the studio's on-chain tx;
// the CID links the two). Dev editions 2/3: deterministic derivation.

// Keys live encrypted in SQLite (db.ts) with WHO published them (wallet +
// studio the publish was signed for); publisher NULL = legacy unsigned.

// ── Signed studio publishing (audit T1/T3, 2026-10-07) ───────────────────
// The studio's wallet signs a canonical message binding: its address, the
// on-chain studio it publishes for, the sha256 of the EXACT uploaded bytes,
// the file name, a timestamp and a nonce. ticketd checks the wallet owns
// that studio on-chain, then stores (key, publisher, studioId) by CID.
// contentKeyFor later refuses any edition not belonging to that studio.

const PUBLISH_NAME_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function publishMessage(f: { wallet: string; studioId: string; sha256: string; name: string; at: string; nonce: string }): string {
  return [
    "GameVault Publish",
    `wallet: ${f.wallet}`,
    `studio: ${f.studioId}`,
    `sha256: ${f.sha256}`,
    `name: ${f.name}`,
    `at: ${f.at}`,
    `nonce: ${f.nonce}`,
  ].join("\n");
}

function parsePublishMessage(message: string): { wallet: string; studioId: string; sha256: string; name: string; at: string; nonce: string } {
  const lines = message.split("\n");
  const keys = ["wallet", "studio", "sha256", "name", "at", "nonce"];
  if (lines.length !== 7 || lines[0] !== "GameVault Publish") throw new Error("message de publication inattendu");
  const v: Record<string, string> = {};
  keys.forEach((k, i) => {
    const line = lines[i + 1];
    if (!line.startsWith(`${k}: `)) throw new Error(`message de publication : champ ${k} attendu`);
    v[k] = line.slice(k.length + 2);
  });
  const f = { wallet: v.wallet, studioId: v.studio, sha256: v.sha256, name: v.name, at: v.at, nonce: v.nonce };
  // Canonical form only: re-serialize and compare (no injected/extra content)
  if (publishMessage(f) !== message) throw new Error("message de publication non canonique");
  if (!ADDR_RE.test(f.wallet)) throw new Error("wallet invalide");
  if (!/^\d{1,9}$/.test(f.studioId)) throw new Error("studio invalide");
  if (!/^0x[0-9a-f]{64}$/.test(f.sha256)) throw new Error("sha256 invalide");
  if (!PUBLISH_NAME_RE.test(f.name)) throw new Error("nom de fichier invalide");
  if (!/^[0-9a-fA-F-]{36}$/.test(f.nonce)) throw new Error("nonce invalide");
  return f;
}

/** Studio publish: verify the signed request, encrypt with a fresh random
 *  key, pin to IPFS, remember (key, publisher, studio) by CID. The studio
 *  then records the CID on-chain with its own wallet. */
export async function publishBuild(plain: Uint8Array, message: string, signature: `0x${string}`): Promise<StoredBuild> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT manquant dans ticketd/.env");
  const f = parsePublishMessage(message);

  const age = Date.now() - Date.parse(f.at);
  if (!Number.isFinite(age) || age < -60_000 || age > MESSAGE_MAX_AGE_MS) throw new Error("message de publication expiré");
  if (nonceUsed(f.nonce)) throw new Error("nonce déjà utilisé");
  if (!(await verifyMessage({ address: f.wallet as `0x${string}`, message, signature }))) throw new Error("signature invalide");
  const digest = `0x${createHash("sha256").update(plain).digest("hex")}`;
  if (digest !== f.sha256) throw new Error("le fichier reçu ne correspond pas au fichier signé");

  if (!DEPLOYMENTS.gameRegistry) throw new Error("GameRegistry non déployé");
  const [owner] = await client.readContract({
    address: DEPLOYMENTS.gameRegistry as `0x${string}`,
    abi: REGISTRY_ABI,
    functionName: "studios",
    args: [BigInt(f.studioId)],
  });
  if (owner.toLowerCase() !== f.wallet.toLowerCase()) {
    throw new Error(`le studio #${f.studioId} n'appartient pas à ce wallet`);
  }
  consumeNonce(f.nonce, MESSAGE_MAX_AGE_MS * 2);

  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const enc = encryptBuild(plain, contentKey);
  const stored = await putBuild(enc, f.name, jwt);
  putContentKey(stored.cid, contentKey, f.wallet.toLowerCase(), f.studioId);
  cacheBuild(stored.cid, enc); // primary distribution — IPFS is the backup
  console.log(`✔ build publié: ${f.name} -> ${stored.cid} (studio #${f.studioId}, ${f.wallet})`);
  return stored;
}

// ── Build distribution ────────────────────────────────────────────────────
// Decided 2026-10-06: clients fetch builds from ticketd (local cache filled
// at publish time), NOT from IPFS gateways directly — public gateways are
// flaky (transient 404s, 429s) and CORS-hostile from a webview. IPFS stays
// the durable backup: a cache miss refills from the gateways server-side.
// Integrity remains CLIENT-side (sha256 vs the on-chain hash), so this
// server is as untrusted as a gateway.

const BUILDS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../data/builds");

function cacheBuild(cid: string, bytes: Uint8Array): void {
  mkdirSync(BUILDS_DIR, { recursive: true });
  writeFileSync(join(BUILDS_DIR, cid), bytes);
}

export async function getBuild(cid: string): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9]{10,100}$/.test(cid)) throw new Error("CID invalide");
  const p = join(BUILDS_DIR, cid);
  if (existsSync(p)) return new Uint8Array(readFileSync(p));
  // Cache miss: only for CIDs registered on-chain, verified against the
  // on-chain sha256 BEFORE caching (audit T7 — no amplification of
  // arbitrary CIDs, no permanently poisoned cache).
  const ed = await editionForCid(cid);
  if (!ed) throw new Error("CID inconnu du registre");
  const bytes = await fetchBuild(cid, ed.buildHash); // server-side: no CORS, gateway fallback
  cacheBuild(cid, bytes);
  console.log(`✔ build ${cid} récupéré d'IPFS, hash vérifié -> cache local (${bytes.length} o)`);
  return bytes;
}

// ── Friends DB (décidé 2026-10-07) ───────────────────────────────────────
// L'amitié est OFF-CHAIN : une transaction par ami tuait l'usage. Ici,
// chaque action est un simple message signé par le wallet (zéro gas).
// Le contrat garde sa garde : au prêt, la plateforme signe une ATTESTATION
// « owner et borrower amis depuis T » que lend() vérifie on-chain avec
// l'âge minimal. Backdate = simulation des 3 jours en dev.

const ATTEST_TTL_SEC = 10 * 60;
const MAX_FRIENDS = 16;
const NONCE_TTL_MS = MESSAGE_MAX_AGE_MS * 2;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const FRIEND_ACTIONS = ["request", "accept", "decline", "cancel", "remove"] as const;

export function friendMessage(f: { action: string; me: string; other: string; at: string; nonce: string }): string {
  return ["GameVault Amis", `action: ${f.action}`, `me: ${f.me}`, `other: ${f.other}`, `at: ${f.at}`, `nonce: ${f.nonce}`].join("\n");
}

/** Strict parse: exact line order, then re-serialize and compare — no
 *  smuggled lines (audit T13). */
function parseFriendMessage(message: string): { action: string; me: string; other: string; at: string; nonce: string } {
  const lines = message.split("\n");
  if (lines.length !== 6 || lines[0] !== "GameVault Amis") throw new Error("message inattendu");
  const keys = ["action", "me", "other", "at", "nonce"];
  const v: Record<string, string> = {};
  keys.forEach((k, i) => {
    const l = lines[i + 1];
    if (!l.startsWith(`${k}: `)) throw new Error(`champ ${k} attendu`);
    v[k] = l.slice(k.length + 2);
  });
  const f = { action: v.action, me: v.me, other: v.other, at: v.at, nonce: v.nonce };
  if (friendMessage(f) !== message) throw new Error("message non canonique");
  return f;
}

/** Message signé côté wallet :
 *  GameVault Amis\naction: request|accept|decline|cancel|remove\nme: 0x…\nother: 0x…\nat: ISO\nnonce: uuid */
export async function applyFriendAction(message: string, signature: `0x${string}`): Promise<{ ok: true }> {
  const { action, me, other, at, nonce } = parseFriendMessage(message);
  if (!(FRIEND_ACTIONS as readonly string[]).includes(action)) throw new Error("action inconnue");
  if (!ADDR_RE.test(me) || !ADDR_RE.test(other)) throw new Error("adresse invalide");
  if (me.toLowerCase() === other.toLowerCase()) throw new Error("pas d'amitié avec soi-même");
  const age = Date.now() - Date.parse(at);
  if (!Number.isFinite(age) || age < -60_000 || age > MESSAGE_MAX_AGE_MS) throw new Error("message expiré");
  if (nonceUsed(nonce)) throw new Error("nonce déjà utilisé");
  const sigOk = await verifyMessage({ address: me as `0x${string}`, message, signature });
  if (!sigOk) throw new Error("signature invalide");

  tx(() => {
    consumeNonce(nonce, NONCE_TTL_MS);
    if (action === "request") {
      if (friends.since(me, other)) throw new Error("déjà amis");
      friends.request(me, other);
    } else if (action === "accept") {
      if (!friends.hasRequest(other, me)) throw new Error("aucune demande de cette adresse");
      // Anti-farm cap (audit T10): a lending ring needs many "friends".
      if (friends.count(me) >= MAX_FRIENDS || friends.count(other) >= MAX_FRIENDS) {
        throw new Error(`limite de ${MAX_FRIENDS} amis atteinte`);
      }
      friends.deleteRequest(other, me);
      friends.deleteRequest(me, other);
      friends.set(me, other, Math.floor(Date.now() / 1000));
    } else if (action === "decline") {
      friends.deleteRequest(other, me);
    } else if (action === "cancel") {
      friends.deleteRequest(me, other);
    } else {
      friends.remove(me, other);
    }
  });
  console.log(`✔ amis: ${action} ${me} <-> ${other}`);
  return { ok: true };
}

export function friendsOf(addr: string): {
  friends: { addr: string; since: number; name: string | null }[];
  incoming: { addr: string; name: string | null }[];
  outgoing: { addr: string; name: string | null }[];
} {
  if (!ADDR_RE.test(addr)) throw new Error("adresse invalide");
  const list = friends.list(addr);
  const incoming = friends.incoming(addr);
  const outgoing = friends.outgoing(addr);
  const names = profiles.names([...list.map((f) => f.addr), ...incoming, ...outgoing]);
  const nameOf = (a: string): string | null => names[a] ?? null;
  return {
    friends: list.map((f) => ({ ...f, name: nameOf(f.addr) })),
    incoming: incoming.map((a) => ({ addr: a, name: nameOf(a) })),
    outgoing: outgoing.map((a) => ({ addr: a, name: nameOf(a) })),
  };
}

/** L'attestation que lend() vérifie on-chain (EIP-712, liée à UNE licence).
 *  Gratuite, courte durée. */
export async function attestFriendship(
  owner: string,
  borrower: string,
  tokenId: string,
): Promise<{ since: number; deadline: number; sig: `0x${string}`; license: string }> {
  if (!ADDR_RE.test(owner) || !ADDR_RE.test(borrower)) throw new Error("adresse invalide");
  if (!/^\d{1,12}$/.test(tokenId)) throw new Error("tokenId invalide");
  // Same address the ownerOf/userOf checks use (honours GAMELICENSE_ADDRESS)
  const license = licenseAddress;
  if (!license) throw new Error("GameLicense non déployé");
  const since = friends.since(owner, borrower);
  if (!since) throw new Error("pas amis — la demande doit être acceptée d'abord");
  const deadline = Math.floor(Date.now() / 1000) + ATTEST_TTL_SEC;
  const account = privateKeyToAccount(attestSignerKey());
  const sig = await account.signTypedData({
    domain: { name: "GameVault License", version: "1", chainId: CHAIN.id, verifyingContract: license },
    types: {
      FriendAttestation: [
        { name: "owner", type: "address" },
        { name: "borrower", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "since", type: "uint64" },
        { name: "deadline", type: "uint64" },
      ],
    },
    primaryType: "FriendAttestation",
    message: {
      owner: owner as `0x${string}`,
      borrower: borrower as `0x${string}`,
      tokenId: BigInt(tokenId),
      since: BigInt(since),
      deadline: BigInt(deadline),
    },
  });
  return { since, deadline, sig, license };
}

// ── Profils (décidé 2026-10-07) ──────────────────────────────────────────
// Pseudo + avatar + favoris, modifiables à volonté par message SIGNÉ (zéro
// gas, comme les amis). Les pseudos ne sont PAS uniques — la recherche
// désambiguïse par l'adresse : « Picsou (0x1234…) ». L'avatar est
// redimensionné côté client ; ici on borne octets + type (magic bytes).
// Les stats de jeu (cosmétiques) sont poussées par le launcher.

const AVATARS_DIR = join(DATA_DIR, "avatars");
const AVATAR_MAX_BYTES = 300 * 1024;
const AVATAR_MIN_BYTES = 256;

const NAME_RE = /^[\p{L}\p{N} _.\-]{2,24}$/u;

function avatarKind(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return "image/png";
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export function profileMessage(f: { me: string; name: string; avatar: string; favorites: string; at: string; nonce: string }): string {
  return ["GameVault Profil", `me: ${f.me}`, `name: ${f.name}`, `avatar: ${f.avatar}`, `favorites: ${f.favorites}`, `at: ${f.at}`, `nonce: ${f.nonce}`].join("\n");
}

function parseProfileMessage(message: string) {
  const lines = message.split("\n");
  if (lines.length !== 7 || lines[0] !== "GameVault Profil") throw new Error("message inattendu");
  const keys = ["me", "name", "avatar", "favorites", "at", "nonce"];
  const v: Record<string, string> = {};
  keys.forEach((k, i) => {
    const l = lines[i + 1];
    if (!l.startsWith(`${k}: `) && l !== `${k}:`) throw new Error(`champ ${k} attendu`);
    v[k] = l.slice(k.length + 2);
  });
  const f = { me: v.me, name: v.name, avatar: v.avatar, favorites: v.favorites, at: v.at, nonce: v.nonce };
  if (profileMessage(f) !== message) throw new Error("message non canonique");
  return f;
}

/** Message signé :
 *  GameVault Profil\nme: 0x…\nname: pseudo\navatar: <sha256hex|keep|none>\nfavorites: 1,2\nat: ISO\nnonce: uuid */
export async function setProfile(message: string, signature: `0x${string}`, avatarB64?: string): Promise<{ ok: true }> {
  const { me, name, avatar, favorites, at, nonce } = parseProfileMessage(message);
  if (!ADDR_RE.test(me)) throw new Error("adresse invalide");
  if (!NAME_RE.test(name)) throw new Error("pseudo invalide (2-24 caractères, lettres/chiffres/espaces/-_.)");
  const age = Date.now() - Date.parse(at);
  if (!Number.isFinite(age) || age < -60_000 || age > MESSAGE_MAX_AGE_MS) throw new Error("message expiré");
  if (nonceUsed(nonce)) throw new Error("nonce déjà utilisé");
  if (!(await verifyMessage({ address: me as `0x${string}`, message, signature }))) throw new Error("signature invalide");
  consumeNonce(nonce, NONCE_TTL_MS);

  const favList = favorites
    ? favorites.split(",").map((s) => s.trim()).filter((s) => /^\d{1,6}$/.test(s)).slice(0, 12)
    : [];

  const meL = me.toLowerCase();
  let avatarType = profiles.get(meL)?.avatarType ?? null;

  if (avatar === "none") {
    avatarType = null;
  } else if (avatar !== "keep") {
    if (!avatarB64) throw new Error("avatar annoncé mais absent du corps");
    const bytes = Buffer.from(avatarB64, "base64");
    if (bytes.length > AVATAR_MAX_BYTES) throw new Error(`avatar trop lourd (max ${AVATAR_MAX_BYTES / 1024} Ko)`);
    if (bytes.length < AVATAR_MIN_BYTES) throw new Error("avatar trop petit pour être une image");
    const kind = avatarKind(bytes);
    if (!kind) throw new Error("avatar: formats acceptés jpeg/png/webp");
    if (createHashHex(bytes) !== avatar.toLowerCase()) throw new Error("le hash signé ne correspond pas à l'image envoyée");
    mkdirSync(AVATARS_DIR, { recursive: true });
    writeFileSync(join(AVATARS_DIR, meL), bytes);
    avatarType = kind;
  }

  profiles.upsert(meL, { name, avatarType, favorites: favList, updatedAt: Date.now() });
  console.log(`✔ profil: ${me} -> « ${name} »${avatarType ? " (avatar)" : ""}`);
  return { ok: true };
}

const createHashHex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function getProfile(addr: string): {
  addr: string;
  name: string | null;
  hasAvatar: boolean;
  favorites: string[];
  topPlayed: { editionId: string; seconds: number }[];
  updatedAt: number | null;
} {
  if (!ADDR_RE.test(addr)) throw new Error("adresse invalide");
  const p = profiles.get(addr);
  return {
    addr,
    name: p?.name ?? null,
    hasAvatar: Boolean(p?.avatarType),
    favorites: p?.favorites ?? [],
    topPlayed: playstats.top(addr, 8),
    updatedAt: p?.updatedAt ?? null,
  };
}

export function getAvatar(addr: string): { bytes: Uint8Array; type: string } | null {
  if (!ADDR_RE.test(addr)) return null;
  const p = profiles.get(addr);
  const file = join(AVATARS_DIR, addr.toLowerCase());
  if (!p?.avatarType || !existsSync(file)) return null;
  return { bytes: new Uint8Array(readFileSync(file)), type: p.avatarType };
}

const fold = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Recherche par pseudo (sous-chaîne, accents ignorés) OU préfixe d'adresse.
 *  Plusieurs « Picsou » ? Chacun revient avec son adresse pour trancher. */
export function searchProfiles(q: string): { addr: string; name: string; hasAvatar: boolean }[] {
  const query = q.trim();
  if (query.length < 2) return [];
  const byAddr = query.toLowerCase().startsWith("0x");
  return profiles
    .all()
    .filter((p) => (byAddr ? p.addr.startsWith(query.toLowerCase()) : fold(p.name).includes(fold(query))))
    .slice(0, 10);
}

/** Stats cosmétiques poussées par le launcher — non signées, locales. */
export function addPlaystat(addr: string, editionId: string, seconds: number): { ok: true } {
  if (!ADDR_RE.test(addr) || !/^\d{1,6}$/.test(editionId)) throw new Error("payload invalide");
  const s = Math.floor(seconds);
  if (!Number.isFinite(s) || s <= 0 || s > 24 * 3600) throw new Error("durée invalide");
  playstats.add(addr, editionId, s);
  return { ok: true };
}

// ── Device registry (audit T4, 2026-10-07) ──────────────────────────────
// A wallet (account) can be active on MAX_DEVICES machines at once — the
// wallet signature at pairing is the identity proof, each launcher keeps
// its own device key. Pairing an extra machine releases the LEAST RECENTLY
// SEEN one; the launcher's online check then revokes it like a resale.
// Re-pairing / renewing a known device never consumes a slot. Offline, an
// evicted machine keeps working until its ticket expires (offline window).

const MAX_DEVICES = 2;
const SEEN_BUMP_MS = 10 * 60 * 1000;
const DEVICE_RE = /^0x0[23][0-9a-fA-F]{64}$/;

export function devicesOf(wallet: string): { max: number; devices: { pubkey: string; pairedAt: number; lastSeen: number }[] } {
  if (!ADDR_RE.test(wallet)) throw new Error("adresse invalide");
  return { max: MAX_DEVICES, devices: devices.list(wallet) };
}

/** Called at ticket issuance: adds or refreshes the device, evicting the
 *  least recently seen one beyond MAX_DEVICES — atomically. Returns the
 *  evicted device. */
function registerDevice(wallet: string, pubkey: string): { pubkey: string } | null {
  return tx(() => {
    const now = Date.now();
    const list = devices.list(wallet); // newest first
    const known = list.find((d) => d.pubkey === pubkey.toLowerCase());
    if (known) {
      devices.touch(wallet, pubkey, now);
      return null;
    }
    let evicted: { pubkey: string } | null = null;
    if (list.length >= MAX_DEVICES) {
      const oldest = list[list.length - 1];
      devices.remove(wallet, oldest.pubkey);
      evicted = oldest;
    }
    devices.upsert(wallet, { pubkey, pairedAt: now, lastSeen: now });
    return evicted;
  });
}

/** Online launch check: is this machine still one of the account's active devices? */
export function deviceStatus(wallet: string, pubkey: string): { active: boolean } {
  if (!ADDR_RE.test(wallet) || !DEVICE_RE.test(pubkey)) throw new Error("paramètres invalides");
  const rec = devices.get(wallet, pubkey);
  if (rec && Date.now() - rec.lastSeen > SEEN_BUMP_MS) {
    devices.touch(wallet, pubkey, Date.now()); // keeps the machine you actually play on off the eviction list
  }
  return { active: Boolean(rec) };
}

export function deviceMessage(f: { me: string; device: string; at: string; nonce: string }): string {
  return ["GameVault Appareils", "action: revoke", `me: ${f.me}`, `device: ${f.device}`, `at: ${f.at}`, `nonce: ${f.nonce}`].join("\n");
}

/** Free a slot yourself (wallet-signed, zero gas). */
export async function revokeDevice(message: string, signature: `0x${string}`): Promise<{ ok: true }> {
  const lines = message.split("\n");
  const field = (i: number, k: string) => {
    const l = lines[i] ?? "";
    if (!l.startsWith(`${k}: `)) throw new Error(`champ ${k} attendu`);
    return l.slice(k.length + 2);
  };
  if (lines.length !== 6 || lines[0] !== "GameVault Appareils" || lines[1] !== "action: revoke") throw new Error("message inattendu");
  const f = { me: field(2, "me"), device: field(3, "device"), at: field(4, "at"), nonce: field(5, "nonce") };
  if (deviceMessage(f) !== message) throw new Error("message non canonique");
  if (!ADDR_RE.test(f.me) || !DEVICE_RE.test(f.device)) throw new Error("paramètres invalides");
  const age = Date.now() - Date.parse(f.at);
  if (!Number.isFinite(age) || age < -60_000 || age > MESSAGE_MAX_AGE_MS) throw new Error("message expiré");
  if (nonceUsed(f.nonce)) throw new Error("nonce déjà utilisé");
  if (!(await verifyMessage({ address: f.me as `0x${string}`, message, signature }))) throw new Error("signature invalide");
  tx(() => {
    consumeNonce(f.nonce, NONCE_TTL_MS);
    devices.remove(f.me, f.device);
  });
  console.log(`✔ appareil ${f.device.slice(0, 12)}… libéré par ${f.me}`);
  return { ok: true };
}

/** DEV : antidater une amitié pour simuler les 3 jours (ticketd est local). */
export function backdateFriendship(a: string, b: string, sinceSec: number): { ok: true; since: number } {
  if (!ADDR_RE.test(a) || !ADDR_RE.test(b)) throw new Error("adresse invalide");
  if (!Number.isFinite(sinceSec) || sinceSec <= 0) throw new Error("since invalide");
  if (!friends.since(a, b)) throw new Error("pas amis — accepter d'abord, antidater ensuite");
  friends.set(a, b, Math.floor(sinceSec));
  console.warn(`⚠ DEV: amitié ${a} <-> ${b} antidatée au ${new Date(sinceSec * 1000).toISOString()}`);
  return { ok: true, since: Math.floor(sinceSec) };
}

// ── CID → first edition binding (audit T1, 2026-10-07) ──────────────────
// The registry is permissionless: anyone can create a 0-ETH edition that
// points at ANOTHER studio's CID and get that game's content key sealed to
// their device. Mitigation without a contract change: a CID belongs to the
// FIRST edition that registered it (the real studio registers right after
// publishing; CIDs are not discoverable before). Editions are immutable, so
// the index only grows — cached in memory, extended on demand.

const cidIndex = new Map<string, { editionId: string; buildHash: string }>();
let indexedUpTo = 0n;

async function indexEditions(): Promise<void> {
  if (!DEPLOYMENTS.gameRegistry) return;
  const reg = DEPLOYMENTS.gameRegistry as `0x${string}`;
  const count = await client.readContract({ address: reg, abi: REGISTRY_ABI, functionName: "editionCount" });
  for (let i = indexedUpTo + 1n; i <= count; i++) {
    const e = await client.readContract({ address: reg, abi: REGISTRY_ABI, functionName: "editions", args: [i] });
    if (!cidIndex.has(e[4])) cidIndex.set(e[4], { editionId: i.toString(), buildHash: e[5] });
    indexedUpTo = i;
  }
}

/** The legitimate (first) edition for a CID, or undefined if unregistered. */
async function editionForCid(cid: string): Promise<{ editionId: string; buildHash: string } | undefined> {
  if (!cidIndex.has(cid)) await indexEditions();
  return cidIndex.get(cid);
}

async function contentKeyFor(tokenId: string): Promise<Uint8Array> {
  if (!licenseAddress) {
    // selftest / no chain: deterministic dev key only (never in prod)
    if (!DEV_MODE) throw new Error("ticketd mal configuré : aucune licence on-chain");
    return devContentKeyFor("2");
  }
  const editionId = (
    await client.readContract({ address: licenseAddress, abi: LICENSE_ABI, functionName: "editionOf", args: [BigInt(tokenId)] })
  ).toString();
  if (DEPLOYMENTS.gameRegistry) {
    const edition = await client.readContract({
      address: DEPLOYMENTS.gameRegistry as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "editions",
      args: [BigInt(editionId)],
    });
    const cid = edition[4];
    const first = await editionForCid(cid);
    if (first && first.editionId !== editionId) {
      throw new Error(`édition #${editionId} réutilise le build de l'édition #${first.editionId} — refusé`);
    }
    const rec = getContentKey(cid);
    if (rec) {
      if (rec.studioId === null) {
        // legacy key (unsigned publish era) — dev only
        if (!DEV_MODE) throw new Error(`build de l'édition #${editionId} publié sans signature studio — refusé`);
      } else {
        // The key is released only for editions of the studio that signed the publish
        const [studioId] = await client.readContract({
          address: DEPLOYMENTS.gameRegistry as `0x${string}`,
          abi: REGISTRY_ABI,
          functionName: "games",
          args: [edition[0]],
        });
        if (studioId.toString() !== rec.studioId) {
          throw new Error(`l'édition #${editionId} n'appartient pas au studio #${rec.studioId} qui a publié ce build — refusé`);
        }
      }
      return rec.key;
    }
  }
  throw new Error(`aucune clé de contenu pour l'édition #${editionId}`);
}

// --- Issuance ---------------------------------------------------------------

// Issued tickets waiting for their launcher (the web page signs, the
// LAUNCHER needs the ticket). Fetched once by nonce, then dropped.
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingTickets = new Map<string, { ticket: SignedTicket; at: number }>();

export function takePendingTicket(nonce: string): SignedTicket | undefined {
  for (const [k, v] of pendingTickets) if (Date.now() - v.at > PENDING_TTL_MS) pendingTickets.delete(k);
  const entry = pendingTickets.get(nonce);
  if (entry) pendingTickets.delete(nonce);
  return entry?.ticket;
}

export interface IssueRequest {
  message: string;
  signature: `0x${string}`;
}

export async function issueTicket({ message, signature }: IssueRequest): Promise<SignedTicket> {
  // 1. Parse fields FROM the signed message (canonical-format enforced)
  const p = parsePairingMessage(message);

  // 1b. Bind to THIS deployment — the ticket copies chainId/contract, so a
  //     message for another chain or contract must never be sealed.
  if (p.chainId !== CHAIN.id) throw new Error(`mauvaise chaîne (${p.chainId}, attendu ${CHAIN.id})`);
  if (licenseAddress && p.contract.toLowerCase() !== licenseAddress.toLowerCase()) {
    throw new Error("contrat de licence inattendu");
  }

  // 2. Freshness + replay protection
  const age = Date.now() - Date.parse(p.issuedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > MESSAGE_MAX_AGE_MS) {
    throw new Error("pairing message expired — retry from the launcher");
  }
  if (nonceUsed(p.nonce)) throw new Error("nonce already used");

  // 3. The owner really signed this exact message
  const sigOk = await verifyMessage({ address: p.address as `0x${string}`, message, signature });
  if (!sigOk) throw new Error("signature does not match the address in the message");

  // 4. The signer holds the PLAY RIGHT: the owner — or, during a loan, the
  //    BORROWER (ERC-4907 userOf). The cartridge rule: while a loan runs,
  //    the owner is refused — a lent game is handed over, not duplicated.
  let loanExpires = 0; // unix seconds; 0 = signer is the owner
  if (licenseAddress) {
    let owner: string;
    try {
      owner = await client.readContract({
        address: licenseAddress,
        abi: LICENSE_ABI,
        functionName: "ownerOf",
        args: [BigInt(p.tokenId)],
      });
    } catch {
      // ERC721NonexistentToken (or RPC failure) — either way, no proof of ownership
      throw new Error(
        `licence #${p.tokenId} introuvable on-chain — elle n'a pas encore été mintée (achat primaire requis)`,
      );
    }
    let borrower = "0x0000000000000000000000000000000000000000";
    try {
      borrower = await client.readContract({
        address: licenseAddress,
        abi: LICENSE_ABI,
        functionName: "userOf",
        args: [BigInt(p.tokenId)],
      });
    } catch {
      /* pre-lending contract: no userOf — owner-only */
    }
    const signer = p.address.toLowerCase();
    const loanActive = borrower.toLowerCase() !== "0x0000000000000000000000000000000000000000";
    if (loanActive && signer === borrower.toLowerCase()) {
      const exp = await client.readContract({
        address: licenseAddress,
        abi: LICENSE_ABI,
        functionName: "userExpires",
        args: [BigInt(p.tokenId)],
      });
      loanExpires = Number(exp);
      console.log(`  prêt actif: emprunteur ${borrower} jusqu'à ${new Date(loanExpires * 1000).toISOString()}`);
    } else if (signer === owner.toLowerCase()) {
      if (loanActive) {
        throw new Error(
          `licence #${p.tokenId} prêtée à ${borrower} — le prêteur perd l'accès pendant le prêt (règle cartouche)`,
        );
      }
    } else {
      throw new Error(`ownerOf(${p.tokenId}) is ${owner}, not the signer (ni emprunteur actif)`);
    }
  }

  consumeNonce(p.nonce, NONCE_TTL_MS);

  // 5. Seal the content key to the DEVICE and sign the ticket. A borrower's
  //    ticket dies with the loan: expiresAt = min(TTL, fin du prêt).
  const now = Math.floor(Date.now() / 1000);
  const ticket: Ticket = {
    tokenId: p.tokenId,
    contract: p.contract,
    chainId: p.chainId,
    ownerAddress: p.address,
    devicePubKey: p.devicePubKey,
    wrappedContentKey: hex(wrapKey(await contentKeyFor(p.tokenId), unhex(p.devicePubKey))),
    issuedAt: now,
    expiresAt: loanExpires > 0 ? Math.min(now + TICKET_TTL_SEC, loanExpires) : now + TICKET_TTL_SEC,
  };
  const signed = signTicket(ticket, ticketSignerPriv());

  // 6. Account device slots (registered only once everything succeeded).
  //    Selftest (no chain) does not touch the registry.
  if (!skipOwnerCheck) {
    const evicted = registerDevice(p.address, p.devicePubKey);
    if (evicted) {
      console.log(`↺ ${p.address} : ${MAX_DEVICES} appareils max — ${evicted.pubkey.slice(0, 12)}… déconnecté (le moins récemment utilisé)`);
    }
  }

  pendingTickets.set(p.nonce, { ticket: signed, at: Date.now() });
  return signed;
}
