//! Download manager (2026-10-10). A build is ONE encrypted container
//! (build.enc), fetched in 4 MiB chunks over HTTP ranges by a few parallel
//! workers, written straight to disk (never held whole in RAM).
//!
//! Sources: the GameVault server (ticketd) first, IPFS gateways as mirrors,
//! chunk by chunk — a chunk that fails on one source is retried on the next.
//! Each chunk is checked against the server's chunk list as it lands; the
//! list only speeds things up: the WHOLE file must finally match the sha256
//! registered on-chain (passed in by the caller from the registry), so a
//! lying list or mirror is always caught.
//!
//! Resumable: progress lives next to the target (`build.enc.part` +
//! `build.enc.dl.json`), so a pause or a restart picks up where it stopped.
//! Repair re-reads the installed file chunk by chunk, re-fetches only the
//! chunks that fail, then re-checks the on-chain sha256.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Where progress and log events go: the webview in the app, a collector
/// in tests.
pub type Sink = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

fn app_sink(app: &AppHandle) -> Sink {
    let app = app.clone();
    Arc::new(move |event, payload| {
        let _ = app.emit(event, payload);
    })
}

const SERVER: &str = "http://127.0.0.1:8787/build/";
const GATEWAYS: [&str; 3] = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"];
const WORKERS: usize = 4;
const TRIES_PER_CHUNK: usize = 3;
const DEFAULT_CHUNK: u64 = 4 * 1024 * 1024;

// ── Speed limit: one token bucket shared by every worker (0 = unlimited).
// Changed live from the settings; a download in flight follows at once.
static LIMIT_BPS: AtomicU64 = AtomicU64::new(0);
static BUCKET: Mutex<Option<(Instant, f64)>> = Mutex::new(None);

