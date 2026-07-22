// ECIES over secp256k1: seal a small secret (the AES content key) so that
// ONLY the holder of a given private key can open it. Used to wrap the
// content key to the launcher's device key.
//
// Envelope layout (all concatenated, hex-encoded in tickets):
//   [33B ephemeral pubkey] [12B nonce] [ciphertext + 16B GCM tag]

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, randomBytes } from "@noble/hashes/utils";
import { gcm } from "@noble/ciphers/aes";

const EPH_PUB_LEN = 33;
const NONCE_LEN = 12;

export function wrapKey(secret: Uint8Array, recipientPubKey: Uint8Array): Uint8Array {
  // One-shot keypair, used for this envelope only, then discarded.
  const ephemeralPriv = secp256k1.utils.randomPrivateKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, true);

  // ECDH: ephemeralPriv × recipientPub = shared point. Only the recipient
  // can recompute it (recipientPriv × ephemeralPub gives the same point).
  const sharedPoint = secp256k1.getSharedSecret(ephemeralPriv, recipientPubKey, true);
  const aesKey = sha256(sharedPoint); // KDF: point -> uniform 32-byte key

  const nonce = randomBytes(NONCE_LEN);
  const ciphertext = gcm(aesKey, nonce).encrypt(secret);
  return concatBytes(ephemeralPub, nonce, ciphertext);
}

export function unwrapKey(envelope: Uint8Array, recipientPrivKey: Uint8Array): Uint8Array {
  const ephemeralPub = envelope.slice(0, EPH_PUB_LEN);
  const nonce = envelope.slice(EPH_PUB_LEN, EPH_PUB_LEN + NONCE_LEN);
  const ciphertext = envelope.slice(EPH_PUB_LEN + NONCE_LEN);

  const sharedPoint = secp256k1.getSharedSecret(recipientPrivKey, ephemeralPub, true);
  const aesKey = sha256(sharedPoint);
  // GCM authenticates: a tampered envelope throws instead of returning garbage.
  return gcm(aesKey, nonce).decrypt(ciphertext);
}
