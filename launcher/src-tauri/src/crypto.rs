//! Device key: TPM-sealed when possible (crate::tpm), wiped from memory
//! after each use (zeroize). Mirrors shared/src/ecies.ts and buildcrypto.ts byte for byte.
//! ECIES envelope: [33B ephemeral pubkey][12B nonce][ciphertext+tag]
//! build.enc:      [12B nonce][ciphertext+tag]
//! KDF: sha256(compressed shared point) — noble's getSharedSecret(_, _, true)
//! returns the COMPRESSED point (33B), so we must compress here too.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{PublicKey, SecretKey};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

use crate::tpm;

const EPH_PUB_LEN: usize = 33;
const NONCE_LEN: usize = 12;

const KEYRING_SERVICE: &str = "gamevault-launcher";
/// Software mode (no TPM): the key itself, hex, in Credential Manager.
const KEYRING_USER: &str = "device-key";
/// TPM mode: the key sealed by this machine's TPM (crate::tpm), hex.
const KEYRING_SEALED: &str = "device-key-tpm";

/// Where this machine's device key rests.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum KeyMode {
    /// Sealed by the TPM: useless on any other machine.
    Tpm,
    /// Plain in Credential Manager (no TPM 2.0, VM, GAMEVAULT_NO_TPM=1).
    Software,
}

struct DeviceState {
    mode: Option<KeyMode>,
    pubkey: Option<String>,
}

/// One lock for load / migration / creation: two first calls racing would
/// otherwise create two identities. Also caches the PUBLIC key, so showing
/// or comparing it never needs the private key again.
static DEVICE: Mutex<DeviceState> = Mutex::new(DeviceState { mode: None, pubkey: None });

fn entry(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, user).map_err(|e| e.to_string())
}

