//! Ticket verification in the TRUSTED core (audit L3). The webview is the
//! untrusted UI layer; this module decides whether the device key may be
//! used at all. Mirrors shared/src/ticket.ts byte for byte:
//! ECDSA secp256k1 over sha256(canonical JSON, fixed field order,
//! lowercased hex/addresses) — the TS signer is the source of truth, and
//! `cross_vector_from_typescript` pins the two implementations together.

use k256::ecdsa::signature::hazmat::PrehashVerifier;
use k256::ecdsa::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const CHAIN_ID: u64 = 84532;

/// The GameLicense this binary trusts, read at COMPILE time from
/// shared/src/deployments.ts (the single source of truth, also used by the
/// TS side). A ticket names its contract: one issued for an abandoned
/// deployment must not unlock anything, even when the same wallet holds
/// the same token number on the current one (v1.1 reset, 2026-10-09).
pub fn licence_contract() -> &'static str {
    static ADDR: OnceLock<String> = OnceLock::new();
    ADDR.get_or_init(|| parse_licence_contract(include_str!("../../../shared/src/deployments.ts")).unwrap_or_default())
}

fn parse_licence_contract(src: &str) -> Option<String> {
    let start = src.find("gameLicense: \"0x")? + "gameLicense: \"".len();
    let addr = src[start..].split('"').next()?;
    is_hex(addr, Some(40)).then(|| addr.to_lowercase())
}

/// Ticket-signer public keys trusted by this binary. The DEV fixture key is
/// derived from a PUBLIC seed (shared/devkeys) — debug builds only, exactly
/// like the TS side (`import.meta.env.DEV`).
fn trusted_signers() -> Vec<&'static str> {
    let mut keys = vec!["02f993342ee3df755c386e4ec261eed2d439738c284887ca657faa33d2b353292c"];
    if cfg!(debug_assertions) {
        keys.push("038d78e7c9ea67e401f6e9dbf8fccae4563dc21c0e3f569338012ba95c50700f2b");
    }
    keys
}

/// The fields a launch needs, once verified.
#[derive(Debug)]
pub struct VerifiedTicket {
    pub token_id: String,
    pub wrapped_content_key: Vec<u8>,
}

fn str_field<'a>(t: &'a Value, k: &str) -> Result<&'a str, String> {
    t[k].as_str().ok_or_else(|| format!("ticket : champ {k} manquant"))
}
fn u64_field(t: &Value, k: &str) -> Result<u64, String> {
    t[k].as_u64().ok_or_else(|| format!("ticket : champ {k} invalide"))
}
fn is_hex(s: &str, exact_len: Option<usize>) -> bool {
    let Some(h) = s.strip_prefix("0x") else { return false };
    h.bytes().all(|b| b.is_ascii_hexdigit()) && exact_len.map_or(true, |n| h.len() == n)
}
/// JSON string literal, same escaping as JS JSON.stringify for these values.
fn js(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// sha256 of the canonical payload — identical to canonicalPayload() in TS.
fn canonical_digest(t: &Value) -> Result<[u8; 32], String> {
    let payload = format!(
        r#"{{"tokenId":{},"contract":{},"chainId":{},"ownerAddress":{},"devicePubKey":{},"wrappedContentKey":{},"issuedAt":{},"expiresAt":{}}}"#,
        js(str_field(t, "tokenId")?),
        js(&str_field(t, "contract")?.to_lowercase()),
        u64_field(t, "chainId")?,
        js(&str_field(t, "ownerAddress")?.to_lowercase()),
        js(&str_field(t, "devicePubKey")?.to_lowercase()),
        js(&str_field(t, "wrappedContentKey")?.to_lowercase()),
        u64_field(t, "issuedAt")?,
        u64_field(t, "expiresAt")?,
    );
    Ok(Sha256::digest(payload.as_bytes()).into())
}

fn signature_ok(t: &Value, digest: &[u8; 32]) -> bool {
    let Ok(sig_hex) = str_field(t, "platformSignature") else { return false };
    let Ok(sig_bytes) = hex::decode(sig_hex.trim_start_matches("0x")) else { return false };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else { return false };
    trusted_signers().iter().any(|k| {
        hex::decode(k)
            .ok()
            .and_then(|pk| VerifyingKey::from_sec1_bytes(&pk).ok())
            .is_some_and(|vk| vk.verify_prehash(digest, &sig).is_ok())
    })
}

/// Everything that must hold before the device key unseals anything:
/// shape, chain, platform signature, expiry, and "sealed for THIS machine".
pub fn verify_for_launch(t: &Value, licence: &str, this_device_pub_hex: &str, now_sec: u64) -> Result<VerifiedTicket, String> {
    let token_id = str_field(t, "tokenId")?;
    if token_id.is_empty() || token_id.len() > 12 || !token_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("ticket : tokenId invalide".into());
    }
    for (k, len) in [("contract", Some(40)), ("ownerAddress", Some(40)), ("devicePubKey", Some(66)), ("wrappedContentKey", None)] {
        if !is_hex(str_field(t, k)?, len) {
            return Err(format!("ticket : champ {k} mal formé"));
        }
    }
    if u64_field(t, "chainId")? != CHAIN_ID {
        return Err("ticket émis pour une autre chaîne".into());
    }
    // fail closed: an unreadable expected address matches nothing
    if licence.is_empty() || !str_field(t, "contract")?.eq_ignore_ascii_case(licence) {
        return Err("ticket émis pour un autre contrat (ancien déploiement) — réappairez la carte".into());
    }
    let digest = canonical_digest(t)?;
    if !signature_ok(t, &digest) {
        return Err("signature plateforme invalide — ticket forgé ou altéré".into());
    }
    if now_sec > u64_field(t, "expiresAt")? {
        return Err("ticket expiré — renouvelez la licence en ligne".into());
    }
    let device = str_field(t, "devicePubKey")?.trim_start_matches("0x").to_lowercase();
    if device != this_device_pub_hex.trim_start_matches("0x").to_lowercase() {
        return Err("ticket scellé pour un autre appareil — appairez cette machine".into());
    }
    let wrapped = hex::decode(str_field(t, "wrappedContentKey")?.trim_start_matches("0x")).map_err(|e| e.to_string())?;
    Ok(VerifiedTicket { token_id: token_id.to_string(), wrapped_content_key: wrapped })
}

