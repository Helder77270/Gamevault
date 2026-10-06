// AURA-64 shell — UI implemented from "Aura64 Launcher.dc.html" (Claude
// Design). Screens: boot -> home -> shelf -> detail -> insert -> error.
// All security/market logic is unchanged underneath.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import QRCode from "qrcode";
import { createPublicClient, http } from "viem";
import { verifyTicket, isExpired, unhex, type SignedTicket } from "@gamevault/shared";
import { fetchOnchainCatalog, BLURBS, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { DEPLOYMENTS, CHAIN } from "@gamevault/shared/deployments";
import { fetchBuild } from "@gamevault/shared/storage";
import { LICENSE_ABI, MARKETPLACE_ABI } from "@gamevault/shared/abi";

const MARKETPLACE_URL = "http://localhost:3000";
const TICKETD_URL = "http://localhost:8787";
const GAME_URL = navigator.userAgent.includes("Windows") ? "http://game.localhost/" : "game://localhost/";

// Platform public keys embedded in the launcher (real key + dev fixture key)
const PLATFORM_PUBS = [
  unhex("0x0314864d3e6672b07e9a046c044f329cc38c7ad7c3af7075b4d54e273bddbc1149"),
  unhex("0x038d78e7c9ea67e401f6e9dbf8fccae4563dc21c0e3f569338012ba95c50700f2b"),
];
const verifyPlatformSig = (t: SignedTicket): boolean => PLATFORM_PUBS.some((k) => verifyTicket(t, k));

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

interface Cartridge {
  mount_point: string;
  volume_label: string;
  ticket_json: string;
  meta_json: string | null;
  has_build: boolean;
}
interface Volume {
  mount_point: string;
  volume_label: string;
  has_gamevault: boolean;
}
type Verdict = "authentic" | "tampered" | "expired" | "unreadable" | "unpaired";
interface Game {
  cartridge: Cartridge;
  ticket: SignedTicket | null;
  meta: { title?: string; studio?: string; edition?: string };
  verdict: Verdict;
}
interface Pairing {
  nonce: string;
  url: string;
  qrDataUrl: string;
  status: "waiting" | "error";
  error?: string;
}

type Screen = "boot" | "home" | "shelf" | "detail" | "insert" | "error";

interface BootLine {
  label: string;
  value: string;
  state: "idle" | "done" | "fail";
}

const state = {
  screen: "boot" as Screen,
  bootLines: [] as BootLine[],
  bootPct: 0,
  games: [] as Game[],
  session: null as { address: string } | null,
  devicePubKey: "",
  pairing: null as Pairing | null,
  lastScan: "",
  ownerCheck: "",
  playing: null as Game | null,
  /** native (.exe) game process currently running beside the launcher */
  // g is null after a webview reload mid-game (resynced from native_status)
  nativeRun: null as { g: Game | null; pid: number; startedAt: number } | null,
  dlStatus: {} as Record<string, string>,
  market: {} as Record<string, { owner: string; seller: string; price: bigint }>,
  selling: null as string | null,
  installing: null as { edition: OnchainEdition; volumes: Volume[]; status: string; tokenId: string; stage: number } | null,
  catalog: [] as OnchainEdition[],
  owned: [] as { tokenId: string; editionId: string }[],
  ticketdOk: false,
  /** selected editionId for detail/insert screens */
  sel: null as string | null,
  filter: "all" as "all" | "play",
  fatal: null as { title: string; msg: string; code: string; back: Screen } | null,
};

function libraryAddress(): string {
  return state.session?.address ?? localStorage.getItem("gv-watch") ?? "";
}

// ── Play history (local — no on-chain playtime exists) ────────

interface PlayLogEntry {
  lastPlayedAt: number;
  playCount: number;
  totalSeconds: number;
}

function readLog(): Record<string, PlayLogEntry> {
  try {
    return JSON.parse(localStorage.getItem("gv-playlog") ?? "{}");
  } catch {
    return {};
  }
}
const writeLog = (l: Record<string, PlayLogEntry>): void => localStorage.setItem("gv-playlog", JSON.stringify(l));

let sessionEdition = "";
let sessionStart = 0;

function logPlayStart(editionId: string): void {
  if (!editionId) return;
  const log = readLog();
  const e = log[editionId] ?? { lastPlayedAt: 0, playCount: 0, totalSeconds: 0 };
  e.playCount++;
  e.lastPlayedAt = Date.now();
  log[editionId] = e;
  writeLog(log);
  sessionEdition = editionId;
  sessionStart = Date.now();
}

function logPlayEnd(): void {
  if (!sessionEdition) return;
  const log = readLog();
  const e = log[sessionEdition];
  if (e) {
    e.totalSeconds += Math.round((Date.now() - sessionStart) / 1000);
    writeLog(log);
  }
  sessionEdition = "";
}

function recentPlays(): { e: OnchainEdition; log: PlayLogEntry }[] {
  const log = readLog();
  return Object.entries(log)
    .map(([id, entry]) => ({ e: state.catalog.find((c) => c.editionId === id), log: entry }))
    .filter((x): x is { e: OnchainEdition; log: PlayLogEntry } => Boolean(x.e))
    .sort((a, b) => b.log.lastPlayedAt - a.log.lastPlayedAt)
    .slice(0, 3);
}

function fmtDur(s: number): string {
  if (s < 60) return "< 1 MIN";
  if (s < 3600) return `${Math.round(s / 60)} MIN`;
  return `${Math.floor(s / 3600)} H ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`;
}

function fmtAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "À L'INSTANT";
  if (d < 3_600_000) return `IL Y A ${Math.round(d / 60_000)} MIN`;
  if (d < 86_400_000) return `IL Y A ${Math.round(d / 3_600_000)} H`;
  return `IL Y A ${Math.round(d / 86_400_000)} J`;
}

// ── Verification ──────────────────────────────────────────────

function judge(c: Cartridge): Game {
  let meta: Game["meta"] = {};
  try {
    meta = c.meta_json ? JSON.parse(c.meta_json) : {};
  } catch {
    /* meta is cosmetic */
  }
  let ticket: SignedTicket | null = null;
  try {
    ticket = JSON.parse(c.ticket_json) as SignedTicket;
  } catch {
    return { cartridge: c, ticket: null, meta, verdict: "unreadable" };
  }
  if (ticket.platformSignature === "0x") return { cartridge: c, ticket, meta, verdict: "unpaired" };
  if (!verifyPlatformSig(ticket)) return { cartridge: c, ticket, meta, verdict: "tampered" };
  if (isExpired(ticket)) return { cartridge: c, ticket, meta, verdict: "expired" };
  return { cartridge: c, ticket, meta, verdict: "authentic" };
}

const isOurs = (g: Game): boolean =>
  Boolean(g.ticket && state.devicePubKey && g.ticket.devicePubKey.toLowerCase() === state.devicePubKey.toLowerCase());

// ── Chain reads ───────────────────────────────────────────────

const chainClient = DEPLOYMENTS.gameLicense
  ? createPublicClient({ transport: http(CHAIN.rpcUrl, { timeout: 2000, retryCount: 0 }) })
  : null;

type OwnerCheck = "ok" | "revoked" | "offline";

async function checkOwnerOnline(t: SignedTicket): Promise<OwnerCheck> {
  if (!chainClient || !DEPLOYMENTS.gameLicense) return "offline";
  try {
    const owner = await chainClient.readContract({
      address: DEPLOYMENTS.gameLicense,
      abi: LICENSE_ABI,
      functionName: "ownerOf",
      args: [BigInt(t.tokenId)],
    });
    return owner.toLowerCase() === t.ownerAddress.toLowerCase() ? "ok" : "revoked";
  } catch {
    return "offline";
  }
}

async function fetchMarketState(): Promise<void> {
  if (!chainClient || !DEPLOYMENTS.gameLicense || !DEPLOYMENTS.marketplace) return;
  for (const g of state.games) {
    if (!g.ticket) continue;
    const id = BigInt(g.ticket.tokenId);
    try {
      const [owner, listing] = await Promise.all([
        chainClient.readContract({ address: DEPLOYMENTS.gameLicense, abi: LICENSE_ABI, functionName: "ownerOf", args: [id] }),
        chainClient.readContract({ address: DEPLOYMENTS.marketplace, abi: MARKETPLACE_ABI, functionName: "listings", args: [id] }),
      ]);
      state.market[g.ticket.tokenId] = { owner, seller: listing[0], price: listing[1] };
    } catch {
      /* offline or unknown token */
    }
  }
}

