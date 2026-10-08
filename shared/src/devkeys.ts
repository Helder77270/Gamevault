// DEV ONLY — deterministic keys derived from fixed strings so every
// teammate's fixtures match. NEVER use these outside dev fixtures; the
// real platform key lives in ticketd's .env, the real device key in the
// launcher's OS keystore.

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes } from "@noble/hashes/utils";

export const DEV_PLATFORM_PRIV = sha256(utf8ToBytes("gamevault dev platform key v1"));
export const DEV_PLATFORM_PUB = secp256k1.getPublicKey(DEV_PLATFORM_PRIV, true);

export const DEV_DEVICE_PRIV = sha256(utf8ToBytes("gamevault dev device key v1"));
export const DEV_DEVICE_PUB = secp256k1.getPublicKey(DEV_DEVICE_PRIV, true);

// Dev content keys: deterministic, used only by the selftests (no chain, no
// stored key). Real builds always get a random key in ticketd's store.
export const DEV_CONTENT_KEY = sha256(utf8ToBytes("gamevault dev content key v1"));

/** Per-edition dev content key. Edition 2 = the original runner key
 *  (pinned before this scheme existed); later editions derive from their id. */
export function devContentKeyFor(editionId: string): Uint8Array {
  if (editionId === "2") return DEV_CONTENT_KEY;
  return sha256(utf8ToBytes(`gamevault dev content key ed${editionId}`));
}
