mod media;

/// Scan removable volumes (plus GAMEVAULT_DEV_MEDIA_DIR in dev) for cartridges.
#[tauri::command]
fn scan_cartridges() -> Vec<media::Cartridge> {
    media::scan()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![scan_cartridges])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