async function fetchOwned(): Promise<void> {
  const addr = libraryAddress();
  if (!chainClient || !DEPLOYMENTS.gameLicense || !addr) {
    state.owned = [];
    return;
  }
  try {
    const next = await chainClient.readContract({
      address: DEPLOYMENTS.gameLicense,
      abi: LICENSE_ABI,
      functionName: "nextTokenId",
      args: [],
    });
    const owned: { tokenId: string; editionId: string }[] = [];
    for (let i = 1n; i <= next; i++) {
      try {
        const o = await chainClient.readContract({ address: DEPLOYMENTS.gameLicense, abi: LICENSE_ABI, functionName: "ownerOf", args: [i] });
        if (o.toLowerCase() === addr.toLowerCase()) {
          const ed = await chainClient.readContract({ address: DEPLOYMENTS.gameLicense, abi: LICENSE_ABI, functionName: "editionOf", args: [i] });
          owned.push({ tokenId: i.toString(), editionId: ed.toString() });
        }
      } catch {
        /* skip */
      }
    }
    state.owned = owned;
  } catch {
    /* offline */
  }
}

// ── Pairing (QR -> SIWE -> ticketd -> card) ───────────────────

function loadSession(): void {
  const raw = localStorage.getItem("gv-session");
  state.session = raw ? JSON.parse(raw) : null;
}

let pollTimer: number | undefined;

async function startPairing(g: Game): Promise<void> {
  if (!g.ticket) return;
  const nonce = crypto.randomUUID();
  const url =
    `${MARKETPLACE_URL}/pair?device=${encodeURIComponent(state.devicePubKey)}` +
    `&nonce=${nonce}&token=${encodeURIComponent(g.ticket.tokenId)}&contract=${encodeURIComponent(g.ticket.contract)}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 200, margin: 2 });
  state.pairing = { nonce, url, qrDataUrl, status: "waiting" };
  state.screen = "insert";
  render();

  const startedAt = Date.now();
  pollTimer = window.setInterval(async () => {
    if (!state.pairing) return stopPolling();
    if (Date.now() - startedAt > 10 * 60 * 1000) {
      stopPolling();
      state.pairing = null;
      fail("Pairing timed out", "L'appairage a expiré — relancez depuis la fiche du jeu.", "ERR 0x31 · PAIRING TIMEOUT", "detail");
      return;
    }
    try {
      const res = await fetch(`${TICKETD_URL}/pending/${state.pairing.nonce}`);
      if (!res.ok) return;
      const ticket = (await res.json()) as SignedTicket;
      await completePairing(g, ticket);
    } catch {
      /* ticketd briefly unreachable */
    }
  }, 1500);
}

function stopPolling(): void {
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
  pollTimer = undefined;
}

async function completePairing(g: Game, ticket: SignedTicket): Promise<void> {
  stopPolling();
  if (!verifyPlatformSig(ticket) || ticket.devicePubKey.toLowerCase() !== state.devicePubKey.toLowerCase()) {
    state.pairing = null;
    fail(
      "This card won't read.",
      "Le ticket reçu est invalide ou scellé pour un autre appareil.",
      "ERR 0x21 · LICENCE CHECKSUM MISMATCH · SLOT A",
      "detail",
    );
    return;
  }
  await invoke("write_ticket", { mountPoint: g.cartridge.mount_point, ticketJson: JSON.stringify(ticket, null, 2) });
  state.session = { address: ticket.ownerAddress };
  localStorage.setItem("gv-session", JSON.stringify(state.session));
  state.pairing = null;
  state.screen = "detail";
  await refresh();
}

function cancelPairing(): void {
  stopPolling();
  state.pairing = null;
  state.screen = "detail";
  render();
}

// ── Verified re-download / install-to-card ────────────────────

function editionFor(g: Game): OnchainEdition | undefined {
  return (
    state.catalog.find((e) => e.editionId === g.meta.edition) ??
    state.catalog.find((e) => e.title === (g.meta.title ?? ""))
  );
}

async function downloadBuild(g: Game): Promise<void> {
  const ed = editionFor(g);
  if (!ed?.buildCid) return;
  const mount = g.cartridge.mount_point;
  state.dlStatus[mount] = "FETCH + VERIFY…";
  render();
  try {
    const bytes = await fetchBuild(ed.buildCid, ed.buildSha256);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await invoke("write_build", { mountPoint: mount, dataB64: btoa(bin) });
    delete state.dlStatus[mount];
  } catch (e) {
    state.dlStatus[mount] = `ÉCHEC : ${String(e)}`;
  }
  await refresh();
}

async function openInstall(edition: OnchainEdition, prefillTokenId = ""): Promise<void> {
  const volumes = await invoke<Volume[]>("list_removable_volumes");
  state.installing = { edition, volumes, status: "", tokenId: prefillTokenId, stage: 0 };
  state.sel = edition.editionId;
  state.screen = "insert";
  render();
}

async function installTo(volume: Volume): Promise<void> {
  const inst = state.installing;
  if (!inst?.edition.buildCid) return;
  const tokenId = (document.getElementById("install-token") as HTMLInputElement | null)?.value.trim() ?? inst.tokenId;
  inst.tokenId = tokenId;
  if (!/^\d+$/.test(tokenId)) {
    inst.status = "Indiquez le n° de votre licence (affiché à l'achat).";
    return render();
  }
  if (chainClient && DEPLOYMENTS.gameLicense) {
    try {
      const ed = await chainClient.readContract({
        address: DEPLOYMENTS.gameLicense,
        abi: LICENSE_ABI,
        functionName: "editionOf",
        args: [BigInt(tokenId)],
      });
      if (ed.toString() !== inst.edition.editionId) {
        const other = state.catalog.find((c) => c.editionId === ed.toString());
        inst.status = `⛔ Le token #${tokenId} est une licence de l'édition #${ed}${other ? ` (« ${other.title} »)` : ""}, pas de « ${inst.edition.title} ».`;
        return render();
      }
    } catch {
      inst.status = `⛔ Token #${tokenId} introuvable on-chain — achetez d'abord la licence.`;
      return render();
    }
  }
  inst.stage = 1;
  inst.status = "";
  render();
  try {
    const bytes = await fetchBuild(inst.edition.buildCid, inst.edition.buildSha256);
    inst.stage = 2;
    render();
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const meta = { title: inst.edition.title, studio: inst.edition.studio, edition: inst.edition.editionId, version: "0.1.0" };
    const placeholder = {
      tokenId,
      contract: DEPLOYMENTS.gameLicense || "0x0000000000000000000000000000000000000001",
      chainId: CHAIN.id,
      ownerAddress: ZERO_ADDR,
      devicePubKey: "0x",
      wrappedContentKey: "0x",
      issuedAt: 0,
      expiresAt: 0,
      platformSignature: "0x",
    };
    await invoke("install_cartridge", {
      mountPoint: volume.mount_point,
      metaJson: JSON.stringify(meta, null, 2),
      ticketJson: JSON.stringify(placeholder, null, 2),
      dataB64: btoa(bin),
    });
    inst.stage = 3;
    render();
    await refresh();
    // Card is written — flow continues on the same screen with pairing
    const g = state.games.find((x) => x.ticket?.tokenId === tokenId);
    state.installing = null;
    if (g && !isOurs(g)) void startPairing(g);
    else render();
  } catch (e) {
    state.installing = null;
    fail("This card won't write.", String(e), "ERR 0x42 · CARD WRITE FAILED", "detail");
  }
}

// ── Market ────────────────────────────────────────────────────

function tradeUrl(action: "list" | "unlist" | "buy", tokenId: string, priceEth?: string): string {
  const p = priceEth ? `&price=${encodeURIComponent(priceEth)}` : "";
  return `${MARKETPLACE_URL}/trade?action=${action}&token=${encodeURIComponent(tokenId)}${p}`;
}

