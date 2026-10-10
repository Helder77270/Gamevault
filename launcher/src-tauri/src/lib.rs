mod crypto;
mod download;
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
    build_path: Option<String>,
) -> Result<Value, String> {
    known_mount(&mount_point)?;
    let gv = Path::new(&mount_point).join("gamevault");

    let ticket: Value = serde_json::from_str(&media::ticket_for_this_device(&gv).ok_or("ticket.json introuvable")?)
        .map_err(|e| format!("ticket.json invalide: {e}"))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX); // broken clock = treat as expired, fail closed
    let verified = ticket::verify_for_launch(&ticket, ticket::licence_contract(), &crypto::device_pubkey_hex()?, now)?;

    let device_priv = crypto::device_priv()?; // OS keystore (Credential Manager)
    let content_key = crypto::ecies_unwrap(&verified.wrapped_content_key, &device_priv)
        .map_err(|e| format!("clé d'appareil refusée: {e}"))?;

    // The card is the key; the game itself may live on the card or in a
    // library folder of this PC (<dir>/gamevault-library/<cid>/build.enc).
    let on_card = gv.join("build.enc");
    let build = if on_card.is_file() {
        on_card
    } else {
        let p = PathBuf::from(build_path.ok_or("jeu absent de la carte et de la bibliothèque")?);
        // a library game folder: build.enc beside its gamevault.json
        let in_library = p.file_name().is_some_and(|n| n == "build.enc")
            && p.parent().is_some_and(|f| f.join("gamevault.json").is_file());
        if !in_library || !p.is_file() {
            return Err("chemin de jeu refusé".into());
        }
        p
    };
    let enc = std::fs::read(&build).map_err(|e| format!("build.enc: {e}"))?;
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
    serde_json::from_str::<Value>(&meta_json).map_err(|e| format!("meta invalide: {e}"))?;
    serde_json::from_str::<Value>(&ticket_json).map_err(|e| format!("ticket invalide: {e}"))?;

    let gv = Path::new(&mount_point).join("gamevault");
    std::fs::create_dir_all(&gv).map_err(|e| format!("création dossier: {e}"))?;
    // Empty data = a key-only card (the game lives on this PC or comes later
    // through the download manager).
    if !data_b64.is_empty() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|e| format!("base64: {e}"))?;
        std::fs::write(gv.join("build.enc"), bytes).map_err(|e| format!("build.enc: {e}"))?;
    }
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
    let device = crypto::device_pubkey_hex()?;
    ticket::verify_for_write(&parsed, ticket::licence_contract(), &device)?;
    // one ticket per paired machine, 2 kept (the account's device limit)
    media::store_ticket(&Path::new(&mount_point).join("gamevault"), &device, &ticket_json, 2)
}

// ── Download manager (download.rs) ───────────────────────────────────────

/// Where a download lands: a detected card (its /gamevault/) or a library
/// folder of this PC. The full path is always built on this side.
fn dl_target(dest_kind: &str, dest: &str, cid: &str, title: &str) -> Result<PathBuf, String> {
    match dest_kind {
        "card" => {
            known_mount(dest)?;
            Ok(Path::new(dest).join("gamevault").join("build.enc"))
        }
        "library" => download::library_target(dest, cid, title),
        _ => Err("destination inconnue".into()),
    }
}

/// The exact folder a download would land in (shown before it starts).
#[tauri::command]
fn dl_preview(dest_kind: String, dest: String, cid: String, title: String) -> Result<String, String> {
    if dest_kind == "library" && !Path::new(&dest).is_dir() {
        // a library not created yet: same naming rule, previewed under it
        if cid.len() < 10 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("CID invalide".into());
        }
        return Ok(Path::new(&dest).join(download::game_folder_name(&title, &cid)).to_string_lossy().into_owned());
    }
    let t = dl_target(&dest_kind, &dest, &cid, &title)?;
    Ok(t.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default())
}

/// A first library folder to propose when none exists yet.
#[tauri::command]
fn default_library() -> Option<(String, u64, u64)> {
    download::default_library()
}

#[tauri::command]
fn create_library(path: String) -> Result<String, String> {
    download::create_library(&path)
}