pub fn set_limit(bps: u64) {
    LIMIT_BPS.store(bps, Ordering::Relaxed);
    *BUCKET.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Wait until `n` bytes may be received under the limit. The bucket holds
/// one second of budget; a read bigger than the budget borrows ahead.
fn throttle(n: usize, ctl: &Ctl) {
    loop {
        let limit = LIMIT_BPS.load(Ordering::Relaxed) as f64;
        if limit <= 0.0 || ctl.cancel.load(Ordering::Relaxed) {
            return;
        }
        let wait = {
            let mut b = BUCKET.lock().unwrap_or_else(|e| e.into_inner());
            let (last, tokens) = b.get_or_insert((Instant::now(), limit));
            let now = Instant::now();
            *tokens = (*tokens + now.duration_since(*last).as_secs_f64() * limit).min(limit);
            *last = now;
            if *tokens >= (n as f64).min(limit) {
                *tokens -= n as f64;
                return;
            }
            ((n as f64).min(limit) - *tokens) / limit
        };
        std::thread::sleep(Duration::from_secs_f64(wait.clamp(0.005, 0.25)));
    }
}

/// Chunk states, one char each in the progress event (the UI's chunk map).
const PENDING: u8 = b'p';
const ACTIVE: u8 = b'a';
const DONE: u8 = b'v';
const MIRROR: u8 = b'm'; // verified, but served by an IPFS mirror
const BAD: u8 = b'x';

#[derive(Default)]
pub struct Downloads(pub Mutex<HashMap<String, Arc<Ctl>>>);

#[derive(Default)]
pub struct Ctl {
    pause: AtomicBool,
    cancel: AtomicBool,
}

#[derive(Serialize, Deserialize, Clone)]
struct Manifest {
    size: u64,
    #[serde(rename = "chunkSize")]
    chunk_size: u64,
    /// hex sha256 per chunk; empty when no list was available
    chunks: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct State {
    cid: String,
    manifest: Manifest,
    done: Vec<bool>,
}

#[derive(Serialize, Clone)]
struct Progress {
    id: String,
    /// "prepare" | "download" | "read" | "fetch" | "final" | "paused" | "done" | "error" | "cancelled"
    phase: String,
    done: u64,
    total: u64,
    net_bps: u64,
    disk_bps: u64,
    chunks: String,
    source: String,
    mirror_chunks: u32,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct Log {
    id: String,
    line: String,
}

fn cid_ok(cid: &str) -> bool {
    (10..=100).contains(&cid.len()) && cid.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn hex_ok(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Library layout, readable in the file explorer:
///   <library>/<Game title> (<cid 8>)/build.enc + gamevault.json
/// The title is cosmetic (sanitized); gamevault.json says which build the
/// folder holds. The webview only names the library folder; the rest of the
/// path is built here.
pub fn library_target(dir: &str, cid: &str, title: &str) -> Result<PathBuf, String> {
    if !cid_ok(cid) {
        return Err("CID invalide".into());
    }
    let base = PathBuf::from(dir);
    if !base.is_absolute() || !base.is_dir() {
        return Err("dossier introuvable".into());
    }
    // an already-installed copy keeps its folder, even if the title changed
    if let Some(found) = scan_library(&[dir.to_string()]).into_iter().find(|e| e.cid == cid) {
        if let Some(folder) = PathBuf::from(found.path).parent() {
            return Ok(folder.join("build.enc"));
        }
    }
    Ok(base.join(game_folder_name(title, cid)).join("build.enc"))
}

pub fn game_folder_name(title: &str, cid: &str) -> String {
    let clean: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_'.".contains(c) { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let clean: String = clean.trim_matches(|c: char| c == '.' || c == ' ').chars().take(60).collect();
    let name = if clean.is_empty() { "Jeu".to_string() } else { clean };
    format!("{name} ({})", &cid[..8])
}

/// Mark a library game folder with what it holds (written before the
/// download starts, so a resumable part is recognised after a restart).
pub fn mark_game_folder(target: &Path, cid: &str, title: &str, edition: &str) -> Result<(), String> {
    let folder = target.parent().ok_or("dossier invalide")?;
    std::fs::create_dir_all(folder).map_err(|e| format!("dossier: {e}"))?;
    let info = serde_json::json!({ "cid": cid, "title": title, "edition": edition });
    std::fs::write(folder.join("gamevault.json"), info.to_string()).map_err(|e| format!("gamevault.json: {e}"))
}

/// A suggested first library: <system drive>\Users\<me>\GameVault, or
/// <drive>\GameVault on the fixed drive with the most free space.
pub fn default_library() -> Option<(String, u64, u64)> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let best = disks.list().iter().filter(|d| !d.is_removable()).max_by_key(|d| d.available_space())?;
    let mount = best.mount_point().to_path_buf();
    let home = std::env::var("USERPROFILE").ok().map(PathBuf::from);
    let path = match &home {
        Some(h) if h.starts_with(&mount) => h.join("GameVault"),
        _ => mount.join("GameVault"),
    };
    Some((path.to_string_lossy().into_owned(), best.available_space(), best.total_space()))
}

/// Create a library folder — only one named GameVault, under an existing parent.
pub fn create_library(path: &str) -> Result<String, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() || !p.file_name().is_some_and(|n| n == "GameVault") || !p.parent().is_some_and(|x| x.is_dir()) {
        return Err("emplacement refusé".into());
    }
    std::fs::create_dir_all(&p).map_err(|e| format!("création du dossier: {e}"))?;
    Ok(p.to_string_lossy().into_owned())
}

fn part_of(target: &Path) -> PathBuf {
    target.with_extension("enc.part")
}
fn state_of(target: &Path) -> PathBuf {
    target.with_extension("enc.dl.json")
}
fn local_manifest_of(target: &Path) -> PathBuf {
    target.with_extension("enc.manifest.json")
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(6))
        .timeout_read(Duration::from_secs(30))
        .build()
}

fn sources(cid: &str) -> Vec<(String, String)> {
    let mut v = vec![("SERVEUR GAMEVAULT".to_string(), format!("{SERVER}{cid}"))];
    for g in GATEWAYS {
        let label = g.trim_start_matches("https://").split('/').next().unwrap_or(g).to_uppercase();
        v.push((format!("IPFS · {label}"), format!("{g}{cid}")));
    }
    v
}

/// The server's chunk list, else the one saved beside an earlier verified
/// download, else none (then only the final on-chain check applies).
fn load_manifest(cid: &str, target: &Path) -> Option<Manifest> {
    if let Ok(resp) = agent().get(&format!("{SERVER}{cid}/manifest")).call() {
        if let Ok(m) = resp.into_json::<Manifest>() {
            if m.chunk_size > 0 && m.chunks.iter().all(|c| hex_ok(c)) {
                return Some(m);
            }
        }
    }
    std::fs::read_to_string(local_manifest_of(target))
        .ok()
        .and_then(|s| serde_json::from_str::<Manifest>(&s).ok())
}

fn remote_size(cid: &str) -> Option<u64> {
    for (_, url) in sources(cid) {
        if let Ok(r) = agent().head(&url).call() {
            if let Some(n) = r.header("Content-Length").and_then(|v| v.parse::<u64>().ok()) {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }
    None
}

/// Free / total bytes of the volume holding `path` (longest mount prefix).
pub fn disk_space(path: &str) -> Option<(u64, u64)> {
    let p = PathBuf::from(path);
    let p = std::fs::canonicalize(&p).unwrap_or(p);
    let p = p.to_string_lossy().trim_start_matches(r"\\?\").to_lowercase();
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| p.starts_with(&d.mount_point().to_string_lossy().to_lowercase()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| (d.available_space(), d.total_space()))
}

fn fetch_range(url: &str, start: u64, end: u64, net: &AtomicU64, ctl: &Ctl) -> Result<Vec<u8>, String> {
    let resp = agent()
        .get(url)
        .set("Range", &format!("bytes={start}-{end}"))
        .call()
        .map_err(|e| e.to_string())?;
    let want = (end - start + 1) as usize;
    let mut reader = resp.into_reader();
    let mut buf = Vec::with_capacity(want);
    let mut tmp = [0u8; 64 * 1024];
    // A server that ignores Range sends the whole file from byte 0: refuse
    // anything longer than the chunk (and a short read is an error too).
    loop {
        if ctl.cancel.load(Ordering::Relaxed) {
            return Err("annulé".into());
        }
        let n = reader.read(&mut tmp).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        net.fetch_add(n as u64, Ordering::Relaxed);
        throttle(n, ctl);
        if buf.len() > want {
            return Err("plage ignorée par la source".into());
        }
    }
    if buf.len() != want {
        return Err(format!("morceau incomplet ({} / {want} octets)", buf.len()));
    }
    Ok(buf)
}

fn sha_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Whole-file sha256, streamed — the on-chain check.
fn file_sha(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

struct Run {
    sink: Sink,
    id: String,
    cid: String,
    ctl: Arc<Ctl>,
    manifest: Manifest,
    states: Mutex<Vec<u8>>,
    net: AtomicU64,
    disk: AtomicU64,
    done_bytes: AtomicU64,
    mirror_chunks: AtomicU64,
    source: Mutex<String>,
    phase: Mutex<String>,
}

impl Run {
    fn bounds(&self, i: usize) -> (u64, u64) {
        let start = i as u64 * self.manifest.chunk_size;
        let end = (start + self.manifest.chunk_size).min(self.manifest.size) - 1;
        (start, end)
    }
    fn log(&self, line: String) {
        (self.sink)("dl-log", serde_json::to_value(Log { id: self.id.clone(), line }).unwrap_or_default());
    }
    fn emit(&self, net_bps: u64, disk_bps: u64, error: Option<String>) {
        let chunks = String::from_utf8(self.states.lock().unwrap_or_else(|e| e.into_inner()).clone()).unwrap_or_default();
        (self.sink)(
            "dl-progress",
            serde_json::to_value(Progress {
                id: self.id.clone(),
                phase: self.phase.lock().unwrap_or_else(|e| e.into_inner()).clone(),
                done: self.done_bytes.load(Ordering::Relaxed),
                total: self.manifest.size,
                net_bps,
                disk_bps,
                chunks,
                source: self.source.lock().unwrap_or_else(|e| e.into_inner()).clone(),
                mirror_chunks: self.mirror_chunks.load(Ordering::Relaxed) as u32,
                error,
            })
            .unwrap_or_default(),
        );
    }
    fn set_phase(&self, p: &str) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = p.to_string();
    }

    /// Fetch every chunk in `todo` into `file` (parallel, mirror failover,
    /// per-chunk verification when the list is known). Ok(true) = all done,
    /// Ok(false) = paused/cancelled.
    fn fetch_chunks(self: &Arc<Self>, file: &Path, todo: Vec<usize>, persist: Option<&Path>) -> Result<bool, String> {
        let queue = Arc::new(Mutex::new(todo.into_iter().map(|i| (i, 0usize)).collect::<VecDeque<_>>()));
        let failure: Arc<Mutex<Option<String>>> = Arc::default();
        let srcs = sources(&self.cid);
        let mut handles = Vec::new();
        for _ in 0..WORKERS {
            let me = Arc::clone(self);
            let queue = Arc::clone(&queue);
            let failure = Arc::clone(&failure);
            let srcs = srcs.clone();
            let file = file.to_path_buf();
            let persist = persist.map(|p| p.to_path_buf());
            handles.push(std::thread::spawn(move || {
                let mut out = match OpenOptions::new().write(true).open(&file) {
                    Ok(f) => f,
                    Err(e) => {
                        *failure.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("écriture: {e}"));
                        return;
                    }
                };
                loop {
                    if me.ctl.cancel.load(Ordering::Relaxed) || me.ctl.pause.load(Ordering::Relaxed) {
                        return;
                    }
                    if failure.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
                        return;
                    }
                    let Some((i, tries)) = queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front() else { return };
                    me.states.lock().unwrap_or_else(|e| e.into_inner())[i] = ACTIVE;
                    let (start, end) = me.bounds(i);
                    let expect = me.manifest.chunks.get(i).cloned();
                    let mut got: Option<(Vec<u8>, usize)> = None;
                    for (si, (label, url)) in srcs.iter().enumerate() {
                        match fetch_range(url, start, end, &me.net, &me.ctl) {
                            Ok(bytes) => {
                                if let Some(want) = &expect {
                                    let have = sha_hex(&bytes);
                                    if &have != want {
                                        me.log(format!("morceau {i} · {label} · sha-256 {}… ≠ attendu {}… · source suivante", &have[..8], &want[..8]));
                                        continue;
                                    }
                                }
                                *me.source.lock().unwrap_or_else(|e| e.into_inner()) = label.clone();
                                got = Some((bytes, si));
                                break;
                            }
                            Err(e) => {
                                if me.ctl.cancel.load(Ordering::Relaxed) {
                                    return;
                                }
                                if si == 0 {
                                    me.log(format!("morceau {i} · {label} indisponible ({e}) · miroir IPFS"));
                                }
                            }
                        }
                    }
                    match got {
                        Some((bytes, si)) => {
                            let res = out.seek(SeekFrom::Start(start)).and_then(|_| out.write_all(&bytes));
                            if let Err(e) = res {
                                *failure.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("écriture disque: {e}"));
                                return;
                            }
                            me.disk.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                            me.done_bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                            if si > 0 {
                                me.mirror_chunks.fetch_add(1, Ordering::Relaxed);
                            }
                            me.states.lock().unwrap_or_else(|e| e.into_inner())[i] = if si > 0 { MIRROR } else { DONE };
                            if let Some(p) = &persist {
                                me.save_state(p);
                            }
                        }
                        None if tries + 1 < TRIES_PER_CHUNK => {
                            me.states.lock().unwrap_or_else(|e| e.into_inner())[i] = PENDING;
                            queue.lock().unwrap_or_else(|e| e.into_inner()).push_back((i, tries + 1));
                            std::thread::sleep(Duration::from_millis(800));
                        }
                        None => {
                            me.states.lock().unwrap_or_else(|e| e.into_inner())[i] = BAD;
                            *failure.lock().unwrap_or_else(|e| e.into_inner()) =
                                Some(format!("morceau {i} introuvable sur toutes les sources"));
                            return;
                        }
                    }
                }
            }));
        }

        // Progress ticker while the workers run
        let mut last = Instant::now();
        let (mut net0, mut disk0) = (self.net.load(Ordering::Relaxed), self.disk.load(Ordering::Relaxed));
        while handles.iter().any(|h| !h.is_finished()) {
            std::thread::sleep(Duration::from_millis(250));
            let dt = last.elapsed().as_secs_f64();
            if dt >= 0.5 {
                let (n, d) = (self.net.load(Ordering::Relaxed), self.disk.load(Ordering::Relaxed));
                self.emit(((n - net0) as f64 / dt) as u64, ((d - disk0) as f64 / dt) as u64, None);
                (net0, disk0, last) = (n, d, Instant::now());
            }
        }
        for h in handles {
            let _ = h.join();
        }
        if let Some(p) = persist {
            self.save_state(p);
        }
        if let Some(e) = failure.lock().unwrap_or_else(|e| e.into_inner()).take() {
            return Err(e);
        }
        Ok(!(self.ctl.cancel.load(Ordering::Relaxed) || self.ctl.pause.load(Ordering::Relaxed)))
    }

    fn save_state(&self, p: &Path) {
        let done = self.states.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|&c| c == DONE || c == MIRROR).collect();
        let st = State { cid: self.cid.clone(), manifest: self.manifest.clone(), done };
        if let Ok(s) = serde_json::to_string(&st) {
            let _ = std::fs::write(p, s);
        }
    }
}

fn register(dl: &Downloads, id: &str) -> Result<Arc<Ctl>, String> {
    let mut map = dl.0.lock().unwrap_or_else(|e| e.into_inner());
    if map.contains_key(id) {
        return Err("déjà en cours".into());
    }
    let ctl = Arc::new(Ctl::default());
    map.insert(id.to_string(), Arc::clone(&ctl));
    Ok(ctl)
}

pub fn any_active(dl: &Downloads) -> bool {
    !dl.0.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
}

pub fn pause(dl: &Downloads, id: &str) {
    if let Some(c) = dl.0.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
        c.pause.store(true, Ordering::Relaxed);
    }
}

