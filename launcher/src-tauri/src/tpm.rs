//! TPM sealing of the device key (P10 step 1, 2026-10-14).
//!
//! The device key stays secp256k1 (tickets, ticketd and cards unchanged);
//! what changes is how it rests on disk. An RSA-2048 key is created INSIDE
//! the TPM ("Microsoft Platform Crypto Provider", non-exportable by
//! construction) and encrypts the device key (RSA-OAEP). Only the sealed
//! blob is stored; it opens on this machine's TPM and nowhere else, so
//! copying the Credential Manager to another PC clones nothing.
//!
//! Limit (step 2 would remove it): once unsealed the key is in this
//! process's memory for the few milliseconds an operation lasts.
//!
//! No TPM 2.0 (old PC, VM) or `GAMEVAULT_NO_TPM=1` -> `Unavailable`, and the
//! caller keeps the software key (Credential Manager), as before.

use zeroize::Zeroizing;

#[derive(Debug)]
pub enum TpmError {
    /// No usable TPM here (or disabled by GAMEVAULT_NO_TPM=1).
    Unavailable(String),
    /// The TPM answers but our wrapping key is gone (TPM cleared, new
    /// motherboard): what it sealed can never be opened again.
    KeyLost,
    /// Anything else — transient or not, never a reason to drop a key.
    Failed(String),
}

impl std::fmt::Display for TpmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TpmError::Unavailable(e) => write!(f, "puce TPM indisponible ({e})"),
            TpmError::KeyLost => write!(f, "clé de la puce TPM introuvable (puce réinitialisée ?)"),
            TpmError::Failed(e) => write!(f, "puce TPM : {e}"),
        }
    }
}

pub fn disabled_by_env() -> bool {
    std::env::var("GAMEVAULT_NO_TPM").is_ok_and(|v| v == "1")
}

#[cfg(windows)]
mod imp {
    use super::TpmError;
    use windows_sys::core::{HRESULT, PCWSTR};
    use windows_sys::Win32::Foundation::NTE_BAD_KEYSET;
    use windows_sys::Win32::Security::Cryptography::{
        NCryptCreatePersistedKey, NCryptDecrypt, NCryptEncrypt, NCryptFinalizeKey, NCryptFreeObject, NCryptOpenKey,
        NCryptOpenStorageProvider, NCryptSetProperty, BCRYPT_OAEP_PADDING_INFO, BCRYPT_RSA_ALGORITHM,
        BCRYPT_SHA256_ALGORITHM, MS_PLATFORM_CRYPTO_PROVIDER, NCRYPT_KEY_HANDLE, NCRYPT_LENGTH_PROPERTY,
        NCRYPT_PAD_OAEP_FLAG, NCRYPT_PROV_HANDLE, NCRYPT_SILENT_FLAG,
    };
    use zeroize::Zeroizing;

    /// Per Windows user (no machine flag): another account on this PC
    /// cannot use it either.
    const KEY_NAME: &str = "GameVault Launcher Device Wrap";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn hr(h: HRESULT) -> String {
        format!("0x{:08X}", h as u32)
    }

