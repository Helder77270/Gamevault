// Core ticket issuance — the only place that turns on-chain ownership into
// a playable ticket. Kept HTTP-free for testability (see server.ts).

import { createPublicClient, encodePacked, http, keccak256, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { signTicket, wrapKey, hex, unhex, encryptBuild, type SignedTicket, type Ticket } from "@gamevault/shared";
import { parsePairingMessage } from "@gamevault/shared/siwe";
import { DEV_PLATFORM_PRIV, devContentKeyFor } from "@gamevault/shared/devkeys";
import { LICENSE_ABI, REGISTRY_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";
import { fetchBuild, putBuild, type StoredBuild } from "@gamevault/shared/storage";

const TICKET_TTL_SEC = 30 * 24 * 3600; // 30-day offline window
const MESSAGE_MAX_AGE_MS = 10 * 60 * 1000; // pairing message freshness

const ERC721_OWNER_OF = [
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "userOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "userExpires",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// --- Config (env) -----------------------------------------------------------

function platformPriv(): Uint8Array {
  const env = process.env.PLATFORM_PRIVKEY;
  if (env) return unhex(env);
  console.warn("⚠ PLATFORM_PRIVKEY not set — using the DEV platform key (fixtures only)");
  return DEV_PLATFORM_PRIV;
}

// GAMEVAULT_SKIP_OWNER_CHECK=1 is for the selftest only (no chain there)
const skipOwnerCheck = process.env.GAMEVAULT_SKIP_OWNER_CHECK === "1";
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

const KEYSTORE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../data/content-keys.json");

function keyStore(): Record<string, string> {
  return existsSync(KEYSTORE_PATH) ? JSON.parse(readFileSync(KEYSTORE_PATH, "utf8")) : {};
}

function saveKey(cid: string, keyHex: string): void {
  mkdirSync(dirname(KEYSTORE_PATH), { recursive: true });
  const store = keyStore();
  store[cid] = keyHex;
  writeFileSync(KEYSTORE_PATH, JSON.stringify(store, null, 2));
}

/** Studio publish: encrypt with a fresh random key, pin to IPFS, remember
 *  the key by CID. The studio then records the CID on-chain themselves. */
export async function publishBuild(plain: Uint8Array, name: string): Promise<StoredBuild> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT manquant dans ticketd/.env");
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const enc = encryptBuild(plain, contentKey);
  const stored = await putBuild(enc, name, jwt);
  saveKey(stored.cid, hex(contentKey));
  cacheBuild(stored.cid, enc); // primary distribution — IPFS is the backup
  console.log(`✔ build publié: ${name} -> ${stored.cid} (clé mémorisée, cache local)`);
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

export function cacheBuild(cid: string, bytes: Uint8Array): void {
  mkdirSync(BUILDS_DIR, { recursive: true });
  writeFileSync(join(BUILDS_DIR, cid), bytes);
}

export async function getBuild(cid: string): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9]{10,100}$/.test(cid)) throw new Error("CID invalide");
  const p = join(BUILDS_DIR, cid);
  if (existsSync(p)) return new Uint8Array(readFileSync(p));
  const bytes = await fetchBuild(cid); // server-side: no CORS, gateway fallback
  cacheBuild(cid, bytes);
  console.log(`✔ build ${cid} récupéré d'IPFS -> cache local (${bytes.length} o)`);
  return bytes;
}

// ── Friends DB (décidé 2026-10-07) ───────────────────────────────────────
// L'amitié est OFF-CHAIN : une transaction par ami tuait l'usage. Ici,
// chaque action est un simple message signé par le wallet (zéro gas).
// Le contrat garde sa garde : au prêt, la plateforme signe une ATTESTATION
// « owner et borrower amis depuis T » que lend() vérifie on-chain avec
// l'âge minimal. Backdate = simulation des 3 jours en dev.

const FRIENDS_PATH = join(dirname(fileURLToPath(import.meta.url)), "../data/friends.json");
const ATTEST_TTL_SEC = 10 * 60;

