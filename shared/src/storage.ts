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
// Public gateways are flaky (transient 404s while a pin propagates, 429
// rate limits) — a fetch walks this list, retrying the pinning gateway
// first. Integrity never depends on the gateway: sha256 is checked after.
export const GATEWAYS = [DEFAULT_GATEWAY, "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"];

const digest = (bytes: Uint8Array): string => `0x${bytesToHex(sha256(bytes))}`;

/** Pin an encrypted build to IPFS via Pinata. jwt: Pinata API JWT. */
export async function putBuild(bytes: Uint8Array, name: string, jwt: string): Promise<StoredBuild> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), name); // copy: an ArrayBuffer-backed view is a valid BlobPart in every lib
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
 *
 * Resilient by design: the pinning gateway is tried twice (transient 404s
 * happen right after pinning), then the public fallbacks. A wrong-bytes
 * response fails the sha256 check and the next gateway is tried.
 */
const FETCH_TIMEOUT_MS = 60_000;
const MAX_BUILD_BYTES = 512 * 1024 * 1024;

export async function fetchBuild(cid: string, expectedSha256?: string, gateway?: string | string[]): Promise<Uint8Array> {
  const order = Array.isArray(gateway) ? gateway : gateway ? [gateway] : [GATEWAYS[0], ...GATEWAYS];
  let lastErr = "";
  for (const gw of order) {
    try {
      const res = await fetch(`${gw}${cid}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        lastErr = `IPFS gateway ${res.status} for ${cid} (${gw})`;
        continue;
      }
      if (Number(res.headers.get("content-length") ?? 0) > MAX_BUILD_BYTES) {
        lastErr = `build too large on ${gw}`;
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_BUILD_BYTES) {
        lastErr = `build too large on ${gw}`;
        continue;
      }
      if (expectedSha256 && digest(bytes) !== expectedSha256.toLowerCase()) {
        lastErr = `integrity check FAILED for ${cid} — ${gw} served tampered or wrong bytes`;
        continue;
      }
      return bytes;
    } catch (e) {
      lastErr = `IPFS gateway unreachable (${gw}): ${String(e)}`;
    }
  }
  throw new Error(lastErr || `IPFS fetch failed for ${cid}`);
}