    /// NCrypt handle freed on drop.
    struct Handle(usize);
    impl Drop for Handle {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe { NCryptFreeObject(self.0) };
            }
        }
    }

    fn provider() -> Result<Handle, TpmError> {
        let mut prov: NCRYPT_PROV_HANDLE = 0;
        let h = unsafe { NCryptOpenStorageProvider(&mut prov, MS_PLATFORM_CRYPTO_PROVIDER, 0) };
        if h != 0 {
            return Err(TpmError::Unavailable(hr(h)));
        }
        Ok(Handle(prov))
    }

    fn open_key(prov: &Handle) -> Result<Handle, TpmError> {
        let name = wide(KEY_NAME);
        let mut key: NCRYPT_KEY_HANDLE = 0;
        let h = unsafe { NCryptOpenKey(prov.0, &mut key, name.as_ptr(), 0, NCRYPT_SILENT_FLAG) };
        match h {
            0 => Ok(Handle(key)),
            NTE_BAD_KEYSET => Err(TpmError::KeyLost),
            _ => Err(TpmError::Failed(format!("ouverture de la clé {}", hr(h)))),
        }
    }

    fn create_key(prov: &Handle) -> Result<Handle, TpmError> {
        let name = wide(KEY_NAME);
        let mut key: NCRYPT_KEY_HANDLE = 0;
        let h = unsafe { NCryptCreatePersistedKey(prov.0, &mut key, BCRYPT_RSA_ALGORITHM, name.as_ptr(), 0, 0) };
        if h != 0 {
            return Err(TpmError::Failed(format!("création de la clé {}", hr(h))));
        }
        let key = Handle(key);
        let bits: u32 = 2048;
        let h = unsafe { NCryptSetProperty(key.0, NCRYPT_LENGTH_PROPERTY, (&bits as *const u32).cast(), 4, 0) };
        if h != 0 {
            return Err(TpmError::Failed(format!("taille de clé {}", hr(h))));
        }
        // Platform-provider keys are non-exportable: no export policy to set.
        let h = unsafe { NCryptFinalizeKey(key.0, NCRYPT_SILENT_FLAG) };
        if h != 0 {
            return Err(TpmError::Failed(format!("finalisation de la clé {}", hr(h))));
        }
        Ok(key)
    }

    fn oaep() -> BCRYPT_OAEP_PADDING_INFO {
        BCRYPT_OAEP_PADDING_INFO { pszAlgId: BCRYPT_SHA256_ALGORITHM as PCWSTR, pbLabel: std::ptr::null_mut(), cbLabel: 0 }
    }

    type CryptFn = unsafe extern "system" fn(usize, *const u8, u32, *const core::ffi::c_void, *mut u8, u32, *mut u32, u32) -> HRESULT;

    /// Two-call NCrypt pattern: size, then data.
    fn crypt(f: CryptFn, key: &Handle, input: &[u8], what: &str) -> Result<Zeroizing<Vec<u8>>, TpmError> {
        let pad = oaep();
        let pad_ptr = (&pad as *const BCRYPT_OAEP_PADDING_INFO).cast();
        let mut size = 0u32;
        let h = unsafe { f(key.0, input.as_ptr(), input.len() as u32, pad_ptr, std::ptr::null_mut(), 0, &mut size, NCRYPT_PAD_OAEP_FLAG) };
        if h != 0 {
            return Err(TpmError::Failed(format!("{what} {}", hr(h))));
        }
        let mut out = Zeroizing::new(vec![0u8; size as usize]);
        let h = unsafe { f(key.0, input.as_ptr(), input.len() as u32, pad_ptr, out.as_mut_ptr(), size, &mut size, NCRYPT_PAD_OAEP_FLAG) };
        if h != 0 {
            return Err(TpmError::Failed(format!("{what} {}", hr(h))));
        }
        out.truncate(size as usize);
        Ok(out)
    }

    pub fn available() -> Result<(), TpmError> {
        provider().map(|_| ())
    }

    pub fn seal(secret: &[u8]) -> Result<Vec<u8>, TpmError> {
        let prov = provider()?;
        let key = match open_key(&prov) {
            Ok(k) => k,
            Err(TpmError::KeyLost) => create_key(&prov)?,
            Err(e) => return Err(e),
        };
        crypt(NCryptEncrypt, &key, secret, "scellement").map(|v| v.to_vec())
    }

    pub fn unseal(blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, TpmError> {
        let prov = provider()?;
        let key = open_key(&prov)?;
        crypt(NCryptDecrypt, &key, blob, "descellement")
    }
}

#[cfg(not(windows))]
mod imp {
    use super::TpmError;
    use zeroize::Zeroizing;
    pub fn available() -> Result<(), TpmError> {
        Err(TpmError::Unavailable("Windows uniquement pour l'instant".into()))
    }
    pub fn seal(_: &[u8]) -> Result<Vec<u8>, TpmError> {
        available().map(|_| Vec::new())
    }
    pub fn unseal(_: &[u8]) -> Result<Zeroizing<Vec<u8>>, TpmError> {
        available().map(|_| Zeroizing::new(Vec::new()))
    }
}

/// A TPM we may use (not disabled by GAMEVAULT_NO_TPM=1).
pub fn available() -> Result<(), TpmError> {
    if disabled_by_env() {
        return Err(TpmError::Unavailable("désactivée par GAMEVAULT_NO_TPM".into()));
    }
    imp::available()
}

/// Encrypts `secret` with this machine's TPM key (created on first use).
pub fn seal(secret: &[u8]) -> Result<Vec<u8>, TpmError> {
    available()?;
    imp::seal(secret)
}

/// Opens a blob sealed by `seal` on THIS machine.
pub fn unseal(blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, TpmError> {
    available()?;
    imp::unseal(blob)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_switch_forces_software_mode() {
        std::env::set_var("GAMEVAULT_NO_TPM", "1");
        assert!(matches!(available(), Err(TpmError::Unavailable(_))));
        assert!(matches!(seal(b"x"), Err(TpmError::Unavailable(_))));
        std::env::remove_var("GAMEVAULT_NO_TPM");
    }

    /// Live: needs a TPM 2.0. Creates the wrapping key on first run (the
    /// same one the launcher uses — harmless, it only ever encrypts).
    #[test]
    #[ignore]
    fn seal_roundtrip_live() {
        let secret = [0x5au8; 32];
        let t = std::time::Instant::now();
        let blob = seal(&secret).expect("seal");
        let sealed_in = t.elapsed();
        assert_ne!(blob.as_slice(), secret.as_slice());
        assert_eq!(blob.len(), 256, "RSA-2048 ciphertext");
        let t = std::time::Instant::now();
        let back = unseal(&blob).expect("unseal");
        let unsealed_in = t.elapsed();
        assert_eq!(back.as_slice(), secret.as_slice());
        let mut bad = blob.clone();
        bad[10] ^= 1;
        assert!(unseal(&bad).is_err(), "a tampered blob must not open");
        eprintln!("seal {sealed_in:?} · unseal {unsealed_in:?}");
    }
}
