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
/// Only a per-machine ticket for the SAME licence as ticket.json counts: a
/// card re-written for another game may still hold this machine's ticket
/// of the previous one (ERR 0x21 on 2026-10-14: Runner's key opening
/// Stress Test 500).
pub fn ticket_for_this_device(gv: &Path) -> Option<String> {
    let main = std::fs::read_to_string(gv.join("ticket.json")).ok();
    if let Some(dev) = this_device() {
        if let Ok(s) = std::fs::read_to_string(gv.join("tickets").join(format!("{dev}.json"))) {
            let same = match &main {
                Some(m) => token_of(m).is_some() && token_of(m) == token_of(&s),
                None => true,
            };
            if same {
                return Some(s);
            }
        }
    }
    main
}

/// tokenId of a ticket JSON (string in the ticket format).
pub fn token_of(ticket_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(ticket_json).ok()?;
    match v.get("tokenId")? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Drop the per-machine tickets of any OTHER licence (card re-written for
/// another game or another copy). Returns how many were removed.
pub fn drop_other_tickets(gv: &Path, token: &str) -> usize {
    let Ok(rd) = std::fs::read_dir(gv.join("tickets")) else { return 0 };
    let mut n = 0;
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "json") {
            let other = std::fs::read_to_string(&p).ok().and_then(|s| token_of(&s)).map_or(true, |t| t != token);
            if other && std::fs::remove_file(&p).is_ok() {
                n += 1;
            }
        }
    }
    n
}

/// Store a ticket for `device` and keep at most `keep` per-machine tickets
/// (the newest), mirroring the 2-device rule.
pub fn store_ticket(gv: &Path, device: &str, ticket_json: &str, keep: usize) -> Result<(), String> {
    let dir = gv.join("tickets");
    std::fs::create_dir_all(&dir).map_err(|e| write_err("tickets", e))?;
    let dev = device.trim_start_matches("0x").to_lowercase();
    if dev.len() != 66 || !dev.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("clé d'appareil invalide".into());
    }
    std::fs::write(dir.join(format!("{dev}.json")), ticket_json).map_err(|e| write_err("ticket", e))?;
    std::fs::write(gv.join("ticket.json"), ticket_json).map_err(|e| write_err("ticket.json", e))?;
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
    /// The volume refuses writes (SD lock switch): playable, not writable
    pub read_only: bool,
}

/// Marker the UI turns into its own "card locked" screen.
pub const CARD_LOCKED: &str = "CARD_LOCKED";

/// Write error on a card -> message; a write-protected medium (Windows
/// ERROR_WRITE_PROTECT, os error 19 — the SD lock switch) gets the marker.
pub fn write_err(what: &str, e: std::io::Error) -> String {
    if e.raw_os_error() == Some(19) {
        format!("{CARD_LOCKED} · {what}: {e}")
    } else {
        format!("{what}: {e}")
    }
}

/// Refuse up front, before anything is half-written or a signature is spent.
pub fn ensure_writable(root: &Path) -> Result<(), String> {
    if read_only(root) {
        return Err(format!("{CARD_LOCKED} · carte en lecture seule"));
    }
    Ok(())
}

/// Read-only volume (SD lock switch, write-protected medium), asked to
/// Windows without writing anything — cards are scanned every 2 s.
#[cfg(windows)]
pub fn read_only(root: &Path) -> bool {
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;
    const FILE_READ_ONLY_VOLUME: u32 = 0x0008_0000;
    let mut r = root.as_os_str().to_string_lossy().into_owned();
    if !r.ends_with('\\') {
        r.push('\\');
    }
    let wide: Vec<u16> = r.encode_utf16().chain(std::iter::once(0)).collect();
    let mut flags = 0u32;
    let ok = unsafe {
        GetVolumeInformationW(wide.as_ptr(), std::ptr::null_mut(), 0, std::ptr::null_mut(), std::ptr::null_mut(), &mut flags, std::ptr::null_mut(), 0)
    };
    ok != 0 && flags & FILE_READ_ONLY_VOLUME != 0
}

#[cfg(not(windows))]
pub fn read_only(root: &Path) -> bool {
    std::fs::metadata(root).map(|m| m.permissions().readonly()).unwrap_or(false)
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
        read_only: read_only(root),
    })
}

#[derive(Serialize, Clone, Debug)]
pub struct Volume {
    pub mount_point: String,
    pub volume_label: String,
    /// true if a /gamevault/ folder already exists on it
    pub has_gamevault: bool,
    /// The volume refuses writes (SD lock switch)
    pub read_only: bool,
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
            read_only: false,
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
            read_only: read_only(disk.mount_point()),
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

#[cfg(test)]
mod ticket_tests {
    use super::*;

    fn ticket(token: &str) -> String {
        format!(r#"{{"tokenId":"{token}","devicePubKey":"0x02"}}"#)
    }

    #[test]
    fn rewritten_card_drops_the_old_licence_tickets() {
        let gv = std::env::temp_dir().join(format!("gv-tickets-test-{}", std::process::id())).join("gamevault");
        let dir = gv.join("tickets");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("aaaa.json"), ticket("3")).unwrap(); // previous game
        std::fs::write(dir.join("bbbb.json"), ticket("4")).unwrap(); // same licence, other PC
        assert_eq!(drop_other_tickets(&gv, "4"), 1);
        assert!(!dir.join("aaaa.json").exists());
        assert!(dir.join("bbbb.json").exists());
        assert_eq!(token_of(&ticket("12")).as_deref(), Some("12"));
        assert_eq!(token_of(r#"{"tokenId":7}"#).as_deref(), Some("7"));
        let _ = std::fs::remove_dir_all(gv.parent().unwrap());
    }
}

#[cfg(test)]
mod lock_tests {
    use super::*;

    #[test]
    fn write_protect_error_becomes_card_locked() {
        let locked = write_err("meta.json", std::io::Error::from_raw_os_error(19));
        assert!(locked.starts_with(CARD_LOCKED), "{locked}");
        let other = write_err("meta.json", std::io::Error::from_raw_os_error(5)); // access denied
        assert!(!other.contains(CARD_LOCKED), "{other}");
    }

    #[test]
    fn a_writable_disk_is_not_read_only() {
        let tmp = std::env::temp_dir();
        let root: PathBuf = tmp.ancestors().last().map(Path::to_path_buf).unwrap_or(tmp);
        assert!(!read_only(&root), "system drive reported read-only: {}", root.display());
        assert!(ensure_writable(&root).is_ok());
    }
}
