// Storage backend for encrypted game builds — decided 2026-07-23.
// build.enc is PUBLIC bytes (encrypted once, useless without a ticket), so
// availability and confidentiality are separate problems: this module only
// solves availability + integrity. IPFS content-addressing gives integrity
// for free: the CID + sha256 recorded on-chain (GameRegistry) let any
// launcher verify what it downloaded.
//
// THE swap point: to move to 0G or another network later, reimplement
// putBuild/fetchBuild here — nothing else changes.
//
// Self-contained module (subpath export: @gamevault/shared/storage).
// Works in Node 18+ and browsers (fetch/FormData/Blob).

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export interface StoredBuild {
  cid: string;
  /** 0x-hex sha256 of the encrypted bytes — goes on-chain next to the CID */
  sha256: string;
  size: number;
}

const PINATA_PIN_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
export const DEFAULT_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

const digest = (bytes: Uint8Array): string => `0x${bytesToHex(sha256(bytes))}`;

/** Pin an encrypted build to IPFS via Pinata. jwt: Pinata API JWT. */
export async function putBuild(bytes: Uint8Array, name: string, jwt: string): Promise<StoredBuild> {
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart]), name);
  form.append("pinataMetadata", JSON.stringify({ name }));
  const res = await fetch(PINATA_PIN_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Pinata ${res.status}: ${await res.text()}`);
  const { IpfsHash } = (await res.json()) as { IpfsHash: string };
  return { cid: IpfsHash, sha256: digest(bytes), size: bytes.length };
}

/**
 * Fetch a build by CID and verify its integrity. ALWAYS pass expectedSha256
 * when it is known (from the on-chain registry) — a gateway is untrusted.
 */
export async function fetchBuild(cid: string, expectedSha256?: string, gateway = DEFAULT_GATEWAY): Promise<Uint8Array> {
  const res = await fetch(`${gateway}${cid}`);
  if (!res.ok) throw new Error(`IPFS gateway ${res.status} for ${cid}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (expectedSha256 && digest(bytes) !== expectedSha256.toLowerCase()) {
    throw new Error(`integrity check FAILED for ${cid} — gateway served tampered or wrong bytes`);
  }
  return bytes;
}