function formatEth(wei: bigint): string {
  const s = (Number(wei) / 1e18).toString();
  return s.length > 10 ? s.slice(0, 10) : s;
}

// ── Play (with launch cinematic) ──────────────────────────────
// The overlay lives in #overlay-layer, outside the diff-rendered #screen —
// stages are pure class toggles on live nodes, immune to re-renders.

let launching = false;

const minMs = async <T,>(p: Promise<T>, ms: number): Promise<T> =>
  (await Promise.all([p, new Promise((r) => setTimeout(r, ms))]))[0] as T;

function launchShow(g: Game): void {
  const layer = document.getElementById("overlay-layer");
  if (!layer) return;
  const ed = editionFor(g);
  const hue = hueOf(ed?.editionId ?? "1");
  const el = document.createElement("div");
  el.id = "launch-ov";
  el.className = "launch-ov";
  el.innerHTML = `
    <div class="lv-art" style="${artGrad(hue)}"><div class="sheen"></div></div>
    <div class="lv-title">${esc(g.meta.title ?? ed?.title ?? "GAME")}</div>
    <div class="lv-sub">LICENCE #${esc(g.ticket?.tokenId ?? "?")} · SLOT A</div>
    <div class="steps lv-steps">
      <div class="step run" id="lstep-0"><div class="sdot"></div><div class="slabel">VERIFY LICENCE · ON-CHAIN</div><div class="sstate">…</div></div>
      <div class="step" id="lstep-1"><div class="sdot"></div><div class="slabel">UNSEAL KEY · DECRYPT IN MEMORY</div><div class="sstate">—</div></div>
      <div class="step" id="lstep-2"><div class="sdot"></div><div class="slabel">BOOT TITLE</div><div class="sstate">—</div></div>
    </div>`;
  layer.appendChild(el);
}

function launchStage(i: number, note = "OK"): void {
  const prev = document.getElementById(`lstep-${i - 1}`);
  if (prev) {
    prev.className = "step ok";
    (prev.querySelector(".sstate") as HTMLElement | null)!.textContent = note;
  }
  const cur = document.getElementById(`lstep-${i}`);
  if (cur) {
    cur.className = "step run";
    (cur.querySelector(".sstate") as HTMLElement | null)!.textContent = "…";
  }
}

function launchHide(): void {
  const el = document.getElementById("launch-ov");
  if (!el) return;
  el.classList.add("bye");
  setTimeout(() => el.remove(), 450);
}

async function play(g: Game): Promise<void> {
  if (launching || state.playing || state.nativeRun) return;
  launching = true;
  launchShow(g);
  try {
    if (g.ticket) {
      const check = await minMs(checkOwnerOnline(g.ticket), 800);
      if (check === "revoked") {
        state.ownerCheck = "REVOKED";
        launchHide();
        fail(
          "Licence moved on-chain.",
          "Cette licence a changé de propriétaire. Le nouveau propriétaire doit appairer sa machine pour jouer.",
          "ERR 0x51 · OWNERSHIP MOVED ON-CHAIN",
          "detail",
        );
        return;
      }
      state.ownerCheck = check === "ok" ? "OWNER ✔ LIVE" : "OFFLINE · 30D WINDOW";
      launchStage(1, state.ownerCheck);
    } else {
      launchStage(1);
    }
    let launched: { kind: string; pid?: number };
    try {
      launched = await minMs(
        invoke<{ kind: string; pid?: number }>("play_game", { mountPoint: g.cartridge.mount_point }),
        900,
      );
    } catch (e) {
      const msg = String(e);
      launchHide();
      fail(
        "This card won't read.",
        msg.includes("clé d'appareil") || msg.includes("authentication")
          ? "Le bloc licence est revenu brouillé — le ticket n'est pas scellé pour cette machine, ou le build est corrompu. Re-téléchargez le build ou ré-appairez, puis réessayez."
          : msg,
        `ERR 0x21 · ${msg.slice(0, 60)}`,
        "detail",
      );
      return;
    }
    launchStage(2, launched.kind === "exe" ? `SPAWNED · PID ${launched.pid}` : "DECRYPTED");
    chimeLaunch();
    logPlayStart(editionFor(g)?.editionId ?? g.meta.edition ?? "");
    await new Promise((r) => setTimeout(r, 700));
    if (launched.kind === "exe") {
      state.nativeRun = { g, pid: launched.pid ?? 0, startedAt: Date.now() };
      startNativeWatchdog();
    } else {
      state.playing = g;
    }
    render(); // player view / native panel mounts underneath the overlay
    launchHide(); // then the overlay fades to reveal it
  } finally {
    launching = false;
  }
}

// ── Native process: resale watchdog + exit listener ──────────
// Decision 2026-10-05: on resale detected mid-session, the process is
// TERMINATED (not just notified) — live revocation at full strength.

const NATIVE_OWNER_CHECK_MS = 60_000;
let nativeWatchdog: number | undefined;

function startNativeWatchdog(): void {
  stopNativeWatchdog();
  nativeWatchdog = window.setInterval(async () => {
    const t = state.nativeRun?.g?.ticket;
    if (!t) return;
    if ((await checkOwnerOnline(t)) === "revoked") {
      stopNativeWatchdog();
      await invoke("stop_game"); // kills the child, cleans the run dir
      state.nativeRun = null;
      fail(
        "Licence moved on-chain.",
        "La licence a été revendue pendant la partie — le processus a été terminé. Le nouveau propriétaire doit appairer sa machine.",
        "ERR 0x52 · RESOLD MID-SESSION · PROCESS TERMINATED",
        "detail",
      );
    }
  }, NATIVE_OWNER_CHECK_MS);
}

function stopNativeWatchdog(): void {
  if (nativeWatchdog !== undefined) window.clearInterval(nativeWatchdog);
  nativeWatchdog = undefined;
}

void listen<{ code: number | null; seconds: number; killed: boolean }>("native-exited", (e) => {
  stopNativeWatchdog();
  logPlayEnd();
  const wasRunning = state.nativeRun !== null;
  state.nativeRun = null;
  if (wasRunning && !e.payload.killed) chimeOut(); // natural exit (window closed)
  if (state.screen !== "error") render();
});

function nativeView(run: NonNullable<typeof state.nativeRun>): string {
  const ed = run.g ? editionFor(run.g) : undefined;
  const guard = run.g?.ticket
    ? "OWNERSHIP RE-CHECKED EVERY 60 S · RESALE TERMINATES THE PROCESS"
    : "SESSION RESYNCED · TICKET UNKNOWN — EJECT TO REARM THE GUARD";
  return `
    <div class="launch-ov" style="animation:none">
      <div class="lv-art" style="${artGrad(hueOf(ed?.editionId ?? "1"))}"><div class="sheen"></div></div>
      <div class="lv-title">${esc(run.g?.meta.title ?? ed?.title ?? "NATIVE GAME")}</div>
      <div class="lv-sub">NATIVE PROCESS · PID ${run.pid} · <span data-elapsed data-ts="${run.startedAt}">00:00</span></div>
      <div class="lv-sub" style="margin-top:4px">${guard}</div>
      <button class="pillbtn dashed" id="quit-btn" style="margin-top:18px">✕ EJECT · TERMINATE</button>
    </div>`;
}

async function quit(): Promise<void> {
  stopNativeWatchdog();
  await invoke("stop_game"); // drops the HTML bundle AND/OR kills the native child
  logPlayEnd();
  state.playing = null;
  state.nativeRun = null;
  render();
}

// ── Retro SFX (WebAudio, zero assets) ─────────────────────────

let audio: AudioContext | null = null;

function beep(freqs: number[], dur = 0.09, vol = 0.16): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    freqs.forEach((f, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const t0 = audio!.currentTime + i * dur;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(audio!.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    });
  } catch {
    /* autoplay policy before first gesture — stay silent */
  }
}

const chimeIn = (): void => beep([880, 1318]);
const chimeOut = (): void => beep([660, 440]);
const chimeLaunch = (): void => beep([523, 659, 880], 0.12);

// ── Card insert/eject events (overlay layer, outside diff-render) ──

let slotEvent: { kind: "in" | "out"; until: number } | null = null;