pub fn cancel(dl: &Downloads, id: &str) {
    if let Some(c) = dl.0.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
        c.cancel.store(true, Ordering::Relaxed);
    }
}

fn new_run(sink: &Sink, id: &str, cid: &str, ctl: Arc<Ctl>, manifest: Manifest, states: Vec<u8>) -> Arc<Run> {
    let done_bytes = states
        .iter()
        .enumerate()
        .filter(|(_, &c)| c == DONE || c == MIRROR)
        .map(|(i, _)| {
            let start = i as u64 * manifest.chunk_size;
            (start + manifest.chunk_size).min(manifest.size) - start
        })
        .sum();
    Arc::new(Run {
        sink: Arc::clone(sink),
        id: id.to_string(),
        cid: cid.to_string(),
        ctl,
        manifest,
        states: Mutex::new(states),
        net: AtomicU64::new(0),
        disk: AtomicU64::new(0),
        done_bytes: AtomicU64::new(done_bytes),
        mirror_chunks: AtomicU64::new(0),
        source: Mutex::new(String::new()),
        phase: Mutex::new("prepare".into()),
    })
}

/// Start or resume a download into `target`. Runs on its own thread; the UI
/// follows `dl-progress` / `dl-log` events.
pub fn start(app: AppHandle, dl: Arc<Downloads>, id: String, cid: String, sha256: String, target: PathBuf) -> Result<(), String> {
    let want = sha256.trim_start_matches("0x").to_lowercase();
    if !cid_ok(&cid) || !hex_ok(&want) {
        return Err("édition invalide".into());
    }
    let ctl = register(&dl, &id)?;
    let reg = dl;
    std::thread::spawn(move || {
        let sink = app_sink(&app);
        let result = run_download(&sink, &id, &cid, &want, &target, Arc::clone(&ctl));
        reg.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        if let Err(e) = result {
            sink("dl-progress", serde_json::json!({ "id": id, "phase": "error", "error": e }));
        }
    });
    Ok(())
}

