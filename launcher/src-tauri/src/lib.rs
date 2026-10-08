mod crypto;
mod media;
mod ticket;

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

/// Decrypted game bundle, held in memory only — never written to disk,
/// never handed to the webview as data (served via the custom protocol).
struct GameSession(Mutex<Option<Vec<u8>>>);

/// A running NATIVE game process (exe runtime). Plaintext exists on disk
/// only inside its run dir, for the lifetime of the process.
struct NativeRun {
    child: std::process::Child,
    dir: PathBuf,
    started: Instant,
}
struct NativeSession(Arc<Mutex<Option<NativeRun>>>);

fn run_root() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into()))
        .join("GameVault")
        .join("run")
}

/// Kill + clean a native run and tell the UI. Used by EJECT and revocation.
fn end_native(app: &AppHandle, slot: &Arc<Mutex<Option<NativeRun>>>, killed: bool) {
    if let Some(mut run) = slot.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = run.child.kill();
        let _ = run.child.wait();
        let secs = run.started.elapsed().as_secs();
        let _ = std::fs::remove_dir_all(&run.dir);
        let _ = app.emit(
            "native-exited",
            serde_json::json!({ "code": null, "seconds": secs, "killed": killed }),
        );
    }
}

/// Commands only touch volumes the launcher itself detected — never an
/// arbitrary path handed over by the webview.
fn known_mount(mount_point: &str) -> Result<(), String> {
    if media::list_removable().iter().any(|v| v.mount_point == mount_point) {
        Ok(())
    } else {
        Err("support inconnu — insérez une carte détectée par le lecteur".into())
    }
}

/// Scan removable volumes (plus GAMEVAULT_DEV_MEDIA_DIR in dev) for cartridges.
#[tauri::command]
fn scan_cartridges() -> Vec<media::Cartridge> {
    media::scan()
}

/// Full launch: VERIFY the ticket here, in the trusted core (signature,
/// expiry, chain, sealed for this machine) -> unwrap the content key with
/// the device key -> decrypt build.enc in memory. The webview's own checks
/// are UX only: an envelope copied from a genuine ticket would still open
/// with our device key, so the crypto alone does NOT prove the ticket is
/// authentic or unexpired — this check does.
#[tauri::command]
fn play_game(
    app: AppHandle,
    state: tauri::State<GameSession>,
    native: tauri::State<NativeSession>,
    mount_point: String,
) -> Result<Value, String> {
    known_mount(&mount_point)?;
    let gv = Path::new(&mount_point).join("gamevault");

    let ticket: Value = serde_json::from_str(
        &std::fs::read_to_string(gv.join("ticket.json")).map_err(|e| format!("ticket.json: {e}"))?,
    )
    .map_err(|e| format!("ticket.json invalide: {e}"))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX); // broken clock = treat as expired, fail closed
    let verified = ticket::verify_for_launch(&ticket, ticket::licence_contract(), &crypto::device_pubkey_hex()?, now)?;

    let device_priv = crypto::device_priv()?; // OS keystore (Credential Manager)
    let content_key = crypto::ecies_unwrap(&verified.wrapped_content_key, &device_priv)
        .map_err(|e| format!("clé d'appareil refusée: {e}"))?;

    let enc = std::fs::read(gv.join("build.enc")).map_err(|e| format!("build.enc: {e}"))?;
    let plain = crypto::decrypt_build(&enc, &content_key)
        .map_err(|e| format!("déchiffrement du build: {e}"))?;

    // The bytes describe their own runtime: PE executable ("MZ") -> native
    // process beside the launcher; anything else -> HTML in the webview.
    if plain.starts_with(b"MZ") {
        return launch_native(app, native, &verified.token_id, plain).map_err(|e| format!("runtime natif: {e}"));
    }

    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(plain);
    Ok(serde_json::json!({ "kind": "html" }))
}

/// Native runtime (design: docs/native-runtime.md). Transient verified
/// plaintext: write -> re-hash vs the decrypted buffer (GCM already proved
/// authenticity) -> spawn in its own console -> watch -> delete on exit.
fn launch_native(
    app: AppHandle,
    native: tauri::State<NativeSession>,
    token: &str, // from a VERIFIED ticket: digits only (ticket::verify_for_launch)
    plain: Vec<u8>,
) -> Result<Value, String> {
    use sha2::{Digest, Sha256};

    if native.0.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
        return Err("un jeu natif tourne déjà".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = run_root().join(format!("{token}-{stamp}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("dossier run: {e}"))?;
    let exe = dir.join("game.exe");
    std::fs::write(&exe, &plain).map_err(|e| format!("écriture exe: {e}"))?;

    // Paranoia hash: what landed on disk is byte-for-byte what we decrypted
    let on_disk = std::fs::read(&exe).map_err(|e| e.to_string())?;
    if Sha256::digest(&on_disk) != Sha256::digest(&plain) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("empreinte disque != empreinte déchiffrée".into());
    }

    let mut cmd = std::process::Command::new(&exe);
    cmd.current_dir(&dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE — own window
    }
    let child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
    let pid = child.id();

    let slot = native.0.clone();
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(NativeRun { child, dir, started: Instant::now() });

    // Watcher: polls the child; on natural exit -> cleanup + event.
    let watcher_slot = native.0.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(600));
        let mut guard = watcher_slot.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_mut() {
            Some(run) => match run.child.try_wait() {
                Ok(Some(status)) => {
                    let secs = run.started.elapsed().as_secs();
                    let dir = run.dir.clone();
                    *guard = None;
                    drop(guard);
                    let _ = std::fs::remove_dir_all(&dir);
                    let _ = app.emit(
                        "native-exited",
                        serde_json::json!({ "code": status.code(), "seconds": secs, "killed": false }),
                    );
                    break;
                }
                Ok(None) => {}
                Err(_) => {
                    // Lost track of the child: still never leave plaintext behind
                    let dir = run.dir.clone();
                    *guard = None;
                    drop(guard);
                    let _ = std::fs::remove_dir_all(&dir);
                    break;
                }
            },
            None => break, // ended via EJECT/revocation (end_native emitted)
        }
    });

    Ok(serde_json::json!({ "kind": "exe", "pid": pid }))
}