interface FriendsDb {
  /** "from|to" (lowercase) -> ms de la demande en attente */
  requests: Record<string, number>;
  /** "lo|hi" (paire triée, lowercase) -> amis depuis (secondes unix) */
  friendships: Record<string, number>;
}

function friendsDb(): FriendsDb {
  if (!existsSync(FRIENDS_PATH)) return { requests: {}, friendships: {} };
  return JSON.parse(readFileSync(FRIENDS_PATH, "utf8"));
}

function saveFriendsDb(db: FriendsDb): void {
  mkdirSync(dirname(FRIENDS_PATH), { recursive: true });
  writeFileSync(FRIENDS_PATH, JSON.stringify(db, null, 2));
}

const pairKey = (a: string, b: string): string => {
  const [lo, hi] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${lo}|${hi}`;
};

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const friendNonces = new Set<string>();

/** Message signé côté wallet :
 *  GameVault Amis\naction: request|accept|decline|remove\nme: 0x…\nother: 0x…\nat: ISO\nnonce: uuid */
export async function applyFriendAction(message: string, signature: `0x${string}`): Promise<{ ok: true }> {
  const get = (k: string): string => message.match(new RegExp(`^${k}: (.+)$`, "m"))?.[1]?.trim() ?? "";
  const action = get("action");
  const me = get("me");
  const other = get("other");
  const at = get("at");
  const nonce = get("nonce");
  if (!message.startsWith("GameVault Amis")) throw new Error("message inattendu");
  if (!["request", "accept", "decline", "remove"].includes(action)) throw new Error("action inconnue");
  if (!ADDR_RE.test(me) || !ADDR_RE.test(other)) throw new Error("adresse invalide");
  if (me.toLowerCase() === other.toLowerCase()) throw new Error("pas d'amitié avec soi-même");
  const age = Date.now() - Date.parse(at);
  if (!Number.isFinite(age) || age < -60_000 || age > MESSAGE_MAX_AGE_MS) throw new Error("message expiré");
  if (friendNonces.has(nonce)) throw new Error("nonce déjà utilisé");
  const sigOk = await verifyMessage({ address: me as `0x${string}`, message, signature });
  if (!sigOk) throw new Error("signature invalide");
  friendNonces.add(nonce);

  const db = friendsDb();
  const meL = me.toLowerCase();
  const otherL = other.toLowerCase();
  const pk2 = pairKey(me, other);
  if (action === "request") {
    if (db.friendships[pk2]) throw new Error("déjà amis");
    db.requests[`${meL}|${otherL}`] = Date.now();
  } else if (action === "accept") {
    if (!db.requests[`${otherL}|${meL}`]) throw new Error("aucune demande de cette adresse");
    delete db.requests[`${otherL}|${meL}`];
    delete db.requests[`${meL}|${otherL}`];
    db.friendships[pk2] = Math.floor(Date.now() / 1000);
  } else if (action === "decline") {
    delete db.requests[`${otherL}|${meL}`];
  } else {
    delete db.friendships[pk2];
  }
  saveFriendsDb(db);
  console.log(`✔ amis: ${action} ${me} <-> ${other}`);
  return { ok: true };
}

export function friendsOf(addr: string): { friends: { addr: string; since: number }[]; incoming: string[]; outgoing: string[] } {
  if (!ADDR_RE.test(addr)) throw new Error("adresse invalide");
  const db = friendsDb();
  const meL = addr.toLowerCase();
  const friends: { addr: string; since: number }[] = [];
  for (const [key, since] of Object.entries(db.friendships)) {
    const [lo, hi] = key.split("|");
    if (lo === meL) friends.push({ addr: hi, since });
    else if (hi === meL) friends.push({ addr: lo, since });
  }
  const incoming: string[] = [];
  const outgoing: string[] = [];
  for (const key of Object.keys(db.requests)) {
    const [from, to] = key.split("|");
    if (to === meL) incoming.push(from);
    if (from === meL) outgoing.push(to);
  }
  return { friends, incoming, outgoing };
}

/** L'attestation que lend() vérifie on-chain. Gratuite, courte durée. */
export function attestFriendship(owner: string, borrower: string): { since: number; deadline: number; sig: `0x${string}`; license: string } | Promise<never> {
  if (!ADDR_RE.test(owner) || !ADDR_RE.test(borrower)) throw new Error("adresse invalide");
  const license = DEPLOYMENTS.gameLicense;
  if (!license) throw new Error("GameLicense non déployé");
  const since = friendsDb().friendships[pairKey(owner, borrower)];
  if (!since) throw new Error("pas amis — la demande doit être acceptée d'abord");
  const deadline = Math.floor(Date.now() / 1000) + ATTEST_TTL_SEC;
  const digest = keccak256(
    encodePacked(
      ["string", "uint256", "address", "address", "address", "uint64", "uint64"],
      ["GAMEVAULT_FRIEND_ATTEST", BigInt(84532), license, owner as `0x${string}`, borrower as `0x${string}`, BigInt(since), BigInt(deadline)],
    ),
  );
  const account = privateKeyToAccount(`0x${Buffer.from(platformPriv()).toString("hex")}` as `0x${string}`);
  return account.signMessage({ message: { raw: digest } }).then((sig) => ({ since, deadline, sig, license })) as never;
}

/** DEV : antidater une amitié pour simuler les 3 jours (ticketd est local). */
export function backdateFriendship(a: string, b: string, sinceSec: number): { ok: true; since: number } {
  if (!ADDR_RE.test(a) || !ADDR_RE.test(b)) throw new Error("adresse invalide");
  if (!Number.isFinite(sinceSec) || sinceSec <= 0) throw new Error("since invalide");
  const db = friendsDb();
  const key = pairKey(a, b);
  if (!db.friendships[key]) throw new Error("pas amis — accepter d'abord, antidater ensuite");
  db.friendships[key] = Math.floor(sinceSec);
  saveFriendsDb(db);
  console.warn(`⚠ DEV: amitié ${a} <-> ${b} antidatée au ${new Date(sinceSec * 1000).toISOString()}`);
  return { ok: true, since: Math.floor(sinceSec) };
}

async function contentKeyFor(tokenId: string): Promise<Uint8Array> {
  let editionId = "2"; // runner fallback when no chain (selftest)
  if (licenseAddress) {
    const ed = await client.readContract({
      address: licenseAddress,
      abi: LICENSE_ABI,
      functionName: "editionOf",
      args: [BigInt(tokenId)],
    });
    editionId = ed.toString();
    // published edition? resolve its on-chain CID -> stored key
    if (DEPLOYMENTS.gameRegistry) {
      const edition = await client.readContract({
        address: DEPLOYMENTS.gameRegistry as `0x${string}`,
        abi: REGISTRY_ABI,
        functionName: "editions",
        args: [BigInt(editionId)],
      });
      const stored = keyStore()[edition[4]];
      if (stored) return unhex(stored);
    }
  }
  return devContentKeyFor(editionId);
}

// --- Issuance ---------------------------------------------------------------

const usedNonces = new Set<string>();

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

  // 2. Freshness + replay protection
  const age = Date.now() - Date.parse(p.issuedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > MESSAGE_MAX_AGE_MS) {
    throw new Error("pairing message expired — retry from the launcher");
  }
  if (usedNonces.has(p.nonce)) throw new Error("nonce already used");

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
        abi: ERC721_OWNER_OF,
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
        abi: ERC721_OWNER_OF,
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
        abi: ERC721_OWNER_OF,
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

  usedNonces.add(p.nonce);

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
  const signed = signTicket(ticket, platformPriv());
  pendingTickets.set(p.nonce, { ticket: signed, at: Date.now() });
  return signed;
}