fn run_download(sink: &Sink, id: &str, cid: &str, want: &str, target: &Path, ctl: Arc<Ctl>) -> Result<(), String> {
    let part = part_of(target);
    let state_path = state_of(target);
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("dossier: {e}"))?;
    }

    // Resume when a matching state exists, else start fresh.
    let resumed = std::fs::read_to_string(&state_path)
        .ok()
        .and_then(|s| serde_json::from_str::<State>(&s).ok())
        .filter(|s| s.cid == cid && part.is_file());
    let (manifest, done) = match resumed {
        Some(s) => (s.manifest, s.done),
        None => {
            let m = match load_manifest(cid, target) {
                Some(m) => m,
                None => Manifest { size: remote_size(cid).ok_or("taille du jeu inconnue : aucune source ne répond")?, chunk_size: DEFAULT_CHUNK, chunks: vec![] },
            };
            let n = m.size.div_ceil(m.chunk_size).max(1) as usize;
            (m, vec![false; n])
        }
    };

    // Space check against what is still missing (+1 % margin).
    let missing: u64 = manifest.size.saturating_sub(done.iter().filter(|&&d| d).count() as u64 * manifest.chunk_size);
    if let Some((free, _)) = target.parent().and_then(|d| disk_space(&d.to_string_lossy())) {
        if free < missing + missing / 100 {
            return Err(format!("espace insuffisant : {} Mo libres, {} Mo nécessaires", free / 1_048_576, missing / 1_048_576 + 1));
        }
    }

    {
        let f = OpenOptions::new().create(true).write(true).truncate(false).open(&part).map_err(|e| format!("fichier: {e}"))?;
        f.set_len(manifest.size).map_err(|e| format!("fichier: {e}"))?;
    }
    let states: Vec<u8> = done.iter().map(|&d| if d { DONE } else { PENDING }).collect();
    let todo: Vec<usize> = done.iter().enumerate().filter(|(_, &d)| !d).map(|(i, _)| i).collect();
    let run = new_run(sink, id, cid, Arc::clone(&ctl), manifest.clone(), states);
    run.set_phase("download");
    run.emit(0, 0, None);

    let complete = run.fetch_chunks(&part, todo, Some(&state_path))?;
    if ctl.cancel.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(&part);
        let _ = std::fs::remove_file(&state_path);
        run.set_phase("cancelled");
        run.emit(0, 0, None);
        return Ok(());
    }
    if !complete {
        run.set_phase("paused");
        run.emit(0, 0, None);
        return Ok(());
    }

    run.set_phase("final");
    run.emit(0, 0, None);
    let have = file_sha(&part)?;
    if have != want {
        let _ = std::fs::remove_file(&state_path);
        return Err(format!("empreinte finale {}… ≠ contrat {}… : téléchargement rejeté", &have[..12], &want[..12]));
    }
    std::fs::rename(&part, target).or_else(|_| {
        let _ = std::fs::remove_file(target);
        std::fs::rename(&part, target)
    })
    .map_err(|e| format!("installation: {e}"))?;
    let _ = std::fs::remove_file(&state_path);
    // Keep the chunk list beside the verified file: repairs work even when
    // the server is unreachable (the list is checked again at the end).
    let local = if manifest.chunks.is_empty() { chunk_list(target, manifest.chunk_size)? } else { manifest.clone() };
    let _ = std::fs::write(local_manifest_of(target), serde_json::to_string(&local).unwrap_or_default());
    run.log(format!("empreinte finale {}… · conforme au contrat ✓", &have[..12]));
    run.set_phase("done");
    run.emit(0, 0, None);
    Ok(())
}

