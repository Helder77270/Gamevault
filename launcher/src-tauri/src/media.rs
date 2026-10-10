//! Cartridge detection: scan mounted removable volumes for /gamevault/ticket.json.
//! No OS-specific device APIs — plain filesystem checks on top of sysinfo.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use sysinfo::Disks;

/// This machine's device pubkey (lowercase hex, no 0x), read once.
fn this_device() -> Option<&'static str> {
    static DEV: OnceLock<Option<String>> = OnceLock::new();
    DEV.get_or_init(|| crate::crypto::device_pubkey_hex().ok().map(|k| k.trim_start_matches("0x").to_lowercase()))
        .as_deref()
}

/// A card keeps one ticket per paired machine (the account's 2 devices):
/// /gamevault/tickets/<device pubkey>.json — so the same card works offline
/// on both. /gamevault/ticket.json stays as the last written one (media
/// detection convention, and older launchers).
pub fn ticket_for_this_device(gv: &Path) -> Option<String> {
    if let Some(dev) = this_device() {
        if let Ok(s) = std::fs::read_to_string(gv.join("tickets").join(format!("{dev}.json"))) {
            return Some(s);
        }
    }
    std::fs::read_to_string(gv.join("ticket.json")).ok()
}

/// Store a ticket for `device` and keep at most `keep` per-machine tickets
/// (the newest), mirroring the 2-device rule.
pub fn store_ticket(gv: &Path, device: &str, ticket_json: &str, keep: usize) -> Result<(), String> {
    let dir = gv.join("tickets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("tickets: {e}"))?;
    let dev = device.trim_start_matches("0x").to_lowercase();
    if dev.len() != 66 || !dev.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("clé d'appareil invalide".into());
    }
    std::fs::write(dir.join(format!("{dev}.json")), ticket_json).map_err(|e| format!("ticket: {e}"))?;
    std::fs::write(gv.join("ticket.json"), ticket_json).map_err(|e| format!("ticket.json: {e}"))?;
    let mut all: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| e.metadata().and_then(|m| m.modified()).ok().map(|t| (t, e.path())))
        .collect();
    all.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in all.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
pub struct Cartridge {
    /// Volume root, e.g. "E:\\"
    pub mount_point: String,
    pub volume_label: String,
    /// Raw contents of /gamevault/ticket.json (verification happens in TS via shared lib)
    pub ticket_json: String,
    /// Raw contents of /gamevault/meta.json if present
    pub meta_json: Option<String>,
    /// Whether /gamevault/build.enc exists alongside the ticket
    pub has_build: bool,
    /// Size of /gamevault/build.enc in bytes (0 when absent)
    pub build_size: u64,
}

fn read_cartridge(root: &Path, label: String) -> Option<Cartridge> {
    let gv = root.join("gamevault");
    // presence of /gamevault/ticket.json = a cartridge (detection convention)
    if !gv.join("ticket.json").is_file() {
        return None;
    }
    let ticket_json = ticket_for_this_device(&gv)?;
    Some(Cartridge {
        mount_point: root.to_string_lossy().into_owned(),
        volume_label: label,
        ticket_json,
        meta_json: std::fs::read_to_string(gv.join("meta.json")).ok(),
        has_build: gv.join("build.enc").is_file(),
        build_size: std::fs::metadata(gv.join("build.enc")).map(|m| m.len()).unwrap_or(0),
    })
}

#[derive(Serialize, Clone, Debug)]
pub struct Volume {
    pub mount_point: String,
    pub volume_label: String,
    /// true if a /gamevault/ folder already exists on it
    pub has_gamevault: bool,
}

/// Every removable volume, cartridge or blank — install targets.
pub fn list_removable() -> Vec<Volume> {
    let mut found = Vec::new();
    if let Ok(dev_dir) = std::env::var("GAMEVAULT_DEV_MEDIA_DIR") {
        let p = PathBuf::from(&dev_dir);
        found.push(Volume {
            mount_point: p.to_string_lossy().into_owned(),
            volume_label: "DEV".into(),
            has_gamevault: p.join("gamevault").is_dir(),
        });
    }
    for disk in Disks::new_with_refreshed_list().list() {
        if !disk.is_removable() {
            continue;
        }
        found.push(Volume {
            mount_point: disk.mount_point().to_string_lossy().into_owned(),
            volume_label: disk.name().to_string_lossy().into_owned(),
            has_gamevault: disk.mount_point().join("gamevault").is_dir(),
        });
    }
    found
}

pub fn scan() -> Vec<Cartridge> {
    let mut found = Vec::new();

    // Dev convenience: treat a local folder as an inserted cartridge.
    // GAMEVAULT_DEV_MEDIA_DIR must point at a folder CONTAINING /gamevault/.
    if let Ok(dev_dir) = std::env::var("GAMEVAULT_DEV_MEDIA_DIR") {
        if let Some(c) = read_cartridge(&PathBuf::from(&dev_dir), "DEV".into()) {
            found.push(c);
        }
    }

    for disk in Disks::new_with_refreshed_list().list() {
        if !disk.is_removable() {
            continue;
        }
        let label = disk.name().to_string_lossy().into_owned();
        if let Some(c) = read_cartridge(disk.mount_point(), label) {
            found.push(c);
        }
    }
    found
}
