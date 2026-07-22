//! Cartridge detection: scan mounted removable volumes for /gamevault/ticket.json.
//! No OS-specific device APIs — plain filesystem checks on top of sysinfo.

use serde::Serialize;
use std::path::{Path, PathBuf};
use sysinfo::Disks;

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
}

fn read_cartridge(root: &Path, label: String) -> Option<Cartridge> {
    let gv = root.join("gamevault");
    let ticket_json = std::fs::read_to_string(gv.join("ticket.json")).ok()?;
    Some(Cartridge {
        mount_point: root.to_string_lossy().into_owned(),
        volume_label: label,
        ticket_json,
        meta_json: std::fs::read_to_string(gv.join("meta.json")).ok(),
        has_build: gv.join("build.enc").is_file(),
    })
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
