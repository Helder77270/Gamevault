// Encrypts the game build ONCE with the AES-256-GCM content key.
// Layout of build.enc: [12B nonce][ciphertext + 16B GCM tag].
// The launcher's Rust side mirrors this exact layout when decrypting.

import { gcm } from "@noble/ciphers/aes";
import { concatBytes, randomBytes } from "@noble/hashes/utils";

const NONCE_LEN = 12;

export function encryptBuild(build: Uint8Array, contentKey: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LEN);
  return concatBytes(nonce, gcm(contentKey, nonce).encrypt(build));
}

export function decryptBuild(enc: Uint8Array, contentKey: Uint8Array): Uint8Array {
  return gcm(contentKey, enc.slice(0, NONCE_LEN)).decrypt(enc.slice(NONCE_LEN));
}
