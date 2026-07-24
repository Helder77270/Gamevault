// Core ticket issuance — the only place that turns on-chain ownership into
// a playable ticket. Kept HTTP-free for testability (see server.ts).

import { createPublicClient, http, verifyMessage } from "viem";
import { baseSepolia } from "viem/chains";
import { signTicket, wrapKey, hex, unhex, type SignedTicket, type Ticket } from "@gamevault/shared";
import { parsePairingMessage } from "@gamevault/shared/siwe";
import { DEV_PLATFORM_PRIV, devContentKeyFor } from "@gamevault/shared/devkeys";
import { LICENSE_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";

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

/** Per-edition content keys, resolved via the token's on-chain edition.
 *  Dev: deterministic derivation. Production: random keys in a store. */
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

  // 4. The signer really owns the license (live on-chain check)
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
    if (owner.toLowerCase() !== p.address.toLowerCase()) {
      throw new Error(`ownerOf(${p.tokenId}) is ${owner}, not the signer`);
    }
  }

  usedNonces.add(p.nonce);

  // 5. Seal the content key to the DEVICE and sign the ticket
  const now = Math.floor(Date.now() / 1000);
  const ticket: Ticket = {
    tokenId: p.tokenId,
    contract: p.contract,
    chainId: p.chainId,
    ownerAddress: p.address,
    devicePubKey: p.devicePubKey,
    wrappedContentKey: hex(wrapKey(await contentKeyFor(p.tokenId), unhex(p.devicePubKey))),
    issuedAt: now,
    expiresAt: now + TICKET_TTL_SEC,
  };
  const signed = signTicket(ticket, platformPriv());
  pendingTickets.set(p.nonce, { ticket: signed, at: Date.now() });
  return signed;
}