function cardToast(kind: "in" | "out", title: string): void {
  const layer = document.getElementById("overlay-layer");
  if (!layer) return;
  const el = document.createElement("div");
  el.className = `card-toast ${kind}`;
  el.innerHTML = `
    <div class="ct-reader"><div class="ct-card"></div><div class="ct-slot"></div></div>
    <div class="ct-label">CARD ${kind === "in" ? "INSERTED" : "EJECTED"}<br><b>${esc(title.toUpperCase())}</b></div>`;
  layer.appendChild(el);
  (kind === "in" ? chimeIn : chimeOut)();
  slotEvent = { kind, until: Date.now() + 3000 };
  setTimeout(() => el.classList.add("bye"), 2400);
  setTimeout(() => el.remove(), 3000);
}

// ── Helpers ───────────────────────────────────────────────────

const short = (h: string, n = 8): string => (h.length <= 2 * n ? h : `${h.slice(0, n)}…${h.slice(-4)}`);
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hueOf = (editionId: string): number => (Number(editionId) * 137) % 360;
const artGrad = (hue: number): string =>
  `background:linear-gradient(160deg, oklch(0.62 0.13 ${hue}) 0%, oklch(0.34 0.1 ${hue + 30}) 65%, oklch(0.22 0.06 265) 100%);`;

function fail(title: string, msg: string, code: string, back: Screen): void {
  state.fatal = { title, msg, code, back };
  state.screen = "error";
  render();
}

function go(screen: Screen): void {
  state.screen = screen;
  render();
}

/** Cartridge matching an edition (by meta.edition, title fallback). */
function cardForEdition(editionId: string): Game | undefined {
  return (
    state.games.find((g) => g.meta.edition === editionId) ??
    state.games.find((g) => g.meta.title === state.catalog.find((e) => e.editionId === editionId)?.title)
  );
}

function playableNow(e: OnchainEdition): boolean {
  const g = cardForEdition(e.editionId);
  return Boolean(g && g.verdict === "authentic" && g.cartridge.has_build && isOurs(g));
}

// ── Screens ───────────────────────────────────────────────────

function bootView(): string {
  return `
    <div class="boot">
      <div class="boot-left">
        <div class="boot-logo"></div>
        <div>
          <div class="boot-title">AURA&#8209;64</div>
          <div class="boot-sub">GAMEVAULT SYSTEM SOFTWARE</div>
        </div>
        <div class="boot-bar"><div style="width:${state.bootPct}%"></div></div>
      </div>
      <div class="boot-right">
        <div class="boot-head">POWER&#8209;ON CHECK</div>
        <div class="boot-lines">
          ${state.bootLines
            .map(
              (l) => `
            <div class="boot-line ${l.state === "idle" ? "" : l.state === "fail" ? "done fail" : "done"}">
              <div class="boot-dot"></div>
              <div class="boot-label">${esc(l.label)}</div>
              <div class="boot-fill"></div>
              <div class="boot-val">${esc(l.value)}</div>
            </div>`,
            )
            .join("")}
        </div>
        <div class="boot-note">Chaque contrôle est réel : keystore, lecteur de cartes, chaîne Base Sepolia, service de tickets.</div>
        <button class="pillbtn" id="skip-boot" style="margin-top:8px">SKIP &#8250;</button>
      </div>
    </div>`;
}

// ── The PS1-style orbital clock (from the design's clockBars/clockBeads):
// 12 faceted bars around the core — the HOUR bar is white and long, the
// 5-minute bar is cyan, the rest dim; 6 beads pulse with the seconds.

const BAR_TILT = [-1.5, 2.5, -3, 1.5, 4, -2, 0.5, 3, -4, 2, -1, 3.5];
const FACE_HOUR =
  "linear-gradient(94deg, rgba(255,255,255,0.98) 0 18%, oklch(0.95 0.03 210) 18% 46%, oklch(0.86 0.07 215) 46% 74%, rgba(255,255,255,0.92) 74% 100%)";
const FACE_MIN =
  "linear-gradient(94deg, rgba(238,250,255,0.95) 0 16%, oklch(0.82 0.11 205) 16% 44%, oklch(0.6 0.13 225) 44% 74%, rgba(224,246,255,0.8) 74% 100%)";
const FACE_DIM =
  "linear-gradient(94deg, rgba(226,248,255,0.9) 0 15%, oklch(0.76 0.12 203) 15% 42%, oklch(0.5 0.13 232) 42% 73%, rgba(206,240,255,0.7) 73% 100%)";
const GLOW_HOUR = "0 0 34px oklch(0.95 0.05 215 / 0.95), 0 0 70px oklch(0.85 0.1 220 / 0.6)";
const GLOW_DIM = "0 0 22px oklch(0.78 0.13 215 / 0.65), 0 0 48px oklch(0.62 0.14 235 / 0.4)";

function barGeometry(i: number, now: Date): { wrap: string; bar: string } {
  const isHour = i === now.getHours() % 12;
  const isMin = i === Math.floor(now.getMinutes() / 5) % 12 && !isHour;
  // Seconds sweep: a brightness highlight orbits the dial every 12s, riding
  // the existing per-second surgical updates + the bars' CSS transition.
  const sweep = i === now.getSeconds() % 12;
  const len = isHour ? 138 : 124;
  const w = isHour ? 26 : 23;
  return {
    wrap: `width:${w}px;height:${len}px;margin-left:${-w / 2}px;margin-top:${-len / 2}px;transform:rotate(${i * 30 + BAR_TILT[i]}deg) translateY(-${isHour ? 196 : 200}px)`,
    bar: `background:${isHour ? FACE_HOUR : isMin ? FACE_MIN : FACE_DIM};box-shadow:${isHour ? GLOW_HOUR : GLOW_DIM};opacity:${isHour ? 1 : isMin ? 0.95 : 0.8};filter:brightness(${sweep ? 1.6 : 1})`,
  };
}

function homeBg(): string {
  const now = new Date();
  const bars = BAR_TILT.map((_, i) => {
    const g = barGeometry(i, now);
    return `<div class="orb-barwrap" data-i="${i}" style="${g.wrap}"><div class="orb-bar" style="${g.bar}"></div></div>`;
  }).join("");
  const beads = [0, 1, 2, 3, 4, 5]
    .map((i) => {
      const rad = ((150 + i * 26) * Math.PI) / 180;
      const on = (now.getSeconds() + i) % 6 < 4;
      return `<div class="orb-bead" data-i="${i}" style="transform:translate(${(Math.cos(rad) * 62).toFixed(1)}px,${(Math.sin(rad) * 62).toFixed(1)}px);opacity:${on ? 1 : 0.35}"></div>`;
    })
    .join("");
  return `
    <div class="homebg">
      <div class="orb-wrap">
        <div class="orb-halo"></div>
        <div class="orb-rotor">${bars}</div>
        <div class="orb-core">
          <div class="sphere"></div>
          <div class="orb-gyro"><div class="orb-ring1"></div></div>
          <div class="orb-gyro rev"><div class="orb-ring2"></div></div>
          <div class="orb-spin">${beads}</div>
        </div>
      </div>
      <div class="blob-a"></div><div class="blob-b"></div>
      <div class="homefade-l"></div><div class="homefade-t"></div>
    </div>`;
}