/// Quit: drop the HTML bundle from memory AND/OR kill the native process.
#[tauri::command]
fn stop_game(app: AppHandle, state: tauri::State<GameSession>, native: tauri::State<NativeSession>) {
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    end_native(&app, &native.0, true);
}

/// Resync after a webview reload: is a native game still running under us?
#[tauri::command]
fn native_status(native: tauri::State<NativeSession>) -> Value {
    match native.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        Some(run) => serde_json::json!({
            "running": true,
            "pid": run.child.id(),
            "seconds": run.started.elapsed().as_secs(),
        }),
        None => serde_json::json!({ "running": false }),
    }
}

/// This machine's device pubkey (creates the keypair on first call).
/// Proof that opens a ticketd SOCIAL session (chat, presence, play stats):
/// the launcher has no wallet, so its device key — registered to the wallet
/// when it paired a ticket — stands in. The message is built HERE with a
/// fixed, domain-separated header, a fresh timestamp and a random nonce: the
/// webview can ask for a session proof, never make the key sign anything else.
#[tauri::command]
fn device_session_proof(wallet: String) -> Result<Value, String> {
    let valid = wallet.len() == 42 && wallet.starts_with("0x") && wallet[2..].chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err("adresse de wallet invalide".into());
    }
    let device = crypto::device_pubkey_hex()?;
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let message = format!(
        "GameVault Device Session\nwallet: {wallet}\ndevice: {device}\nat: {at}\nnonce: {}",
        hex::encode(nonce)
    );
    let signature = crypto::device_sign(message.as_bytes())?;
    Ok(serde_json::json!({ "message": message, "signature": hex::encode(signature) }))
}

#[tauri::command]
fn get_device_pubkey() -> Result<String, String> {
    crypto::device_pubkey_hex()
}

/// Every removable volume (cartridge or blank) — install targets.
#[tauri::command]
fn list_removable_volumes() -> Vec<media::Volume> {
    media::list_removable()
}

/// THE physical moment: write a full /gamevault/ payload onto an SD/USB
/// volume — verified encrypted build + metadata + a placeholder ticket
/// that the pairing flow will replace with a real one.
#[tauri::command]
fn install_cartridge(
    mount_point: String,
    meta_json: String,
    ticket_json: String,
    data_b64: String,
) -> Result<(), String> {
    use base64::Engine;
    known_mount(&mount_point)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| format!("base64: {e}"))?;
    serde_json::from_str::<Value>(&meta_json).map_err(|e| format!("meta invalide: {e}"))?;
    serde_json::from_str::<Value>(&ticket_json).map_err(|e| format!("ticket invalide: {e}"))?;

    let gv = Path::new(&mount_point).join("gamevault");
    std::fs::create_dir_all(&gv).map_err(|e| format!("création dossier: {e}"))?;
    std::fs::write(gv.join("build.enc"), bytes).map_err(|e| format!("build.enc: {e}"))?;
    std::fs::write(gv.join("meta.json"), meta_json).map_err(|e| format!("meta.json: {e}"))?;
    std::fs::write(gv.join("ticket.json"), ticket_json).map_err(|e| format!("ticket.json: {e}"))?;
    Ok(())
}

/// Write a re-downloaded build.enc onto the cartridge (P3: verified
/// re-download). Integrity was already checked TS-side against the
/// published sha256; the bytes are still just public encrypted data.
#[tauri::command]
fn write_build(mount_point: String, data_b64: String) -> Result<(), String> {
    use base64::Engine;
    known_mount(&mount_point)?;
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
    known_mount(&mount_point)?;
    // Only a genuine ticket sealed for THIS machine ever reaches a card
    let parsed = serde_json::from_str::<Value>(&ticket_json).map_err(|e| format!("ticket invalide: {e}"))?;
    ticket::verify_for_write(&parsed, ticket::licence_contract(), &crypto::device_pubkey_hex()?)?;
    let path = Path::new(&mount_point).join("gamevault").join("ticket.json");
    std::fs::write(&path, ticket_json).map_err(|e| format!("écriture ticket: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(GameSession(Mutex::new(None)))
        .manage(NativeSession(Arc::new(Mutex::new(None))))
        .setup(|_app| {
            // Sweep run dirs orphaned by a previous crash — plaintext must
            // never outlive its process.
            let _ = std::fs::remove_dir_all(run_root());
            Ok(())
        })
        .register_uri_scheme_protocol("game", |ctx, _request| {
            let state = ctx.app_handle().state::<GameSession>();
            let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_ref() {
                Some(html) => tauri::http::Response::builder()
                    .header("Content-Type", "text/html; charset=utf-8")
                    .body(html.clone())
                    .unwrap(),
                None => tauri::http::Response::builder()
                    .status(404)
                    .body(b"no game loaded".to_vec())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            device_session_proof,
            scan_cartridges,
            play_game,
            stop_game,
            native_status,
            get_device_pubkey,
            write_ticket,
            write_build,
            list_removable_volumes,
            install_cartridge
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Plaintext must never outlive its process: closing the launcher
            // takes any running native game (and its run dir) down with it.
            if let tauri::RunEvent::Exit = event {
                let native = app.state::<NativeSession>();
                let slot = native.0.clone();
                end_native(app, &slot, true);
            }
        });
}
