// Core ticket issuance — the only place that turns on-chain ownership into
// a playable ticket. Kept HTTP-free for testability (see server.ts).

import { createPublicClient, http, verifyMessage } from "viem";
import { baseSepolia } from "viem/chains";
import { signTicket, wrapKey, hex, unhex, type SignedTicket, type Ticket } from "@gamevault/shared";
import { parsePairingMessage } from "@gamevault/shared/siwe";
import { DEV_PLATFORM_PRIV, DEV_CONTENT_KEY } from "@gamevault/shared/devkeys";
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

const licenseAddress = (process.env.GAMELICENSE_ADDRESS || DEPLOYMENTS.gameLicense || undefined) as
  | `0x${string}`
  | undefined;
if (!licenseAddress) {
  console.warn("⚠ GAMELICENSE_ADDRESS not set — ownerOf() check SKIPPED (dev mode, P1 pending; see TODO.md)");
}

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.RPC_URL),
});

/** Per-edition content keys. Dev: the deterministic fixture key. Production:
 *  random keys in a store, one per edition. */
function contentKeyFor(_contract: string, _tokenId: string): Uint8Array {
  return DEV_CONTENT_KEY;
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
    const owner = await client.readContract({
      address: licenseAddress,
      abi: ERC721_OWNER_OF,
      functionName: "ownerOf",
      args: [BigInt(p.tokenId)],
    });
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
    wrappedContentKey: hex(wrapKey(contentKeyFor(p.contract, p.tokenId), unhex(p.devicePubKey))),
    issuedAt: now,
    expiresAt: now + TICKET_TTL_SEC,
  };
  const signed = signTicket(ticket, platformPriv());
  pendingTickets.set(p.nonce, { ticket: signed, at: Date.now() });
  return signed;
}