#[tauri::command]
fn dl_start(
    app: AppHandle,
    dl: tauri::State<Arc<download::Downloads>>,
    id: String,
    cid: String,
    sha256: String,
    dest_kind: String,
    dest: String,
    title: String,
    edition: String,
) -> Result<String, String> {
    let target = dl_target(&dest_kind, &dest, &cid, &title)?;
    if dest_kind == "library" {
        download::mark_game_folder(&target, &cid, &title, &edition)?;
    }
    download::start(app, Arc::clone(&dl), id, cid, sha256, target.clone())?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn dl_repair(
    app: AppHandle,
    dl: tauri::State<Arc<download::Downloads>>,
    id: String,
    cid: String,
    sha256: String,
    dest_kind: String,
    dest: String,
    title: String,
) -> Result<(), String> {
    let target = dl_target(&dest_kind, &dest, &cid, &title)?;
    if !target.is_file() {
        return Err("aucun jeu installé à réparer ici".into());
    }
    download::repair(app, Arc::clone(&dl), id, cid, sha256, target)
}

#[tauri::command]
fn dl_pause(dl: tauri::State<Arc<download::Downloads>>, id: String) {
    download::pause(&dl, &id);
}

#[tauri::command]
fn dl_cancel(dl: tauri::State<Arc<download::Downloads>>, id: String) {
    download::cancel(&dl, &id);
}

/// Free / total bytes for a card or a library folder.
#[tauri::command]
fn disk_space(path: String) -> Option<(u64, u64)> {
    download::disk_space(&path)
}

#[tauri::command]
fn library_scan(dirs: Vec<String>) -> Vec<download::LibraryEntry> {
    download::scan_library(&dirs)
}

// ── Desktop toasts (P7 #1) ───────────────────────────────────────────────
// Steam-like: a small AURA-64 window over every other app, bottom-right of
// the screen's work area, never taking the focus. It is created on demand,
// sized to its toasts (so the empty part never blocks clicks behind it) and
// closed when the last one leaves. A click brings the launcher back.

const TOAST_W: f64 = 384.0;

#[derive(Default)]
struct Toasts(Mutex<(bool, Vec<Value>)>); // (window ready, queued before it was)

fn place_toast_window(w: &tauri::WebviewWindow, height: f64) {
    let Ok(Some(m)) = w.primary_monitor() else { return };
    let scale = m.scale_factor();
    let wa = m.work_area();
    let margin = (10.0 * scale) as i32;
    let x = wa.position.x + wa.size.width as i32 - (TOAST_W * scale) as i32 - margin;
    let y = wa.position.y + wa.size.height as i32 - (height * scale) as i32 - margin;
    let _ = w.set_size(tauri::LogicalSize::new(TOAST_W, height));
    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
}

// ASYNC on purpose: creating (or closing) a window from a synchronous
// command deadlocks the event loop on Windows — the launcher's own window
// buttons stopped answering. The queue lock is never held across a window
// operation either.
#[tauri::command]
async fn desktop_toast(app: AppHandle, toasts: tauri::State<'_, Toasts>, payload: Value) -> Result<(), String> {
    let existing = app.get_webview_window("toast");
    let ready = {
        let mut st = toasts.0.lock().unwrap_or_else(|e| e.into_inner());
        if existing.is_none() || !st.0 {
            if existing.is_none() {
                st.0 = false;
            }
            st.1.push(payload.clone()); // picked up by toast_ready once the page loads
            false
        } else {
            true
        }
    };
    if let Some(w) = existing {
        if ready {
            w.emit("desktop-toast", payload).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let w = tauri::WebviewWindowBuilder::new(&app, "toast", tauri::WebviewUrl::App("toast.html".into()))
        .title("AURA-64")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .inner_size(TOAST_W, 120.0)
        .build()
        .map_err(|e| format!("fenêtre de notification: {e}"))?;
    place_toast_window(&w, 120.0);
    w.show().map_err(|e| e.to_string())
}

/// The toast page is loaded: hand over what arrived meanwhile.
#[tauri::command]
fn toast_ready(toasts: tauri::State<Toasts>) -> Vec<Value> {
    let mut st = toasts.0.lock().unwrap_or_else(|e| e.into_inner());
    st.0 = true;
    std::mem::take(&mut st.1)
}

/// Fit the window to its toasts (height in CSS px), bottom-right anchored.
#[tauri::command]
fn toast_fit(window: tauri::WebviewWindow, height: f64) {
    if window.label() == "toast" {
        place_toast_window(&window, height.clamp(40.0, 900.0));
    }
}

#[tauri::command]
async fn toast_close(window: tauri::WebviewWindow, toasts: tauri::State<'_, Toasts>) -> Result<(), String> {
    if window.label() == "toast" {
        *toasts.0.lock().unwrap_or_else(|e| e.into_inner()) = (false, Vec::new());
        let _ = window.destroy();
    }
    Ok(())
}

// ── Local services (POC) ─────────────────────────────────────────────────
// In the real product ticketd and the site are hosted online, like Steam's
// servers. For the POC they live in this repo, on this machine: at launch,
// AURA-64 starts whichever of them is not answering yet (hidden, logs in
// %LOCALAPPDATA%\GameVault\logs) and stops what it started when it quits.
// Already running (dev.cmd)? Nothing is started, nothing is stopped.

#[derive(Default)]
struct Services(Mutex<Vec<(String, std::process::Child)>>);

/// The monorepo this launcher was built from (POC: services run from it).
const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

fn port_open(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(400)).is_ok()
}

#[tauri::command]
async fn start_local_services(services: tauri::State<'_, Services>) -> Result<Value, String> {
    let root = PathBuf::from(REPO_ROOT);
    if !root.join("ticketd").join("package.json").is_file() {
        return Err("dépôt GameVault introuvable : services locaux indisponibles".into());
    }
    let logs = std::env::var("LOCALAPPDATA")
        .map(|d| PathBuf::from(d).join("GameVault").join("logs"))
        .unwrap_or_else(|_| std::env::temp_dir().join("GameVault-logs"));
    let _ = std::fs::create_dir_all(&logs);
    let mut started = Vec::new();
    for (name, port, workspace) in [("ticketd", 8787u16, "@gamevault/ticketd"), ("web", 3000u16, "@gamevault/web")] {
        if port_open(port) {
            continue;
        }
        let log = std::fs::File::create(logs.join(format!("{name}.log"))).map_err(|e| format!("journal {name}: {e}"))?;
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", "npm", "run", "dev", "-w", workspace])
            .current_dir(&root)
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd.spawn().map_err(|e| format!("lancement de {name}: {e}"))?;
        services.0.lock().unwrap_or_else(|e| e.into_inner()).push((name.to_string(), child));
        started.push(name);
    }
    // The launcher needs ticketd (tickets, friends, chat); the site can
    // finish compiling in the background.
    let ticketd = tauri::async_runtime::spawn_blocking(|| {
        for _ in 0..60 {
            if port_open(8787) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        false
    })
    .await
    .unwrap_or(false);
    Ok(serde_json::json!({ "started": started, "ticketd": ticketd, "logs": logs.to_string_lossy() }))
}

/// Stop what AURA-64 started (the whole npm → node tree).
fn stop_local_services(app: &AppHandle) {
    let services = app.state::<Services>();
    let mut list = services.0.lock().unwrap_or_else(|e| e.into_inner());
    for (_, child) in list.iter_mut() {
        let mut kill = std::process::Command::new("taskkill");
        kill.args(["/PID", &child.id().to_string(), "/T", "/F"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            kill.creation_flags(0x0800_0000);
        }
        let _ = kill.status();
        let _ = child.wait();
    }
    list.clear();
}

/// Started by Windows at login (the autostart entry passes --autostart).
#[tauri::command]
fn launched_at_startup() -> bool {
    std::env::args().any(|a| a == "--autostart")
}

#[tauri::command]
fn focus_main(app: AppHandle) {
    show_main(&app);
}

/// Bring the launcher back from the notification area.
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Windows startup: the Run entry adds --autostart, so the launcher
        // can stay in the notification area when the user asked for it.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .manage(Toasts::default())
        .manage(Services::default())
        .manage(Arc::new(download::Downloads::default()))
        .manage(GameSession(Mutex::new(None)))
        .manage(NativeSession(Arc::new(Mutex::new(None))))
        .setup(|app| {
            // Sweep run dirs orphaned by a previous crash — plaintext must
            // never outlive its process.
            let _ = std::fs::remove_dir_all(run_root());

            // Steam-like: closing the window keeps AURA-64 alive in the
            // notification area (friends, presence, downloads go on); it
            // really quits only from the tray menu.
            let open = tauri::menu::MenuItem::with_id(app, "open", "Ouvrir AURA-64", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "Quitter AURA-64", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&open, &quit])?;
            let mut tray = tauri::tray::TrayIconBuilder::with_id("main")
                .tooltip("AURA-64 · GameVault")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0), // RunEvent::Exit then ends any native game
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = e
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            // The window starts hidden (tauri.conf.json): a normal launch
            // shows it at once; a Windows-startup launch lets the webview
            // decide (settings: "start in the notification area").
            if !launched_at_startup() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // only the launcher hides to the tray; the toast window really closes
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
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
            install_cartridge,
            dl_start,
            dl_repair,
            dl_pause,
            dl_cancel,
            disk_space,
            library_scan,
            dl_preview,
            default_library,
            create_library,
            desktop_toast,
            toast_ready,
            toast_fit,
            toast_close,
            focus_main,
            launched_at_startup,
            start_local_services
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
                stop_local_services(app); // POC: the services AURA-64 started go with it
            }
        });
}
