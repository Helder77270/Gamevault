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

const KEYRING_SERVICE: &str = "gamevault-launcher";
const KEYRING_USER: &str = "device-key";

/// Load the device private key from the OS keystore (Windows Credential
/// Manager), creating it on first use. The key never leaves the keystore
/// except into this process's memory.
pub fn device_priv() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(stored) => hex::decode(&stored)
            .map_err(|e| e.to_string())?
            .try_into()
            .map_err(|_| "stored device key has wrong length".into()),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            loop {
                getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
                if SecretKey::from_slice(&bytes).is_ok() {
                    break; // valid scalar (overwhelmingly likely first try)
                }
            }
            entry.set_password(&hex::encode(bytes)).map_err(|e| e.to_string())?;
            Ok(bytes)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Compressed SEC1 pubkey of this device (0x-hex) — safe to share (QR).
pub fn device_pubkey_hex() -> Result<String, String> {
    let sk = SecretKey::from_slice(&device_priv()?).map_err(|e| e.to_string())?;
    let point = sk.public_key().to_encoded_point(true);
    Ok(format!("0x{}", hex::encode(point.as_bytes())))
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
