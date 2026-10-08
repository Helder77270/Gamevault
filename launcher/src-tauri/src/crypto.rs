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

/// ECDSA over sha256(message), compact r||s with low s — what ticketd checks
/// with @noble/curves secp256k1.verify.
pub fn sign_prehash_with(priv_key: &[u8; 32], message: &[u8]) -> Result<[u8; 64], String> {
    use k256::ecdsa::signature::hazmat::PrehashSigner;
    use k256::ecdsa::{Signature, SigningKey};
    let key = SigningKey::from_slice(priv_key).map_err(|e| e.to_string())?;
    let sig: Signature = key.sign_prehash(&Sha256::digest(message)).map_err(|e| e.to_string())?;
    let sig = sig.normalize_s().unwrap_or(sig);
    Ok(sig.to_bytes().into())
}

/// Signs with the DEVICE key from the keystore. Only lib.rs calls this, on a
/// message it builds itself (never a webview-supplied payload).
pub fn device_sign(message: &[u8]) -> Result<[u8; 64], String> {
    sign_prehash_with(&device_priv()?, message)
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

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::signature::hazmat::PrehashVerifier;
    use k256::ecdsa::{Signature, VerifyingKey};

    #[test]
    fn device_signature_verifies_over_sha256_prehash() {
        let priv_key = [7u8; 32];
        let msg = b"GameVault Device Session\nwallet: 0x0000000000000000000000000000000000000001";
        let sig = sign_prehash_with(&priv_key, msg).unwrap();
        let vk = VerifyingKey::from(SecretKey::from_slice(&priv_key).unwrap().public_key());
        let parsed = Signature::from_slice(&sig).unwrap();
        assert!(parsed.normalize_s().is_none(), "low-s expected");
        assert!(vk.verify_prehash(&Sha256::digest(msg), &parsed).is_ok());
        assert!(vk.verify_prehash(&Sha256::digest(b"another message"), &parsed).is_err());
        // Cross-vector: @noble/curves (ticketd) signs the same bytes identically
        // (RFC 6979 deterministic nonces) — computed with secp256k1.sign().
        assert_eq!(
            hex::encode(sig),
            "9bad8d271565390667511988ad6bc4c53b1c61374f504b31a66da8573d8724482eddc57118d4c08d231995554d1e4bf8c7c81a4ac5f37e79f9bab4c578cda8be"
        );
    }
}