fn chunk_list(path: &Path, chunk_size: u64) -> Result<Manifest, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let mut chunks = Vec::new();
    let mut buf = vec![0u8; chunk_size as usize];
    loop {
        let mut filled = 0;
        while filled < buf.len() {
            let n = f.read(&mut buf[filled..]).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        if filled == 0 {
            break;
        }
        chunks.push(sha_hex(&buf[..filled]));
        if filled < buf.len() {
            break;
        }
    }
    Ok(Manifest { size, chunk_size, chunks })
}

/// Verify an installed build chunk by chunk, re-fetch only what fails,
/// then re-check the on-chain sha256.
pub fn repair(app: AppHandle, dl: Arc<Downloads>, id: String, cid: String, sha256: String, target: PathBuf) -> Result<(), String> {
    let want = sha256.trim_start_matches("0x").to_lowercase();
    if !cid_ok(&cid) || !hex_ok(&want) {
        return Err("édition invalide".into());
    }
    let ctl = register(&dl, &id)?;
    let reg = dl;
    std::thread::spawn(move || {
        let sink = app_sink(&app);
        let result = run_repair(&sink, &id, &cid, &want, &target, Arc::clone(&ctl));
        reg.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        if let Err(e) = result {
            sink("dl-progress", serde_json::json!({ "id": id, "phase": "error", "error": e }));
        }
    });
    Ok(())
}