/// Lighter check before a ticket is WRITTEN to a card (fresh from ticketd):
/// authentic, right chain, for this machine. Expiry is checked at launch.
pub fn verify_for_write(t: &Value, licence: &str, this_device_pub_hex: &str) -> Result<(), String> {
    verify_for_launch(t, licence, this_device_pub_hex, 0).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Signed by shared/src/ticket.ts signTicket() with the DEV key.
    const VECTOR: &str = r#"{"tokenId":"2","contract":"0xcB73916fA8AF03894B85e6e05aa8a8169f046Bd9","chainId":84532,"ownerAddress":"0xAD5B1eFD7e542C6ff91e91b7801F4f0ADa7b631b","devicePubKey":"0x02b7f62196275e96b31a5f34c336955e414ea1a03d545756420dfd6f9f96726790","wrappedContentKey":"0x0265d5c9732fa487c36ee766b86f03d5ed11253a69aa8db3299fe1e05e1557ba79","issuedAt":1791236661,"expiresAt":1793828661,"platformSignature":"0xbe12f72542936059c83630ab940b677b00ffbc8caa3622d58430cc166bbb901773b1d4430f20b7404d89c78cd4cc03535b804cf65d1e96fd7a489e2f61c53460"}"#;
    const DEVICE: &str = "0x02b7f62196275e96b31a5f34c336955e414ea1a03d545756420dfd6f9f96726790";
    // the contract the vector was signed for (a v1.0 deployment)
    const VECTOR_LICENCE: &str = "0xcb73916fa8af03894b85e6e05aa8a8169f046bd9";
    const BEFORE_EXPIRY: u64 = 1_791_300_000;

    fn vector() -> Value {
        serde_json::from_str(VECTOR).unwrap()
    }

    #[test]
    fn cross_vector_from_typescript() {
        let v = verify_for_launch(&vector(), VECTOR_LICENCE, DEVICE, BEFORE_EXPIRY).expect("TS-signed ticket must verify in Rust");
        assert_eq!(v.token_id, "2");
    }

    #[test]
    fn rejects_tampered_field() {
        let mut t = vector();
        t["expiresAt"] = Value::from(4_000_000_000u64); // extend the offline window
        assert!(verify_for_launch(&t, VECTOR_LICENCE, DEVICE, BEFORE_EXPIRY).unwrap_err().contains("signature"));
    }

    #[test]
    fn rejects_forged_signature() {
        let mut t = vector();
        t["platformSignature"] = Value::from(format!("0x{}", "11".repeat(64)));
        assert!(verify_for_launch(&t, VECTOR_LICENCE, DEVICE, BEFORE_EXPIRY).is_err());
    }

    #[test]
    fn rejects_expired() {
        assert!(verify_for_launch(&vector(), VECTOR_LICENCE, DEVICE, 1_793_828_662).unwrap_err().contains("expiré"));
    }

    #[test]
    fn rejects_other_device() {
        let other = "0x03b7f62196275e96b31a5f34c336955e414ea1a03d545756420dfd6f9f96726790";
        assert!(verify_for_launch(&vector(), VECTOR_LICENCE, other, BEFORE_EXPIRY).unwrap_err().contains("autre appareil"));
    }

    #[test]
    fn rejects_malformed_token_id() {
        let mut t = vector();
        t["tokenId"] = Value::from("..\\..\\x");
        assert!(verify_for_launch(&t, VECTOR_LICENCE, DEVICE, BEFORE_EXPIRY).unwrap_err().contains("tokenId"));
    }

    #[test]
    fn case_insensitive_hex_like_typescript() {
        // TS lowercases before hashing: an uppercase copy must still verify
        let mut t = vector();
        t["contract"] = Value::from("0xCB73916FA8AF03894B85E6E05AA8A8169F046BD9");
        assert!(verify_for_launch(&t, VECTOR_LICENCE, DEVICE, BEFORE_EXPIRY).is_ok());
    }

    #[test]
    fn rejects_ticket_of_another_deployment() {
        // genuine, unexpired, sealed for this machine — but for an abandoned contract
        let current = "0x844cb5292c7fe7a186f1df0914f2463c7ffc3fe8";
        let err = verify_for_launch(&vector(), current, DEVICE, BEFORE_EXPIRY).unwrap_err();
        assert!(err.contains("autre contrat"));
        assert!(verify_for_write(&vector(), current, DEVICE).is_err());
    }

    #[test]
    fn empty_expected_contract_fails_closed() {
        assert!(verify_for_launch(&vector(), "", DEVICE, BEFORE_EXPIRY).is_err());
    }

    #[test]
    fn licence_contract_comes_from_deployments() {
        let a = licence_contract();
        assert!(is_hex(a, Some(40)), "deployments.ts gameLicense unreadable: {a:?}");
        assert_eq!(parse_licence_contract(r#"gameLicense: `0x${string}` | "";\n  gameLicense: "0xAbC0000000000000000000000000000000000001","#).as_deref(),
            Some("0xabc0000000000000000000000000000000000001"));
    }
}