function homeView(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const date = now
    .toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "short" })
    .toUpperCase();
  const addr = libraryAddress();
  const playable = state.catalog.filter(playableNow).length;
  const recents = recentPlays();
  const last = recents[0]?.e;

  const recentRow = recents.length
    ? `<div class="home-recent">
        <div class="mono-label" style="margin-bottom:10px">LAST PLAYED</div>
        <div class="recent-tiles">
          ${recents
            .map(
              (r) => `
            <button class="recent-tile" data-edition="${esc(r.e.editionId)}">
              <div class="rart" style="${artGrad(hueOf(r.e.editionId))}"></div>
              <div class="rbody">
                <div class="rtitle">${esc(r.e.title)}</div>
                <div class="rstats">▶ ×${r.log.playCount} · ${fmtDur(r.log.totalSeconds)} ·
                  <span data-ago data-ts="${r.log.lastPlayedAt}">${fmtAgo(r.log.lastPlayedAt)}</span></div>
              </div>
            </button>`,
            )
            .join("")}
        </div>
      </div>`
    : "";

  return `
    ${homeBg()}
    <div class="home">
      <div class="home-top">
        <div>
          <div class="mono-label">WELCOME BACK, ${addr ? `PLAYER ${esc(short(addr, 6).toUpperCase())}` : "PLAYER 01"}</div>
          <div class="big-clock" style="margin-top:14px">
            <div class="big-time" id="home-time-b">${hh}<span class="big-colon">:</span>${mm}</div>
            <div class="big-side">
              <div class="big-sec" id="home-sec">${ss}</div>
              <div class="big-date" id="home-date">${esc(date)}</div>
            </div>
          </div>
        </div>
      </div>
      ${recentRow}
      <div class="home-cards">
        <button class="home-card primary" data-go="shelf">
          <div class="num">01</div>
          <h3>Game Shelf</h3>
          <div class="desc">${playable} of ${state.catalog.length} playable</div>
          <div class="sheen"></div>
        </button>
        <button class="home-card violet" id="home-insert">
          <div class="num">02</div>
          <h3>Insert Card</h3>
          <div class="desc">Unlock a title</div>
        </button>
        <button class="home-card" id="home-continue" ${last ? `data-edition="${esc(last.editionId)}"` : "disabled"}>
          <div class="num">03</div>
          <h3>Continue</h3>
          <div class="desc">${last ? esc(last.title) : "—"}</div>
        </button>
      </div>
    </div>`;
}

