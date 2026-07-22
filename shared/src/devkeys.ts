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