fn run_repair(sink: &Sink, id: &str, cid: &str, want: &str, target: &Path, ctl: Arc<Ctl>) -> Result<(), String> {
    let manifest = match load_manifest(cid, target) {
        Some(m) => m,
        None => Manifest { size: remote_size(cid).ok_or("aucune source ne répond")?, chunk_size: DEFAULT_CHUNK, chunks: vec![] },
    };
    let n = manifest.size.div_ceil(manifest.chunk_size).max(1) as usize;
    let run = new_run(sink, id, cid, Arc::clone(&ctl), manifest.clone(), vec![PENDING; n]);
    run.set_phase("read");
    run.log(format!(
        "liste des morceaux · {} · {n} × {} Mo",
        if manifest.chunks.is_empty() { "indisponible (contrôle final seul)" } else { "serveur GameVault" },
        manifest.chunk_size / 1_048_576
    ));

    // 1-2 · read every chunk on disk and compare with the list
    let mut bad = Vec::new();
    {
        let mut f = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(target).map_err(|e| format!("lecture: {e}"))?;
        let on_disk = f.metadata().map_err(|e| e.to_string())?.len();
        if on_disk != manifest.size {
            run.log(format!("taille {on_disk} o ≠ {} o attendus · ajustée", manifest.size));
            f.set_len(manifest.size).map_err(|e| e.to_string())?;
        }
        let mut buf = vec![0u8; manifest.chunk_size as usize];
        for i in 0..n {
            if ctl.cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            let (start, end) = run.bounds(i);
            let len = (end - start + 1) as usize;
            f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
            f.read_exact(&mut buf[..len]).map_err(|e| e.to_string())?;
            let ok = match manifest.chunks.get(i) {
                Some(want_c) => {
                    let have = sha_hex(&buf[..len]);
                    if &have != want_c {
                        let missing = start >= on_disk;
                        run.log(if missing {
                            format!("morceau {i} · MANQUANT")
                        } else {
                            format!("morceau {i} · sha-256 attendu {}… · lu {}… · ABÎMÉ", &want_c[..8], &have[..8])
                        });
                    }
                    &have == want_c
                }
                None => true,
            };
            run.states.lock().unwrap_or_else(|e| e.into_inner())[i] = if ok { DONE } else { BAD };
            if ok {
                run.done_bytes.fetch_add(len as u64, Ordering::Relaxed);
            } else {
                bad.push(i);
            }
            if i % 16 == 0 {
                run.emit(0, 0, None);
            }
        }
    }
    run.set_phase("fetch");
    run.log(format!("{} morceau(x) à retélécharger", bad.len()));
    run.emit(0, 0, None);

    // 3 · re-fetch only the bad chunks, in place
    if !bad.is_empty() {
        let complete = run.fetch_chunks(target, bad.clone(), None)?;
        if !complete {
            run.set_phase(if ctl.cancel.load(Ordering::Relaxed) { "cancelled" } else { "paused" });
            run.emit(0, 0, None);
            return Ok(());
        }
        for i in &bad {
            run.log(format!("morceau {i} · retéléchargé · ✓"));
        }
    }

    // 4 · the on-chain check
    run.set_phase("final");
    run.emit(0, 0, None);
    let have = file_sha(target)?;
    if have != want {
        return Err(format!("empreinte finale {}… ≠ contrat {}… : retéléchargez le jeu", &have[..12], &want[..12]));
    }
    let _ = std::fs::write(local_manifest_of(target), serde_json::to_string(&chunk_list(target, manifest.chunk_size)?).unwrap_or_default());
    run.log(format!("empreinte finale {}… · conforme au contrat ✓", &have[..12]));
    run.set_phase("done");
    run.emit(0, 0, None);
    Ok(())
}