function shelfView(): string {
  const addr = libraryAddress();
  const list = state.filter === "play" ? state.catalog.filter(playableNow) : state.catalog;
  const unlocked = state.catalog.filter(playableNow).length;
  return `
    <div class="shelf">
      <div class="shelf-head">
        <div style="display:flex;align-items:center;gap:18px">
          <button class="backbtn" data-go="home">&#8592;</button>
          <div>
            <div class="shelf-title">Game Shelf</div>
            <div class="shelf-meta">${unlocked} PLAYABLE &nbsp;/&nbsp; ${state.catalog.length - unlocked} AWAITING CARD ${state.ownerCheck ? `&nbsp;&#183;&nbsp; ${esc(state.ownerCheck)}` : ""}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="pillbtn ${state.filter === "all" ? "active" : ""}" id="filt-all">ALL</button>
          <button class="pillbtn ${state.filter === "play" ? "active" : ""}" id="filt-play">PLAYABLE</button>
          <button class="pillbtn violet" id="home-insert">+ INSERT CARD</button>
          <button class="pillbtn" id="refresh-btn">🔄</button>
        </div>
      </div>
      ${
        !addr
          ? `<div class="watch-row">
              <span class="slot-dim">VIEW YOUR LICENCES:</span>
              <input class="aura-input" id="watch-addr" placeholder="0x… votre adresse wallet" style="width:24rem" />
              <button class="pillbtn" id="watch-btn">FOLLOW</button>
            </div>`
          : ""
      }
      <div class="shelf-grid-wrap">
        <div class="shelf-grid">
          ${
            list.length
              ? list
                  .map((e) => {
                    const g = cardForEdition(e.editionId);
                    const ownedTok = state.owned.filter((o) => o.editionId === e.editionId);
                    const can = playableNow(e);
                    const status = can
                      ? "READY"
                      : g
                        ? g.verdict === "unpaired" || !isOurs(g)
                          ? "PAIR CARD"
                          : g.verdict === "expired"
                            ? "RENEW"
                            : !g.cartridge.has_build
                              ? "NO BUILD"
                              : "CHECK CARD"
                        : ownedTok.length
                          ? "AWAITING CARD"
                          : `${formatEth(e.priceWei)} ETH`;
                    return `
              <button class="gamecard" data-edition="${esc(e.editionId)}">
                <div class="art ${can || ownedTok.length || g ? "" : "locked"}" style="${artGrad(hueOf(e.editionId))}">
                  <div class="artnote">éd. #${esc(e.editionId)} · ${esc(e.studio)}</div>
                  <div class="lockdot">${can ? "🟢" : ownedTok.length || g ? "🟡" : "🔒"}</div>
                </div>
                <div class="gtitle">${esc(e.title)}</div>
                <div class="gmeta ${can ? "on" : ""}">${esc(status)} &nbsp;&#183;&nbsp; ${e.minted}/${e.supply}</div>
              </button>`;
                  })
                  .join("")
              : `<div class="slot-dim">${DEPLOYMENTS.gameRegistry ? "READING CHAIN…" : "NO CONTRACTS DEPLOYED"}</div>`
          }
        </div>
      </div>
    </div>`;
}

function detailView(): string {
  const e = state.catalog.find((x) => x.editionId === state.sel);
  if (!e) return shelfView();
  const g = cardForEdition(e.editionId);
  const ownedTok = state.owned.filter((o) => o.editionId === e.editionId);
  const can = playableNow(e);
  const m = g?.ticket ? state.market[g.ticket.tokenId] : undefined;
  const resold = Boolean(m && g?.ticket && m.owner.toLowerCase() !== g.ticket.ownerAddress.toLowerCase());
  const listed = Boolean(m && m.seller.toLowerCase() !== ZERO_ADDR);

  let action = "";
  let hint = "";
  if (can && g) {
    action = `<button class="cta" data-play="${esc(g.cartridge.mount_point)}">▶ &nbsp;PLAY</button>`;
    hint = "Déchiffré en mémoire depuis la carte — la clé ne touche jamais le disque.";
  } else if (g && (g.verdict === "unpaired" || !isOurs(g))) {
    action = `<button class="cta violet" data-pair="${esc(g.cartridge.mount_point)}">INSERT · PAIR THIS MACHINE</button>`;
    hint = "Le propriétaire signe une fois — le ticket est scellé pour cette machine.";
  } else if (g && g.verdict === "expired" && isOurs(g)) {
    action = `<button class="cta violet" data-pair="${esc(g.cartridge.mount_point)}">RENEW LICENCE</button>`;
    hint = "Renouvellement en ligne : la propriété est revérifiée on-chain.";
  } else if (g && !g.cartridge.has_build) {
    action = `<button class="cta violet" data-dl="${esc(g.cartridge.mount_point)}">⬇ FETCH BUILD (IPFS)</button>`;
    hint = state.dlStatus[g.cartridge.mount_point] ?? "Build récupéré depuis IPFS, hash vérifié contre le registre.";
  } else if (ownedTok.length) {
    action = `<button class="cta violet" data-install="${esc(e.editionId)}" data-token="${esc(ownedTok[0].tokenId)}">💾 WRITE TO CARD</button>`;
    hint = `Licence #${ownedTok[0].tokenId} possédée — écrivez-la sur une carte SD pour jouer.`;
  } else {
    action = `<button class="cta" id="buy-btn">BUY · ${formatEth(e.priceWei)} ETH ↗</button>`;
    hint = "Le paiement s'ouvre dans le navigateur — là où vit votre wallet.";
  }

  let marketRow = "";
  if (g?.ticket && isOurs(g) && g.verdict === "authentic" && !resold) {
    if (listed && m) {
      marketRow = `<button class="pillbtn" data-unlist="${esc(g.ticket.tokenId)}">🏷 LISTED ${formatEth(m.price)} ETH — UNLIST ↗</button>`;
    } else if (state.selling === g.ticket.tokenId) {
      marketRow = `
        <input class="aura-input" id="sell-price" placeholder="prix ETH" style="width:8rem" />
        <button class="pillbtn violet" data-confirm-sell="${esc(g.ticket.tokenId)}">LIST ↗</button>
        <button class="pillbtn" id="cancel-sell">CANCEL</button>`;
    } else {
      marketRow = `<button class="pillbtn" data-sell="${esc(g.ticket.tokenId)}">💰 SELL</button>`;
    }
  }

  return `
    <div class="detail">
      <div class="detail-left">
        <button class="pillbtn" data-go="shelf" style="align-self:flex-start">&#8592; SHELF</button>
        <div class="hero-art" style="${artGrad(hueOf(e.editionId))}">
          <div class="artnote">box art — éd. #${esc(e.editionId)}</div>
          <div class="sheen"></div>
        </div>
      </div>
      <div class="detail-right">
        <div class="detail-kicker">${esc(e.studio.toUpperCase())} &nbsp;&#183;&nbsp; ROYALTIES ${e.royaltyBps / 100}% &nbsp;&#183;&nbsp; ${e.minted}/${e.supply} MINTED</div>
        <div class="detail-title">${esc(e.title)}</div>
        <div class="detail-blurb">${esc(BLURBS[e.editionId] ?? "Une licence ERC-721 sur cartouche : jouable hors ligne, prêtable, revendable — royalties automatiques au studio.")}</div>
        <div class="stat-row">
          <div class="stat"><div class="k">LICENCE CARD</div><div class="v">${
            g?.ticket ? `#${esc(g.ticket.tokenId)} · ${short(g.ticket.ownerAddress, 6)}` : ownedTok.length ? ownedTok.map((o) => `#${o.tokenId}`).join(" · ") : "—"
          }</div></div>
          <div class="stat"><div class="k">CARTRIDGE</div><div class="v">${g ? `${esc(g.cartridge.mount_point)} · ${g.verdict.toUpperCase()}` : "NOT INSERTED"}</div></div>
          <div class="stat"><div class="k">${g?.ticket && g.verdict === "authentic" ? "EXPIRES" : "BUILD CID"}</div><div class="v">${
            g?.ticket && g.verdict === "authentic" ? new Date(g.ticket.expiresAt * 1000).toLocaleDateString() : short(e.buildCid, 8)
          }</div></div>
        </div>
        ${resold && m ? `<div class="errbox">⛔ RESOLD ON-CHAIN — new owner ${short(m.owner)} must pair their machine.</div>` : ""}
        <div class="debug" style="margin-top:14px">éd. #${esc(e.editionId)} · jeu #${esc(e.gameId)} · studio #${esc(e.studioId)} · chain ${CHAIN.id} · cid ${esc(e.buildCid)}</div>
        <div class="detail-actions">
          ${action}
          <div class="detail-hint">${esc(hint)}</div>
          <div style="flex-basis:100%;display:flex;gap:8px;flex-wrap:wrap">${marketRow}</div>
        </div>
      </div>
    </div>`;
}

function insertView(): string {
  const e = state.catalog.find((x) => x.editionId === state.sel);
  const inst = state.installing;
  const p = state.pairing;
  const g = state.sel ? cardForEdition(state.sel) : state.games.find((x) => x.ticket && !isOurs(x));
  const title = e?.title ?? g?.meta.title ?? "Licence";
  const cardIn = Boolean(g) || (inst?.stage ?? 0) >= 3;

  let headline = "Slot a card to begin.";
  let sub = "Le lecteur détecte la carte, lit son bloc licence et vérifie la signature de la plateforme.";
  let steps: { label: string; st: "idle" | "run" | "ok" | "fail"; note: string }[] = [];
  let extra = "";

  if (inst) {
    headline = inst.stage === 0 ? "Choose a card to write." : "Writing your licence card.";
    sub = "Le build chiffré arrive d'IPFS, vérifié contre le hash publié on-chain, puis gravé sur la carte.";
    steps = [
      { label: "DETECT CARD", st: inst.stage >= 1 ? "ok" : "run", note: inst.stage >= 1 ? "SELECTED" : "CHOOSE BELOW" },
      { label: "FETCH BUILD · IPFS", st: inst.stage === 1 ? "run" : inst.stage > 1 ? "ok" : "idle", note: inst.stage > 1 ? "VERIFIED" : inst.stage === 1 ? "…" : "—" },
      { label: "WRITE CARD", st: inst.stage === 2 ? "run" : inst.stage > 2 ? "ok" : "idle", note: inst.stage > 2 ? "DONE" : inst.stage === 2 ? "…" : "—" },
      { label: "PAIR MACHINE", st: inst.stage >= 3 ? "run" : "idle", note: inst.stage >= 3 ? "NEXT" : "—" },
    ];
    if (inst.stage === 0) {
      extra = `
        <p style="margin-top:18px"><label class="slot-dim">LICENCE #
          <input class="aura-input" id="install-token" inputmode="numeric" placeholder="ex. 2" value="${esc(inst.tokenId)}" style="width:6rem;margin-left:8px" /></label></p>
        <div class="vol-list">
          ${
            inst.volumes.length
              ? inst.volumes
                  .map(
                    (v) => `<button class="pillbtn" data-volume="${esc(v.mount_point)}">💾 ${esc(v.volume_label || "CARD")} — ${esc(v.mount_point)}${v.has_gamevault ? " · REWRITE" : ""}</button>`,
                  )
                  .join("")
              : `<span class="slot-dim">NO REMOVABLE CARD — insert an SD card or USB drive.</span>`
          }
        </div>
        ${inst.status ? `<div class="errbox">${esc(inst.status)}</div>` : ""}`;
    }
  } else if (p) {
    headline = "Owner signature required.";
    sub = "La clé publique de CETTE machine est dans le QR — la signature du propriétaire autorise cet appareil et aucun autre.";
    steps = [
      { label: "DETECT CARD", st: "ok", note: "SEATED" },
      { label: "READ LICENCE BLOCK", st: "ok", note: `#${g?.ticket?.tokenId ?? "?"}` },
      { label: "OWNER SIGNATURE", st: "run", note: "WAITING…" },
      { label: "UNLOCK TITLE", st: "idle", note: "—" },
    ];
    extra = `
      <div class="qr-zone">
        <img src="${p.qrDataUrl}" alt="QR appairage" />
        <div class="qr-note">Scannez avec le téléphone du propriétaire — ou ouvrez la page sur ce PC.
          <div style="margin-top:10px"><button class="pillbtn" id="open-pair-url">OPEN IN BROWSER ↗</button></div>
        </div>
      </div>`;
  } else if (g) {
    headline = "Card seated. Read complete.";
    sub = "Cette carte est prête — retournez à la fiche du jeu pour jouer ou l'appairer.";
    steps = [
      { label: "DETECT CARD", st: "ok", note: esc(g.cartridge.mount_point) },
      { label: "READ LICENCE BLOCK", st: g.ticket ? "ok" : "fail", note: g.ticket ? `#${g.ticket.tokenId}` : "UNREADABLE" },
      { label: "VERIFY SIGNATURE", st: g.verdict === "authentic" ? "ok" : g.verdict === "unpaired" ? "run" : "fail", note: g.verdict.toUpperCase() },
      { label: "UNLOCK TITLE", st: playableNow(editionFor(g) ?? ({ editionId: "" } as OnchainEdition)) ? "ok" : "idle", note: isOurs(g) ? "THIS MACHINE" : "PAIR NEEDED" },
    ];
  }

  return `
    <div class="insert">
      <div class="reader">
        ${cardIn ? `<div class="lic-card"><div class="lic-head"><div class="lic-brand">AURA LICENCE</div><div class="lic-chip"></div></div><div class="lic-title">${esc(title)}</div><div class="lic-id">${g?.ticket ? `GV-${esc(g.ticket.tokenId.padStart(4, "0"))}-${esc((state.sel ?? "?").padStart(2, "0"))}` : "GV-????"}</div></div>` : ""}
        <div class="slot-hw"><div class="slot-hw-line"></div><div class="slot-led ${cardIn ? "on" : ""}"></div></div>
      </div>
      <div class="insert-right">
        <div class="mono-label">CARD READER</div>
        <div class="insert-title">${esc(headline)}</div>
        <div class="insert-sub">${esc(sub)}</div>
        <div class="steps">
          ${steps.map((s) => `<div class="step ${s.st}"><div class="sdot"></div><div class="slabel">${s.label}</div><div class="sstate">${s.note}</div></div>`).join("")}
        </div>
        ${extra}
        <div class="insert-actions">
          ${p ? `<button class="pillbtn dashed" id="cancel-pairing">CANCEL</button>` : ""}
          ${inst ? `<button class="pillbtn dashed" id="cancel-install">CANCEL</button>` : ""}
          <button class="pillbtn" data-go="${state.sel ? "detail" : "home"}">${state.sel ? "GAME PAGE" : "HOME"}</button>
        </div>
      </div>
    </div>`;
}