fn decode_key(hex_str: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let bytes = Zeroizing::new(hex::decode(hex_str).map_err(|e| e.to_string())?);
    if bytes.len() != 32 {
        return Err("stored device key has wrong length".into());
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn generate_key() -> Result<Zeroizing<[u8; 32]>, String> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    loop {
        getrandom::getrandom(bytes.as_mut()).map_err(|e| e.to_string())?;
        if SecretKey::from_slice(bytes.as_ref()).is_ok() {
            return Ok(bytes); // valid scalar (overwhelmingly likely first try)
        }
    }
}

fn pubkey_of(key: &[u8; 32]) -> Result<String, String> {
    let sk = SecretKey::from_slice(key).map_err(|e| e.to_string())?; // zeroized on drop (k256)
    Ok(format!("0x{}", hex::encode(sk.public_key().to_encoded_point(true).as_bytes())))
}

/// Software mode: the plain key in Credential Manager, created on first use.
fn software_key(plain: &keyring::Entry) -> Result<Zeroizing<[u8; 32]>, String> {
    match plain.get_password() {
        Ok(stored) => decode_key(&Zeroizing::new(stored)),
        Err(keyring::Error::NoEntry) => {
            let key = generate_key()?;
            plain.set_password(&Zeroizing::new(hex::encode(key.as_ref()))).map_err(|e| e.to_string())?;
            Ok(key)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Seals `key` with the TPM and checks the blob opens again before trusting
/// it; returns the hex blob to store.
fn seal_checked(key: &[u8; 32]) -> Result<String, tpm::TpmError> {
    let blob = tpm::seal(key)?;
    let back = tpm::unseal(&blob)?;
    if back.as_slice() != key.as_slice() {
        return Err(tpm::TpmError::Failed("le descellement ne rend pas la clé".into()));
    }
    Ok(hex::encode(blob))
}

fn load_or_create() -> Result<(Zeroizing<[u8; 32]>, KeyMode), String> {
    let sealed = entry(KEYRING_SEALED)?;
    let plain = entry(KEYRING_USER)?;
    let tpm_ok = tpm::available().is_ok();

    match sealed.get_password() {
        Ok(blob_hex) => {
            if !tpm_ok {
                // Never mint a second identity silently: the sealed key may
                // come back with the TPM (re-enabled in the BIOS, env var).
                return Err("la clé de cet appareil est scellée dans la puce TPM, qui ne répond pas : réactivez le TPM (BIOS) ou retirez GAMEVAULT_NO_TPM".into());
            }
            let blob = hex::decode(&blob_hex).map_err(|e| e.to_string())?;
            match tpm::unseal(&blob) {
                Ok(bytes) if bytes.len() == 32 => {
                    let mut key = Zeroizing::new([0u8; 32]);
                    key.copy_from_slice(&bytes);
                    return Ok((key, KeyMode::Tpm));
                }
                Ok(_) => return Err("clé scellée de longueur invalide".into()),
                // TPM cleared / new motherboard: that key is gone for good.
                // A new identity follows; the cards ask to pair again.
                Err(tpm::TpmError::KeyLost) => {
                    eprintln!("[device-key] clé TPM perdue : nouvelle clé d'appareil, réappairage nécessaire");
                    sealed.delete_credential().map_err(|e| e.to_string())?;
                }
                Err(e) => return Err(e.to_string()), // transient: keep the key
            }
        }
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }

    if !tpm_ok {
        return Ok((software_key(&plain)?, KeyMode::Software));
    }
    // TPM here: migrate the existing software key (same identity, no
    // re-pairing) or create a new one, then keep only the sealed copy.
    let key = match plain.get_password() {
        Ok(stored) => decode_key(&Zeroizing::new(stored))?,
        Err(keyring::Error::NoEntry) => generate_key()?,
        Err(e) => return Err(e.to_string()),
    };
    match seal_checked(&key) {
        Ok(blob_hex) => {
            sealed.set_password(&blob_hex).map_err(|e| e.to_string())?;
            match plain.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(e.to_string()),
            }
            Ok((key, KeyMode::Tpm))
        }
        Err(e) => {
            // The TPM refused (policy, busy, unsupported padding…): keep
            // working in software mode rather than locking the player out.
            eprintln!("[device-key] scellement TPM impossible ({e}) : clé logicielle");
            if matches!(plain.get_password(), Err(keyring::Error::NoEntry)) {
                plain.set_password(&Zeroizing::new(hex::encode(key.as_ref()))).map_err(|e| e.to_string())?;
            }
            Ok((key, KeyMode::Software))
        }
    }
}

/// The device private key — TPM-sealed when this machine has a TPM 2.0,
/// otherwise in Credential Manager. Wiped from memory when the returned
/// value drops: callers keep it only for the operation at hand.
pub fn device_priv() -> Result<Zeroizing<[u8; 32]>, String> {
    let mut st = DEVICE.lock().unwrap_or_else(|e| e.into_inner());
    let (key, mode) = load_or_create()?;
    st.mode = Some(mode);
    if st.pubkey.is_none() {
        st.pubkey = Some(pubkey_of(&key)?);
    }
    Ok(key)
}

/// Compressed SEC1 pubkey of this device (0x-hex) — safe to share (QR).
/// Cached: the private key is loaded once per run for this.
pub fn device_pubkey_hex() -> Result<String, String> {
    if let Some(p) = DEVICE.lock().unwrap_or_else(|e| e.into_inner()).pubkey.clone() {
        return Ok(p);
    }
    drop(device_priv()?);
    DEVICE.lock().unwrap_or_else(|e| e.into_inner()).pubkey.clone().ok_or_else(|| "clé d'appareil indisponible".into())
}

/// TPM or software — for Settings › System.
pub fn device_key_mode() -> Result<KeyMode, String> {
    if let Some(m) = DEVICE.lock().unwrap_or_else(|e| e.into_inner()).mode {
        return Ok(m);
    }
    drop(device_priv()?);
    DEVICE.lock().unwrap_or_else(|e| e.into_inner()).mode.ok_or_else(|| "clé d'appareil indisponible".into())
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
    let key = device_priv()?;
    sign_prehash_with(&key, message)
}

fn aes_key_from_ecdh(scalar_bytes: &[u8; 32], peer_pub: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let secret = SecretKey::from_slice(scalar_bytes).map_err(|e| e.to_string())?; // zeroized on drop
    let peer = PublicKey::from_sec1_bytes(peer_pub).map_err(|e| e.to_string())?;
    let mut scalar = *secret.to_nonzero_scalar().as_ref();
    let mut shared = peer.to_projective() * scalar;
    scalar.zeroize();
    let compressed = Zeroizing::new(shared.to_affine().to_encoded_point(true).as_bytes().to_vec());
    shared.zeroize();
    Ok(Zeroizing::new(Sha256::digest(&*compressed).into()))
}

fn gcm_decrypt(key: &[u8], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|e| e.to_string())?
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "authentication failed (wrong key or tampered data)".to_string())
}

/// Open the ECIES envelope (wrappedContentKey) with the device private key.
/// The content key comes back wiped-on-drop.
pub fn ecies_unwrap(envelope: &[u8], device_priv: &[u8; 32]) -> Result<Zeroizing<Vec<u8>>, String> {
    if envelope.len() < EPH_PUB_LEN + NONCE_LEN + 16 {
        return Err("envelope too short".into());
    }
    let (eph_pub, rest) = envelope.split_at(EPH_PUB_LEN);
    let (nonce, ciphertext) = rest.split_at(NONCE_LEN);
    let aes_key = aes_key_from_ecdh(device_priv, eph_pub)?;
    gcm_decrypt(aes_key.as_ref(), nonce, ciphertext).map(Zeroizing::new)
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

    /// Live: reads THIS machine's real device key (TPM or software) —
    /// prints only the public key and the mode.
    #[test]
    #[ignore]
    fn device_key_live() {
        let t = std::time::Instant::now();
        let pubkey = device_pubkey_hex().expect("device key");
        eprintln!("device {pubkey} · mode {:?} · {:?}", device_key_mode().unwrap(), t.elapsed());
        let msg = b"GameVault Device Session
live test";
        let sig = device_sign(msg).expect("sign");
        let vk = VerifyingKey::from_sec1_bytes(&hex::decode(pubkey.trim_start_matches("0x")).unwrap()).unwrap();
        assert!(vk.verify_prehash(&Sha256::digest(msg), &Signature::from_slice(&sig).unwrap()).is_ok());
    }

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