/// The launcher's disposable files: interrupted downloads (.part + state),
/// chunk lists (re-fetched at the next repair), leftovers of native runs,
/// service logs. An installed build.enc is never one of them.
fn cache_files(dirs: &[String], extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            if !e.path().join("gamevault.json").is_file() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(e.path()) else { continue };
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                if name.ends_with(".enc.part") || name.ends_with(".enc.dl.json") || name.ends_with(".enc.manifest.json") {
                    out.push(f.path());
                }
            }
        }
    }
    for root in extra {
        let mut stack = vec![root.clone()];
        while let Some(d) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                if e.path().is_dir() {
                    stack.push(e.path());
                } else {
                    out.push(e.path());
                }
            }
        }
    }
    out
}

#[derive(Serialize)]
pub struct CacheReport {
    pub bytes: u64,
    pub files: u32,
}

pub fn cache_report(dirs: &[String], extra: &[PathBuf]) -> CacheReport {
    let files = cache_files(dirs, extra);
    CacheReport { bytes: files.iter().filter_map(|f| std::fs::metadata(f).ok()).map(|m| m.len()).sum(), files: files.len() as u32 }
}

/// Delete the disposable files; a file in use (a running service's log) is
/// skipped. Returns what was actually freed.
pub fn clear_cache(dirs: &[String], extra: &[PathBuf]) -> CacheReport {
    let mut freed = CacheReport { bytes: 0, files: 0 };
    for f in cache_files(dirs, extra) {
        let len = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&f).is_ok() {
            freed.bytes += len;
            freed.files += 1;
        }
    }
    freed
}

#[derive(Serialize)]
pub struct LibraryEntry {
    pub dir: String,
    pub cid: String,
    pub path: String,
    pub size: u64,
    /// "installed" | "partial"
    pub status: String,
}