function errorView(): string {
  const f = state.fatal;
  if (!f) return homeView();
  return `
    <div class="errscreen">
      <div class="errpanel">
        <div class="bang">!</div>
        <h2>${esc(f.title)}</h2>
        <p>${esc(f.msg)}</p>
        <div class="errcode">${esc(f.code)}</div>
        <div class="err-actions">
          <button class="cta amber" id="err-retry">Try Again</button>
          <button class="cta amber-ghost" data-go="home">Back Home</button>
        </div>
      </div>
    </div>`;
}

function playerView(g: Game): string {
  return `
    <div class="player">
      <header>
        <span class="title">🎮 ${esc(g.meta.title ?? "GAME")} · LICENCE #${esc(g.ticket?.tokenId ?? "?")} · DECRYPTED IN MEMORY${state.ownerCheck ? ` · ${esc(state.ownerCheck)}` : ""}</span>
        <button class="pillbtn" id="quit-btn">✕ EJECT</button>
      </header>
      <iframe src="${GAME_URL}" title="jeu"></iframe>
    </div>`;
}

// ── Render ────────────────────────────────────────────────────

const SCREENS: Record<Screen, () => string> = {
  boot: bootView,
  home: homeView,
  shelf: shelfView,
  detail: detailView,
  insert: insertView,
  error: errorView,
};

function renderChrome(): void {
  const first = state.games[0];
  const led = (id: string, on: boolean, err = false) => {
    const el = document.getElementById(id);
    if (el) el.className = `led ${err ? "err" : on ? "on" : ""}`;
  };
  led("led-chain", state.catalog.length > 0, Boolean(DEPLOYMENTS.gameLicense) && state.catalog.length === 0);
  led("led-ticketd", state.ticketdOk, !state.ticketdOk);
  led("led-card", Boolean(first));

  document.getElementById("mini-card")?.classList.toggle("in", Boolean(first));
  const slotStatus = document.getElementById("slot-status");
  if (slotStatus) {
    if (slotEvent && Date.now() < slotEvent.until) {
      slotStatus.textContent = slotEvent.kind === "in" ? "CARD INSERTED" : "CARD EJECTED";
      slotStatus.className = `slot-status flash ${slotEvent.kind}`;
    } else {
      slotStatus.textContent = first ? "CARD SEATED" : "INSERT A CARD";
      slotStatus.className = `slot-status ${first ? "on" : ""}`;
    }
  }
  const slotDetail = document.getElementById("slot-detail");
  if (slotDetail)
    slotDetail.textContent = first
      ? `SLOT A · ${first.cartridge.mount_point} · ${(first.meta.title ?? "?").toUpperCase()}`
      : `SLOT A · EMPTY · DEVICE ${state.devicePubKey ? short(state.devicePubKey, 6) : "…"}`;

  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const dateStr = now.toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "short" }).toUpperCase();
  const dateEl = document.getElementById("bar-date");
  if (dateEl) dateEl.textContent = dateStr;
  const clockEl = document.getElementById("bar-clock");
  if (clockEl)
    clockEl.innerHTML = `${hh}<span class="colon">:</span>${mm}<span class="sec">:${String(now.getSeconds()).padStart(2, "0")}</span>`;
  // Home-screen clock ticks WITHOUT rebuilding the screen (animations live on)
  const homeTimeB = document.getElementById("home-time-b");
  if (homeTimeB) homeTimeB.innerHTML = `${hh}<span class="big-colon">:</span>${mm}`;
  const homeSec = document.getElementById("home-sec");
  if (homeSec) homeSec.textContent = String(now.getSeconds()).padStart(2, "0");
  const homeDate = document.getElementById("home-date");
  if (homeDate) homeDate.textContent = dateStr;
  // Relative "il y a…" labels tick surgically (kept OUT of sigOf on purpose)
  document.querySelectorAll<HTMLElement>("[data-ago]").forEach((el) => {
    el.textContent = fmtAgo(Number(el.dataset.ts));
  });
  // Native-run elapsed timer ticks surgically too (mm:ss since spawn)
  document.querySelectorAll<HTMLElement>("[data-elapsed]").forEach((el) => {
    const s = Math.max(0, Math.floor((Date.now() - Number(el.dataset.ts)) / 1000));
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  });

  // Orbital PS1 clock: surgical style updates — CSS transitions animate the
  // hour/minute bar hand-off, beads pulse with the seconds.
  document.querySelectorAll<HTMLElement>(".orb-barwrap").forEach((el) => {
    const i = Number(el.dataset.i);
    const g = barGeometry(i, now);
    el.style.cssText = g.wrap + ";position:absolute;left:50%;top:50%;transition:transform 0.8s ease";
    const bar = el.firstElementChild as HTMLElement | null;
    if (bar) bar.style.cssText = g.bar + ";position:absolute;inset:0;clip-path:polygon(0 5%, 42% 0, 100% 5%, 100% 95%, 55% 100%, 0 95%);transition:all 0.6s ease";
  });
  document.querySelectorAll<HTMLElement>(".orb-bead").forEach((el) => {
    const i = Number(el.dataset.i);
    el.style.opacity = (now.getSeconds() + i) % 6 < 4 ? "1" : "0.35";
  });
}

// Re-render ONLY when meaningful state changed — a naive rebuild every 2s
// restarts every CSS animation (the orb looked frozen, screens re-faded).
let lastSig = "";

function sigOf(): string {
  return JSON.stringify({
    s: state.screen,
    sel: state.sel,
    f: state.filter,
    sll: state.selling,
    g: state.games.map((g) => [g.cartridge.mount_point, g.verdict, g.cartridge.has_build, g.ticket?.tokenId, isOurs(g), g.meta.edition]),
    c: state.catalog.map((e) => [e.editionId, e.minted, e.title]),
    m: Object.entries(state.market).map(([k, v]) => [k, v.owner, v.seller, String(v.price)]),
    o: state.owned,
    dl: state.dlStatus,
    p: state.pairing?.status ?? null,
    i: state.installing ? [state.installing.stage, state.installing.status, state.installing.volumes.length] : null,
    a: libraryAddress(),
    t: state.ticketdOk,
    oc: state.ownerCheck,
    b: state.bootLines.map((l) => l.state + l.value).join("|"),
    pl: state.playing?.cartridge.mount_point ?? null,
    nr: state.nativeRun?.pid ?? null,
    ft: state.fatal?.code ?? null,
    r: recentPlays().map((x) => [x.e.editionId, x.log.playCount, Math.floor(x.log.totalSeconds / 60)]),
  });
}

function render(): void {
  renderChrome();
  const root = document.getElementById("screen")!;
  if (state.playing) {
    root.innerHTML = playerView(state.playing);
    document.getElementById("quit-btn")?.addEventListener("click", () => void quit());
    lastSig = sigOf();
    return;
  }
  if (state.nativeRun) {
    root.innerHTML = nativeView(state.nativeRun);
    document.getElementById("quit-btn")?.addEventListener("click", () => void quit());
    lastSig = sigOf();
    return;
  }
  root.innerHTML = SCREENS[state.screen]();
  wire(root);
  lastSig = sigOf();
}

