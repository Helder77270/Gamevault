mod crypto;
mod media;

use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

/// Decrypted game bundle, held in memory only — never written to disk,
/// never handed to the webview as data (served via the custom protocol).
struct GameSession(Mutex<Option<Vec<u8>>>);

/// Scan removable volumes (plus GAMEVAULT_DEV_MEDIA_DIR in dev) for cartridges.
#[tauri::command]
fn scan_cartridges() -> Vec<media::Cartridge> {
    media::scan()
}

/// Full launch: read ticket -> unwrap content key with the device key ->
/// decrypt build.enc in memory. The TS side has already verified the
/// platform signature; the crypto below fails closed regardless (a forged
/// ticket cannot contain an envelope our device key opens).
#[tauri::command]
fn play_game(state: tauri::State<GameSession>, mount_point: String) -> Result<(), String> {
    let gv = Path::new(&mount_point).join("gamevault");

    let ticket: Value = serde_json::from_str(
        &std::fs::read_to_string(gv.join("ticket.json")).map_err(|e| format!("ticket.json: {e}"))?,
    )
    .map_err(|e| format!("ticket.json invalide: {e}"))?;

    let wrapped_hex = ticket["wrappedContentKey"]
        .as_str()
        .ok_or("wrappedContentKey manquant")?
        .trim_start_matches("0x")
        .to_string();
    let envelope = hex::decode(wrapped_hex).map_err(|e| e.to_string())?;

    let device_priv = crypto::device_priv()?; // OS keystore (Credential Manager)
    let content_key = crypto::ecies_unwrap(&envelope, &device_priv)
        .map_err(|e| format!("clé d'appareil refusée: {e}"))?;

    let enc = std::fs::read(gv.join("build.enc")).map_err(|e| format!("build.enc: {e}"))?;
    let html = crypto::decrypt_build(&enc, &content_key)
        .map_err(|e| format!("déchiffrement du build: {e}"))?;

    *state.0.lock().unwrap() = Some(html);
    Ok(())
}

/// Drop the decrypted bundle from memory when the player quits.
#[tauri::command]
fn stop_game(state: tauri::State<GameSession>) {
    *state.0.lock().unwrap() = None;
}

/// This machine's device pubkey (creates the keypair on first call).
#[tauri::command]
fn get_device_pubkey() -> Result<String, String> {
    crypto::device_pubkey_hex()
}

/// Write a re-downloaded build.enc onto the cartridge (P3: verified
/// re-download). Integrity was already checked TS-side against the
/// published sha256; the bytes are still just public encrypted data.
#[tauri::command]
fn write_build(mount_point: String, data_b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| format!("base64: {e}"))?;
    if bytes.len() < 28 {
        return Err("build trop petit pour être valide".into());
    }
    let path = Path::new(&mount_point).join("gamevault").join("build.enc");
    std::fs::write(&path, bytes).map_err(|e| format!("écriture build: {e}"))
}

/// Write a freshly issued ticket back onto the cartridge (why USB/SD > CD-R).
#[tauri::command]
fn write_ticket(mount_point: String, ticket_json: String) -> Result<(), String> {
    // sanity: refuse to write something that isn't a JSON object
    serde_json::from_str::<Value>(&ticket_json).map_err(|e| format!("ticket invalide: {e}"))?;
    let path = Path::new(&mount_point).join("gamevault").join("ticket.json");
    std::fs::write(&path, ticket_json).map_err(|e| format!("écriture ticket: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(GameSession(Mutex::new(None)))
        .register_uri_scheme_protocol("game", |ctx, _request| {
            let state = ctx.app_handle().state::<GameSession>();
            let guard = state.0.lock().unwrap();
            match guard.as_ref() {
                Some(html) => tauri::http::Response::builder()
                    .header("Content-Type", "text/html")
                    .body(html.clone())
                    .unwrap(),
                None => tauri::http::Response::builder()
                    .status(404)
                    .body(b"no game loaded".to_vec())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_cartridges,
            play_game,
            stop_game,
            get_device_pubkey,
            write_ticket,
            write_build
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
