// Build profile (2026-10-11): the Rust core reads the same
// launcher/profiles/<GAMEVAULT_PROFILE>.json as the webview (see
// launcher/scripts/profile.mjs, which holds the reference rules) and bakes
// it in as compile-time env vars (GV_*). A release build refuses a profile
// that still points at example hosts or carries no ticket key.

use std::path::{Path, PathBuf};

const DEFAULT_GATEWAYS: [&str; 3] = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"];

fn host_of(url: &str) -> &str {
    let rest = url.split("://").nth(1).unwrap_or("");
    let auth = rest.split('/').next().unwrap_or("");
    if let (true, Some(end)) = (auth.starts_with('['), auth.find(']')) {
        return &auth[..=end];
    }
    auth.split(':').next().unwrap_or(auth)
}

fn check_url(field: &str, url: &str) -> String {
    let loopback = matches!(host_of(url), "localhost" | "127.0.0.1" | "[::1]");
    let ok = url.starts_with("https://") || (url.starts_with("http://") && loopback);
    if !ok || host_of(url).is_empty() || url.contains('?') || url.contains('#') {
        panic!("profil GameVault : {field} invalide ({url}) — https obligatoire hors de cette machine");
    }
    url.to_string()
}

fn with_slash(s: String) -> String {
    if s.ends_with('/') { s } else { format!("{s}/") }
}

fn main() {
    println!("cargo:rerun-if-env-changed=GAMEVAULT_PROFILE");
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let launcher = manifest.parent().unwrap().to_path_buf();
    let name = std::env::var("GAMEVAULT_PROFILE").unwrap_or_else(|_| "local".into());
    let file = if name.ends_with(".json") {
        let p = Path::new(&name);
        if p.is_absolute() { p.to_path_buf() } else { launcher.join(p) }
    } else {
        launcher.join("profiles").join(format!("{name}.json"))
    };
    println!("cargo:rerun-if-changed={}", file.display());
    println!("cargo:rerun-if-changed={}", launcher.join("../shared/src/deployments.ts").display());
    let raw = std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("profil GameVault introuvable ({}): {e}", file.display()));
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_else(|e| panic!("profil GameVault illisible ({}): {e}", file.display()));
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);

    let pname = s("name").unwrap_or_default();
    let ticketd = check_url("ticketdUrl", s("ticketdUrl").unwrap_or_default().trim_end_matches('/'));
    let web = check_url("webUrl", s("webUrl").unwrap_or_default().trim_end_matches('/'));
    let builds = with_slash(check_url("buildsUrl", &s("buildsUrl").unwrap_or_else(|| format!("{ticketd}/build/"))));
    let gateways: Vec<String> = match v.get("ipfsGateways").and_then(|g| g.as_array()) {
        Some(a) => a.iter().map(|g| with_slash(check_url("ipfsGateways", g.as_str().unwrap_or("")))).collect(),
        None => DEFAULT_GATEWAYS.iter().map(|g| g.to_string()).collect(),
    };
    let keys: Vec<String> = v
        .get("ticketSignerPubKeys")
        .and_then(|k| k.as_array())
        .map(|a| a.iter().map(|k| k.as_str().unwrap_or("").trim_start_matches("0x").to_lowercase()).collect())
        .unwrap_or_default();
    for k in &keys {
        let hex = k.len() == 66 && k.bytes().all(|b| b.is_ascii_hexdigit()) && (k.starts_with("02") || k.starts_with("03"));
        if !hex {
            panic!("profil GameVault : ticketSignerPubKeys, clé secp256k1 compressée attendue ({k})");
        }
    }
    let local = v.get("localServices").and_then(|b| b.as_bool()) == Some(true);

    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let mut problems = Vec::new();
        for (f, u) in [("ticketdUrl", &ticketd), ("webUrl", &web), ("buildsUrl", &builds)] {
            let h = host_of(u);
            if h.ends_with(".example") || h.ends_with(".invalid") || h.ends_with(".test") || h == "example.com" {
                problems.push(format!("{f} vise encore un hôte d'exemple ({h})"));
            }
        }
        if keys.is_empty() {
            problems.push("ticketSignerPubKeys vide".to_string());
        }
        if pname == "production" && local {
            problems.push("localServices doit être false en production".to_string());
        }
        if !problems.is_empty() {
            panic!("profil GameVault « {pname} » refusé pour une release : {}", problems.join(" ; "));
        }
    }

    println!("cargo:rustc-env=GV_PROFILE={pname}");
    println!("cargo:rustc-env=GV_TICKETD_URL={ticketd}");
    println!("cargo:rustc-env=GV_WEB_URL={web}");
    println!("cargo:rustc-env=GV_BUILDS_URL={builds}");
    println!("cargo:rustc-env=GV_IPFS_GATEWAYS={}", gateways.join(","));
    println!("cargo:rustc-env=GV_TICKET_SIGNERS={}", keys.join(","));
    println!("cargo:rustc-env=GV_LOCAL_SERVICES={}", if local { "1" } else { "0" });

    tauri_build::build()
}