function wire(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) =>
    b.addEventListener("click", () => go(b.dataset.go as Screen)),
  );
  root.querySelectorAll<HTMLButtonElement>(".gamecard, [data-edition]:not(.gamecard):not(#home-continue)").forEach((b) =>
    b.addEventListener("click", () => {
      if (!b.dataset.edition) return;
      state.sel = b.dataset.edition;
      go("detail");
    }),
  );
  document.getElementById("skip-boot")?.addEventListener("click", () => go("home"));
  document.getElementById("filt-all")?.addEventListener("click", () => {
    state.filter = "all";
    render();
  });
  document.getElementById("filt-play")?.addEventListener("click", () => {
    state.filter = "play";
    render();
  });
  document.getElementById("refresh-btn")?.addEventListener("click", () => void forceRefresh());
  document.getElementById("home-insert")?.addEventListener("click", () => {
    // A cartridge waiting for pairing? go straight to its reader screen.
    const g = state.games.find((x) => x.ticket && !isOurs(x));
    if (g) {
      state.sel = editionFor(g)?.editionId ?? null;
      void startPairing(g);
    } else {
      go("shelf");
    }
  });
  document.getElementById("home-continue")?.addEventListener("click", () => {
    const ed = (document.getElementById("home-continue") as HTMLButtonElement).dataset.edition;
    if (!ed) return;
    state.sel = ed;
    const g = cardForEdition(ed);
    if (g && playableNow(state.catalog.find((e) => e.editionId === ed)!)) void play(g);
    else go("detail");
  });
  document.getElementById("watch-btn")?.addEventListener("click", () => {
    const addr = (document.getElementById("watch-addr") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return alert("Adresse invalide — 0x + 40 hex");
    localStorage.setItem("gv-watch", addr);
    void forceRefresh();
  });
  document.getElementById("buy-btn")?.addEventListener("click", () => void openUrl(MARKETPLACE_URL));
  document.getElementById("open-pair-url")?.addEventListener("click", () => state.pairing && void openUrl(state.pairing.url));
  document.getElementById("cancel-pairing")?.addEventListener("click", cancelPairing);
  document.getElementById("cancel-install")?.addEventListener("click", () => {
    state.installing = null;
    go("detail");
  });
  document.getElementById("err-retry")?.addEventListener("click", () => {
    const back = state.fatal?.back ?? "home";
    state.fatal = null;
    go(back);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-play]").forEach((b) =>
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const g = state.games.find((x) => x.cartridge.mount_point === b.dataset.play);
      if (g) void play(g);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-pair]").forEach((b) =>
    b.addEventListener("click", () => {
      const g = state.games.find((x) => x.cartridge.mount_point === b.dataset.pair);
      if (g) void startPairing(g);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-dl]").forEach((b) =>
    b.addEventListener("click", () => {
      const g = state.games.find((x) => x.cartridge.mount_point === b.dataset.dl);
      if (g) void downloadBuild(g);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-install]").forEach((b) =>
    b.addEventListener("click", () => {
      const e = state.catalog.find((x) => x.editionId === b.dataset.install);
      if (e) void openInstall(e, b.dataset.token ?? "");
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-volume]").forEach((b) =>
    b.addEventListener("click", () => {
      const v = state.installing?.volumes.find((x) => x.mount_point === b.dataset.volume);
      if (v) void installTo(v);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-sell]").forEach((b) =>
    b.addEventListener("click", () => {
      state.selling = b.dataset.sell ?? null;
      render();
      document.getElementById("sell-price")?.focus();
    }),
  );
  document.getElementById("cancel-sell")?.addEventListener("click", () => {
    state.selling = null;
    render();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-confirm-sell]").forEach((b) =>
    b.addEventListener("click", () => {
      const price = (document.getElementById("sell-price") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!/^\d*\.?\d+$/.test(price)) return alert("Prix invalide — exemple : 0.00002");
      state.selling = null;
      void openUrl(tradeUrl("list", b.dataset.confirmSell!, price));
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-unlist]").forEach((b) =>
    b.addEventListener("click", () => void openUrl(tradeUrl("unlist", b.dataset.unlist!))),
  );
}

// ── Boot sequence (every check is real) ───────────────────────

async function runBoot(): Promise<void> {
  state.screen = "boot";
  state.bootPct = 4;
  state.bootLines = [
    { label: "DEVICE KEYSTORE", value: "…", state: "idle" },
    { label: "CARD READER", value: "…", state: "idle" },
    { label: "CHAIN LINK · BASE SEPOLIA", value: "…", state: "idle" },
    { label: "TICKET SERVICE", value: "…", state: "idle" },
    { label: "SHELF INDEX", value: "…", state: "idle" },
  ];
  render();
  const setLine = (i: number, value: string, ok: boolean) => {
    state.bootLines[i] = { ...state.bootLines[i], value, state: ok ? "done" : "fail" };
    state.bootPct = Math.round(((i + 1) / state.bootLines.length) * 100);
    if (state.screen === "boot") render();
  };

  try {
    state.devicePubKey = await invoke<string>("get_device_pubkey");
    setLine(0, "KEY READY", true);
  } catch {
    setLine(0, "KEYSTORE ERROR", false);
  }
  try {
    const found = await invoke<Cartridge[]>("scan_cartridges");
    state.games = found.map(judge);
    setLine(1, found.length ? `${found.length} CARD${found.length > 1 ? "S" : ""}` : "NO CARD", true);
  } catch {
    setLine(1, "READER ERROR", false);
  }
  try {
    state.catalog = await fetchOnchainCatalog(chainClient ?? undefined);
    setLine(2, `${state.catalog.length} EDITIONS`, true);
  } catch {
    setLine(2, "OFFLINE", false);
  }
  try {
    const r = await fetch(`${TICKETD_URL}/health`, { signal: AbortSignal.timeout(1500) });
    state.ticketdOk = r.ok;
    setLine(3, r.ok ? "ONLINE" : "ERROR", r.ok);
  } catch {
    state.ticketdOk = false;
    setLine(3, "OFFLINE", false);
  }
  await fetchOwned();
  await fetchMarketState();
  setLine(4, `${state.owned.length} LICENCE${state.owned.length > 1 ? "S" : ""} · ${state.games.length} CARD${state.games.length > 1 ? "S" : ""}`, true);
  scanPrimed = true; // from now on, new mounts are real insertions

  // A native game may have survived a webview reload (vite HMR, F5) —
  // Rust still owns the child; pick the session back up instead of
  // pretending nothing is running.
  try {
    const ns = await invoke<{ running: boolean; pid?: number; seconds?: number }>("native_status");
    if (ns.running) {
      state.nativeRun = {
        g: state.games.find((g) => g.ticket) ?? state.games[0] ?? null,
        pid: ns.pid ?? 0,
        startedAt: Date.now() - (ns.seconds ?? 0) * 1000,
      };
      startNativeWatchdog();
    }
  } catch {
    /* command absent on an older rust build */
  }

  setTimeout(() => {
    if (state.screen === "boot") go("home");
  }, 900);
}

// ── Scan loop ─────────────────────────────────────────────────

let scanCount = 0;

async function forceRefresh(): Promise<void> {
  state.lastScan = "REFRESH…";
  render();
  try {
    state.catalog = await fetchOnchainCatalog(chainClient ?? undefined);
  } catch {
    /* offline */
  }
  await refresh();
  await fetchMarketState();
  await fetchOwned();
  render();
}

let scanPrimed = false; // cards present at boot must not fire "inserted"

async function refresh(): Promise<void> {
  if (state.playing || launching || state.screen === "boot") return;
  try {
    const found = await invoke<Cartridge[]>("scan_cartridges");
    const newGames = found.map(judge);
    if (scanPrimed) {
      const prev = new Set(state.games.map((g) => g.cartridge.mount_point));
      const cur = new Set(newGames.map((g) => g.cartridge.mount_point));
      newGames
        .filter((g) => !prev.has(g.cartridge.mount_point))
        .forEach((g) => cardToast("in", g.meta.title ?? g.cartridge.volume_label ?? "CARD"));
      state.games
        .filter((g) => !cur.has(g.cartridge.mount_point))
        .forEach((g) => cardToast("out", g.meta.title ?? g.cartridge.volume_label ?? "CARD"));
    }
    state.games = newGames;
    state.lastScan = new Date().toLocaleTimeString();
    if (scanCount % 15 === 0) {
      void fetchOnchainCatalog(chainClient ?? undefined)
        .then((c) => {
          state.catalog = c;
        })
        .catch(() => {});
    }
    if (scanCount++ % 5 === 0) {
      await fetchMarketState();
      await fetchOwned();
    }
  } catch (e) {
    state.lastScan = `SCAN ERR ${String(e)}`;
  }
  // Surgical updates only: rebuild the screen when meaningful state changed
  // (never while typing), otherwise just tick the chrome (LEDs, clocks).
  const typing = document.activeElement?.tagName === "INPUT";
  if (!typing && sigOf() !== lastSig) render();
  else renderChrome();
}

window.addEventListener("DOMContentLoaded", () => {
  loadSession();
  document.getElementById("restart-btn")?.addEventListener("click", () => void runBoot());
  document.getElementById("store-btn")?.addEventListener("click", () => void openUrl(MARKETPLACE_URL));
  void runBoot();
  setInterval(() => void refresh(), 2000);
  setInterval(renderChrome, 1000); // bottom-bar clock ticks every second
});
