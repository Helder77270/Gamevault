// The offline pass: a platform-signed statement binding an NFT license to
// one authorized device, carrying the sealed content key.

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

export interface Ticket {
  tokenId: string;
  contract: string;
  chainId: number;
  ownerAddress: string;
  /** Compressed secp256k1 pubkey of the authorized launcher device (hex, 0x-prefixed) */
  devicePubKey: string;
  /** ECIES envelope sealing the AES content key to devicePubKey (hex, 0x-prefixed) */
  wrappedContentKey: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SignedTicket extends Ticket {
  platformSignature: string;
}

export const hex = (b: Uint8Array): string => `0x${bytesToHex(b)}`;
export const unhex = (s: string): Uint8Array => hexToBytes(s.replace(/^0x/, ""));

// Fixed field order — JSON.stringify key order is insertion order, so signer
// and verifier MUST build the payload through this function only.
function canonicalPayload(t: Ticket): Uint8Array {
  return utf8ToBytes(
    JSON.stringify({
      tokenId: t.tokenId,
      contract: t.contract.toLowerCase(),
      chainId: t.chainId,
      ownerAddress: t.ownerAddress.toLowerCase(),
      devicePubKey: t.devicePubKey.toLowerCase(),
      wrappedContentKey: t.wrappedContentKey.toLowerCase(),
      issuedAt: t.issuedAt,
      expiresAt: t.expiresAt,
    }),
  );
}

export function signTicket(t: Ticket, platformPrivKey: Uint8Array): SignedTicket {
  const digest = sha256(canonicalPayload(t));
  const signature = secp256k1.sign(digest, platformPrivKey);
  return { ...t, platformSignature: `0x${signature.toCompactHex()}` };
}

export function verifyTicket(st: SignedTicket, platformPubKey: Uint8Array): boolean {
  const { platformSignature, ...ticket } = st;
  const digest = sha256(canonicalPayload(ticket));
  try {
    return secp256k1.verify(unhex(platformSignature), digest, platformPubKey);
  } catch {
    return false; // malformed signature/pubkey counts as invalid, never as a crash
  }
}

export function isExpired(t: Ticket, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return nowSec > t.expiresAt;
}