/// What each library folder holds: installed builds and resumable parts.
pub fn scan_library(dirs: &[String]) -> Vec<LibraryEntry> {
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let Some(cid) = std::fs::read_to_string(e.path().join("gamevault.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v["cid"].as_str().map(str::to_string))
                .filter(|c| cid_ok(c))
            else {
                continue;
            };
            let build = e.path().join("build.enc");
            let (path, status) = if build.is_file() {
                (build, "installed")
            } else if part_of(&build).is_file() {
                (part_of(&build), "partial")
            } else {
                continue;
            };
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            out.push(LibraryEntry { dir: dir.clone(), cid, path: path.to_string_lossy().into_owned(), size, status: status.into() });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_target_builds_the_path_itself() {
        let dir = std::env::temp_dir();
        let cid = "QmRGYZtATbsDrNv6Fk7L2BrMfk1517XGHMpmJxsoaPeZvr";
        let t = library_target(&dir.to_string_lossy(), cid, "GameVault Runner").unwrap();
        assert!(t.ends_with(Path::new("GameVault Runner (QmRGYZtA)/build.enc")));
        // a hostile title cannot climb out of the library
        let t2 = library_target(&dir.to_string_lossy(), cid, "..\\..\\Windows/System32").unwrap();
        assert!(t2.starts_with(&dir) && t2.parent().unwrap().parent().unwrap() == dir.as_path());
        assert!(library_target(&dir.to_string_lossy(), "../../etc", "x").is_err());
        assert!(library_target("relative/dir", cid, "x").is_err());
        assert!(create_library(&dir.join("NotGameVault").to_string_lossy()).is_err());
    }

    /// Live: needs ticketd on 127.0.0.1:8787 with the Runner build.
    /// cargo test -- --ignored download_repair_live
    #[test]
    #[ignore]
    fn download_repair_live() {
        const CID: &str = "QmRGYZtATbsDrNv6Fk7L2BrMfk1517XGHMpmJxsoaPeZvr";
        const SHA: &str = "89e2cc9ff4cdc74192134969b8e395c0b70b986449c73978081b82d26ce0af4e";
        let events: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::default();
        let ev = Arc::clone(&events);
        let sink: Sink = Arc::new(move |e, v| ev.lock().unwrap().push((e.to_string(), v)));
        let dir = std::env::temp_dir().join(format!("gv-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = library_target(&dir.to_string_lossy(), CID, "GameVault Runner").unwrap();
        mark_game_folder(&target, CID, "GameVault Runner", "2").unwrap();

        // 1 · fresh download, verified against the on-chain sha256
        run_download(&sink, CID, CID, SHA, &target, Arc::new(Ctl::default())).expect("download");
        assert_eq!(file_sha(&target).unwrap(), SHA);
        assert!(local_manifest_of(&target).is_file(), "chunk list kept for offline repairs");
        assert!(events.lock().unwrap().iter().any(|(e, v)| e == "dl-progress" && v["phase"] == "done"));

        // 2 · damage the file (flip bytes + truncate), then repair
        let mut bytes = std::fs::read(&target).unwrap();
        bytes[1000] ^= 0xff;
        bytes.truncate(bytes.len() - 5000);
        std::fs::write(&target, &bytes).unwrap();
        events.lock().unwrap().clear();
        run_repair(&sink, CID, CID, SHA, &target, Arc::new(Ctl::default())).expect("repair");
        assert_eq!(file_sha(&target).unwrap(), SHA, "repaired back to the on-chain fingerprint");
        let logs: Vec<String> = events.lock().unwrap().iter().filter(|(e, _)| e == "dl-log").map(|(_, v)| v["line"].to_string()).collect();
        assert!(logs.iter().any(|l| l.contains("ABÎMÉ") || l.contains("MANQUANT") || l.contains("taille")), "{logs:?}");

        // 3 · a pause mid-way leaves a resumable part; resuming finishes it
        let _ = std::fs::remove_file(&target);
        let ctl = Arc::new(Ctl::default());
        ctl.pause.store(true, Ordering::Relaxed);
        run_download(&sink, CID, CID, SHA, &target, ctl).expect("paused run");
        assert!(part_of(&target).is_file() && state_of(&target).is_file(), "resumable state on disk");
        run_download(&sink, CID, CID, SHA, &target, Arc::new(Ctl::default())).expect("resume");
        assert_eq!(file_sha(&target).unwrap(), SHA);
        // the library scan finds it by its gamevault.json
        let found = scan_library(&[dir.to_string_lossy().into_owned()]);
        assert!(found.iter().any(|e| e.cid == CID && e.status == "installed"), "scan");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn clear_cache_never_touches_an_installed_game() {
        let lib = std::env::temp_dir().join(format!("gv-cache-{}", std::process::id()));
        let game = lib.join("Runner (QmRGYZtA)");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("gamevault.json"), "{}").unwrap();
        std::fs::write(game.join("build.enc"), vec![1u8; 1000]).unwrap();
        std::fs::write(game.join("build.enc.part"), vec![2u8; 300]).unwrap();
        std::fs::write(game.join("build.enc.manifest.json"), "{}").unwrap();
        let dirs = vec![lib.to_string_lossy().into_owned()];
        let r = cache_report(&dirs, &[]);
        assert_eq!((r.files, r.bytes), (2, 302));
        let freed = clear_cache(&dirs, &[]);
        assert_eq!(freed.files, 2);
        assert!(game.join("build.enc").is_file(), "the installed game stays");
        assert!(game.join("gamevault.json").is_file());
        assert_eq!(cache_report(&dirs, &[]).files, 0);
        let _ = std::fs::remove_dir_all(lib);
    }

    #[test]
    fn throttle_holds_the_rate() {
        set_limit(200_000); // 200 kB/s
        let ctl = Ctl::default();
        let t0 = Instant::now();
        for _ in 0..10 {
            throttle(64 * 1024, &ctl); // 640 kB in total
        }
        let secs = t0.elapsed().as_secs_f64();
        set_limit(0);
        // the first second is pre-filled: ~440 kB must wait ≈ 2.2 s
        assert!(secs > 1.6 && secs < 3.5, "{secs}");
        let t1 = Instant::now();
        throttle(10_000_000, &ctl);
        assert!(t1.elapsed().as_millis() < 50, "unlimited never waits");
    }

    #[test]
    fn chunk_list_matches_sha_of_each_slice() {
        let p = std::env::temp_dir().join(format!("gv-chunks-{}.bin", std::process::id()));
        let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&p, &data).unwrap();
        let m = chunk_list(&p, 4096).unwrap();
        assert_eq!(m.size, 10_000);
        assert_eq!(m.chunks.len(), 3);
        assert_eq!(m.chunks[2], sha_hex(&data[8192..]));
        let _ = std::fs::remove_file(p);
    }
}
