//! Mirrors shared/src/ecies.ts and buildcrypto.ts byte for byte.
//! ECIES envelope: [33B ephemeral pubkey][12B nonce][ciphertext+tag]
//! build.enc:      [12B nonce][ciphertext+tag]
//! KDF: sha256(compressed shared point) — noble's getSharedSecret(_, _, true)
//! returns the COMPRESSED point (33B), so we must compress here too.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{PublicKey, SecretKey};
use sha2::{Digest, Sha256};

const EPH_PUB_LEN: usize = 33;
const NONCE_LEN: usize = 12;

/// DEV ONLY — same derivation as shared/src/devkeys.ts. Replaced by the OS
/// keystore once real pairing lands.
pub fn dev_device_priv() -> [u8; 32] {
    Sha256::digest(b"gamevault dev device key v1").into()
}

fn aes_key_from_ecdh(scalar_bytes: &[u8; 32], peer_pub: &[u8]) -> Result<[u8; 32], String> {
    let secret = SecretKey::from_slice(scalar_bytes).map_err(|e| e.to_string())?;
    let peer = PublicKey::from_sec1_bytes(peer_pub).map_err(|e| e.to_string())?;
    let shared = peer.to_projective() * *secret.to_nonzero_scalar().as_ref();
    let compressed = shared.to_affine().to_encoded_point(true);
    Ok(Sha256::digest(compressed.as_bytes()).into())
}

fn gcm_decrypt(key: &[u8], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|e| e.to_string())?
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "authentication failed (wrong key or tampered data)".to_string())
}

/// Open the ECIES envelope (wrappedContentKey) with the device private key.
pub fn ecies_unwrap(envelope: &[u8], device_priv: &[u8; 32]) -> Result<Vec<u8>, String> {
    if envelope.len() < EPH_PUB_LEN + NONCE_LEN + 16 {
        return Err("envelope too short".into());
    }
    let (eph_pub, rest) = envelope.split_at(EPH_PUB_LEN);
    let (nonce, ciphertext) = rest.split_at(NONCE_LEN);
    let aes_key = aes_key_from_ecdh(device_priv, eph_pub)?;
    gcm_decrypt(&aes_key, nonce, ciphertext)
}

/// Decrypt build.enc with the recovered content key. Plaintext stays in RAM.
pub fn decrypt_build(enc: &[u8], content_key: &[u8]) -> Result<Vec<u8>, String> {
    if enc.len() < NONCE_LEN + 16 {
        return Err("build.enc too short".into());
    }
    let (nonce, ciphertext) = enc.split_at(NONCE_LEN);
    gcm_decrypt(content_key, nonce, ciphertext)
}
