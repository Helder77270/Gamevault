// AURA-64 shell — UI implemented from "Aura64 Launcher.dc.html" (Claude
// Design). Screens: boot -> home -> shelf -> detail -> insert -> error.
// All security/market logic is unchanged underneath.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import QRCode from "qrcode";
import { createPublicClient, http } from "viem";
import { verifyTicket, isExpired, unhex, type SignedTicket } from "@gamevault/shared";
import { fetchOnchainCatalog, BLURBS, GENRES, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { DEPLOYMENTS, CHAIN } from "@gamevault/shared/deployments";
import { LICENSE_ABI, MARKETPLACE_ABI } from "@gamevault/shared/abi";
import { getLang, locale, setLang, t, type Lang } from "./i18n";

const MARKETPLACE_URL = "http://localhost:3000";
const TICKETD_URL = "http://localhost:8787";
const GAME_URL = navigator.userAgent.includes("Windows") ? "http://game.localhost/" : "game://localhost/";
// Builds come from ticketd (local cache, no CORS); IPFS gateways are the
// backup. Integrity is checked HERE against the on-chain sha256 either way.

// Ticket-signer public keys embedded in the launcher. The ticket key is
// DEDICATED (audit K1, rotated 2026-10-07 — the previous platform key had
// leaked; cards signed with it must be re-paired). The DEV fixture key is
// derived from a PUBLIC seed (shared/devkeys) — anyone can sign with it —
// so it is accepted in `vite dev` builds only, never in a release (audit L1).
const PLATFORM_PUBS = [
  unhex("0x02f993342ee3df755c386e4ec261eed2d439738c284887ca657faa33d2b353292c"),
  ...(import.meta.env.DEV ? [unhex("0x038d78e7c9ea67e401f6e9dbf8fccae4563dc21c0e3f569338012ba95c50700f2b")] : []),
];
const verifyPlatformSig = (t: SignedTicket): boolean => PLATFORM_PUBS.some((k) => verifyTicket(t, k));

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

interface Cartridge {
  build_size: number;
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

type Screen = "boot" | "home" | "shelf" | "detail" | "insert" | "friends" | "settings" | "downloads" | "error";

// ── Settings (per machine, localStorage) ─────────────────────
type Skin = "midnight" | "sunset" | "crt";
interface Settings {
  skin: Skin;
  sound: boolean;
  volume: number; // 0..1
  reducedMotion: boolean;
  dev: boolean;
  veilleMin: number; // idle minutes before the screensaver, 0 = never
  libraries: string[]; // download folders on this PC (the card stays the key)
  notif: { download: boolean; message: boolean; card: boolean; security: boolean };
  startPage: StartPage; // where AURA-64 opens after the boot
  startInTray: boolean; // at Windows startup: stay in the notification area
  localServices: boolean; // POC: start ticketd + the site from the repo when they are down
  dlLimitMBs: number; // download speed limit in MB/s, 0 = unlimited
  dlDuringPlay: boolean; // false: downloads pause while a game runs, resume after
  uiScale: number; // interface scale (native zoom), 1 = 100 %
  calmFx: boolean; // photosensitivity: no animation, no flicker, no decorative effects
  lowBandwidth: boolean; // downloads capped at 2 MB/s, network refreshes 4-6x rarer
  cvd: "std" | "rg" | "by"; // colour vision: standard, red-green, blue-yellow
  vol: Record<SoundCat, number>; // per-category volume, × the master volume
}

/** Sound families: ui (clicks, eject), notif (message, download, card), cine (launch, purchase, resale). */
type SoundCat = "ui" | "notif" | "cine";
const SOUND_CATS: SoundCat[] = ["ui", "notif", "cine"];

const CVD_MODES = ["std", "rg", "by"] as const;

const UI_SCALES = [0.9, 1, 1.1, 1.25, 1.5];
/** Windows "animation effects" off → reduced motion, whatever the setting says. */
const osReducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const DL_LIMITS = [0, 1, 5, 10, 25, 50];

const START_PAGES = ["home", "shelf", "friends", "downloads"] as const;
type StartPage = (typeof START_PAGES)[number];

const VEILLE_CHOICES = [1, 3, 5, 10, 0];
const SETTINGS_DEFAULT: Settings = { skin: "midnight", sound: true, volume: 0.8, reducedMotion: false, dev: true, veilleMin: 3, libraries: [],
  notif: { download: true, message: true, card: true, security: true },
  startPage: "home", startInTray: false, localServices: true, dlLimitMBs: 0, dlDuringPlay: false,
  uiScale: 1, calmFx: false, lowBandwidth: false, cvd: "std",
  vol: { ui: 1, notif: 1, cine: 1 } };

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem("gv-settings") ?? "{}") as Partial<Settings>;
    const s = { ...SETTINGS_DEFAULT, ...raw };
    if (!["midnight", "sunset", "crt"].includes(s.skin)) s.skin = "midnight";
    s.volume = Math.min(1, Math.max(0, Number(s.volume) || 0));
    if (!VEILLE_CHOICES.includes(Number(s.veilleMin))) s.veilleMin = SETTINGS_DEFAULT.veilleMin;
    if (!START_PAGES.includes(s.startPage)) s.startPage = "home";
    s.startInTray = Boolean(s.startInTray);
    s.localServices = s.localServices !== false;
    if (!DL_LIMITS.includes(Number(s.dlLimitMBs))) s.dlLimitMBs = 0;
    s.dlDuringPlay = Boolean(s.dlDuringPlay);
    if (!UI_SCALES.includes(Number(s.uiScale))) s.uiScale = 1;
    s.calmFx = Boolean(s.calmFx);
    s.lowBandwidth = Boolean(s.lowBandwidth);
    if (!CVD_MODES.includes(s.cvd)) s.cvd = "std";
    const v = (typeof s.vol === "object" && s.vol ? s.vol : {}) as Partial<Record<SoundCat, number>>;
    s.vol = { ui: 1, notif: 1, cine: 1 };
    for (const c of SOUND_CATS) if (typeof v[c] === "number") s.vol[c] = Math.min(1, Math.max(0, v[c] as number));
    s.notif = { ...SETTINGS_DEFAULT.notif, ...(typeof s.notif === "object" && s.notif ? s.notif : {}) };
    s.libraries = Array.isArray(s.libraries) ? s.libraries.filter((x) => typeof x === "string" && x.length > 2).slice(0, 8) : [];
    return s;
  } catch {
    return { ...SETTINGS_DEFAULT };
  }
}

const settings: Settings = loadSettings();

function applySettings(): void {
  const root = document.documentElement;
  root.dataset.skin = settings.skin;
  root.classList.toggle("reduced-motion", settings.reducedMotion || settings.calmFx || osReducedMotion());
  root.classList.toggle("calm-fx", settings.calmFx);
  if (settings.cvd === "std") delete root.dataset.cvd;
  else root.dataset.cvd = settings.cvd;
  void invoke("set_ui_scale", { scale: settings.uiScale }).catch(() => {});
  root.lang = getLang();
}

function saveSettings(): void {
  try {
    localStorage.setItem("gv-settings", JSON.stringify(settings));
  } catch {
    /* storage blocked — settings live for this session only */
  }
  applySettings();
}

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
  /** mutual friendships of the library wallet (ticketd DB, with pseudos) */
  friends: [] as Friend[],
  incoming: 0,
  /** live loans touching the library wallet, lent or borrowed */
  loans: [] as { tokenId: string; owner: string; user: string; expires: number }[],
  /** Chat with friends (ticketd, device session — no wallet in the launcher) */
  chat: { active: null as string | null, thread: [] as ChatMsg[], unread: {} as Record<string, number>, ready: true },
  ticketdOk: false,
  /** selected editionId for detail/insert screens */
  sel: null as string | null,
  filter: "all" as "all" | "play",
  /** shelf layout: retro grid, or Steam-style list + preview pane */
  shelfMode: (["list", "storage"].includes(localStorage.getItem("gv-shelfmode") ?? "") ? localStorage.getItem("gv-shelfmode") : "grid") as "grid" | "list" | "storage",
  /** preview pane: technical data accordion (CID/hash/ticket) open? */
  techOpen: false,
  fatal: null as { title: string; msg: string; code: string; back: Screen } | null,
};

type Presence = { state: "offline" | "online" | "playing"; editionId: string | null };
interface Friend {
  addr: string;
  since: number;
  name: string | null;
  hasAvatar?: boolean;
  presence?: Presence;
}
interface ChatMsg {
  id: number;
  from: string;
  to: string;
  kind: string;
  body: string;
  at: number;
  readAt: number | null;
}

function libraryAddress(): string {
  return state.session?.address ?? localStorage.getItem("gv-watch") ?? "";
}

// ── Social session (ticketd): the DEVICE key stands in for the wallet ──
// The launcher has no wallet. Its device key — registered to the paired
// wallet by ticketd at pairing — opens a 24 h session for chat, presence and
// play stats. The Rust core builds and signs the proof (fixed format), the
// webview only forwards it.

let social: { token: string; wallet: string; expiresAt: number } | null = null;

async function socialToken(): Promise<string | null> {
  const wallet = state.session?.address;
  if (!wallet) return null; // a watched address has no paired device
  if (social && social.wallet === wallet.toLowerCase() && social.expiresAt > Date.now() + 60_000) return social.token;
  try {
    const proof = await invoke<{ message: string; signature: string }>("device_session_proof", { wallet });
    const res = await fetch(`${TICKETD_URL}/session/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    social = (await res.json()) as { token: string; wallet: string; expiresAt: number };
    return social.token;
  } catch {
    return null; // offline, or this machine is no longer registered
  }
}

/** Authenticated ticketd call; null when there is no usable session. */
async function socialFetch(path: string, body?: unknown): Promise<Response | null> {
  const call = (token: string) =>
    fetch(`${TICKETD_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
  try {
    let token = await socialToken();
    if (!token) return null;
    let res = await call(token);
    if (res.status === 401) {
      social = null;
      token = await socialToken();
      if (!token) return null;
      res = await call(token);
    }
    return res;
  } catch {
    return null;
  }
}

/** Presence for friends: online / playing <edition>. Heartbeat every 60 s. */
function pushPresence(): void {
  void socialFetch("/presence", { playing: sessionEdition || null });
}

function toast(msg: string): void {
  const el = document.createElement("div");
  el.className = "lc-toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Chat (friends only) — live through ticketd's event stream ──────────

let events: EventSource | null = null;

async function connectEvents(): Promise<void> {
  if (events && events.readyState !== EventSource.CLOSED) return;
  const token = await socialToken();
  if (!token) return;
  events = new EventSource(`${TICKETD_URL}/events?token=${encodeURIComponent(token)}`);
  events.addEventListener("message", (ev) => onChatMessage(JSON.parse((ev as MessageEvent).data) as ChatMsg));
  events.addEventListener("presence", (ev) => {
    const p = JSON.parse((ev as MessageEvent).data) as Presence & { addr: string };
    const f = state.friends.find((x) => x.addr === p.addr);
    if (f) {
      f.presence = { state: p.state, editionId: p.editionId };
      rerender();
    }
  });
  events.addEventListener("friends", () => void fetchFriends());
  // EventSource reconnects by itself; an expired session closes it for good
  events.onerror = () => {
    if (events?.readyState === EventSource.CLOSED) events = null;
  };
}

const myAddr = (): string => (state.session?.address ?? "").toLowerCase();

function onChatMessage(m: ChatMsg): void {
  const other = m.from === myAddr() ? m.to : m.from;
  if (state.screen === "friends" && state.chat.active === other) {
    if (!state.chat.thread.some((x) => x.id === m.id)) {
      state.chat.thread.push(m);
      appendBubble(m);
    }
    if (m.from !== myAddr()) void socialFetch(`/chat/${other}/read`, { upTo: m.id });
    return;
  }
  if (m.from !== myAddr()) {
    state.chat.unread[other] = (state.chat.unread[other] ?? 0) + 1;
    beep([988, 1319], 0.07, 0.07, "sine", "notif"); // soft two-note chime
    const f = state.friends.find((x) => x.addr === other);
    void notify({
      kind: "message",
      title: f?.name ?? short(other, 6),
      body: m.kind === "loan" ? t("nt.msgLoan") : m.body.length > 120 ? `${m.body.slice(0, 120)}…` : m.body,
      action: () => {
        go("friends");
        void openChat(other);
      },
    });
    rerender();
  }
}

/** Rebuild only when something visible changed and nobody is typing. */
function rerender(): void {
  const typing = document.activeElement?.tagName === "INPUT";
  if (!typing && sigOf() !== lastSig) render();
  else renderChrome();
}

async function openChat(addr: string): Promise<void> {
  state.chat.active = addr;
  state.chat.thread = [];
  state.chat.unread[addr] = 0;
  render();
  const res = await socialFetch(`/chat/${addr}`);
  state.chat.ready = Boolean(res);
  if (res?.ok) {
    state.chat.thread = (await res.json()) as ChatMsg[];
    const last = state.chat.thread[state.chat.thread.length - 1];
    if (last) void socialFetch(`/chat/${addr}/read`, { upTo: last.id });
  }
  render();
  document.getElementById("lc-thread")?.scrollTo({ top: 1e9 });
  document.getElementById("lc-input")?.focus();
}

async function sendChat(): Promise<void> {
  const input = document.getElementById("lc-input") as HTMLInputElement | null;
  const text = input?.value.trim() ?? "";
  const to = state.chat.active;
  if (!input || !text || !to) return;
  input.value = "";
  const res = await socialFetch(`/chat/${to}`, { text });
  if (!res?.ok) {
    input.value = text;
    toast(res ? ((await res.json()) as { error?: string }).error ?? t("chat.failed") : t("chat.noSession"));
    return;
  }
  const m = (await res.json()) as ChatMsg;
  if (!state.chat.thread.some((x) => x.id === m.id)) {
    state.chat.thread.push(m);
    appendBubble(m);
  }
  input.focus();
}

function bubbleHtml(m: ChatMsg): string {
  const mine = m.from === myAddr();
  const time = new Date(m.at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  if (m.kind === "loan") {
    let loan: { tokenId: string; editionId: string; expires: number } | null = null;
    try {
      loan = JSON.parse(m.body);
    } catch {
      loan = null;
    }
    if (loan) {
      const title = state.catalog.find((e) => e.editionId === loan.editionId)?.title ?? `Licence #${loan.tokenId}`;
      const days = Math.max(0, Math.ceil((loan.expires - Date.now() / 1000) / 86400));
      return `<div class="lc-loan"><span class="lc-loan-art" style="${artFor(loan.editionId)}"></span><span><b>${esc(title)} · #${esc(loan.tokenId)}</b> ${esc(mine ? t("chat.loanOut") : t("chat.loanIn"))}<span class="lc-loan-sub">${t("chat.loanDays", { n: days })}</span></span></div>`;
    }
  }
  return `<div class="lc-bubble${mine ? " mine" : ""}">${esc(m.body)}<span class="lc-time">${time}${mine && m.readAt ? ` · ${t("chat.read")}` : ""}</span></div>`;
}

function appendBubble(m: ChatMsg): void {
  const thread = document.getElementById("lc-thread");
  if (!thread) return;
  thread.querySelector(".lc-empty")?.remove();
  thread.insertAdjacentHTML("beforeend", bubbleHtml(m));
  thread.scrollTo({ top: 1e9, behavior: "smooth" });
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
  pushPresence();
}

function logPlayEnd(): void {
  if (!sessionEdition) return;
  const seconds = Math.round((Date.now() - sessionStart) / 1000);
  const log = readLog();
  const e = log[sessionEdition];
  if (e) {
    e.totalSeconds += seconds;
    writeLog(log);
  }
  // Profil « les plus joués » + activité — session de l'appareil, fire and forget
  if (seconds > 0) void socialFetch("/profile/playstat", { editionId: sessionEdition, seconds });
  sessionEdition = "";
  pushPresence();
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
  if (s < 60) return t("dur.lt1");
  if (s < 3600) return `${Math.round(s / 60)} MIN`;
  return `${Math.floor(s / 3600)} H ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`;
}

function fmtAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return t("time.now");
  if (d < 3_600_000) return t("time.min", { n: Math.round(d / 60_000) });
  if (d < 86_400_000) return t("time.h", { n: Math.round(d / 3_600_000) });
  return t("time.d", { n: Math.round(d / 86_400_000) });
}

// ── Verification ──────────────────────────────────────────────

// The card is attacker-controlled input (audit L2/L10): every field that
// reaches the DOM or a Tauri command must match its expected shape first.
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function isTicketShape(v: unknown): v is SignedTicket {
  if (!v || typeof v !== "object") return false;
  const x = v as Record<string, unknown>;
  return (
    typeof x.tokenId === "string" && /^\d{1,12}$/.test(x.tokenId) &&
    typeof x.contract === "string" && ADDR_RE.test(x.contract) &&
    typeof x.ownerAddress === "string" && ADDR_RE.test(x.ownerAddress) &&
    typeof x.devicePubKey === "string" && HEX_RE.test(x.devicePubKey) &&
    typeof x.wrappedContentKey === "string" && HEX_RE.test(x.wrappedContentKey) &&
    typeof x.platformSignature === "string" && HEX_RE.test(x.platformSignature) &&
    Number.isInteger(x.chainId) && Number.isInteger(x.issuedAt) && Number.isInteger(x.expiresAt)
  );
}

function cleanMeta(raw: unknown): Game["meta"] {
  if (!raw || typeof raw !== "object") return {};
  const x = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const edition = str(x.edition, 12);
  return { title: str(x.title, 80), studio: str(x.studio, 80), edition: edition && /^\d+$/.test(edition) ? edition : undefined };
}

function judge(c: Cartridge): Game {
  let meta: Game["meta"] = {};
  try {
    meta = c.meta_json ? cleanMeta(JSON.parse(c.meta_json)) : {};
  } catch {
    /* meta is cosmetic */
  }
  let ticket: SignedTicket | null = null;
  try {
    const parsed: unknown = JSON.parse(c.ticket_json);
    if (!isTicketShape(parsed)) return { cartridge: c, ticket: null, meta, verdict: "unreadable" };
    ticket = parsed;
  } catch {
    return { cartridge: c, ticket: null, meta, verdict: "unreadable" };
  }
  if (ticket.chainId !== CHAIN.id) return { cartridge: c, ticket, meta, verdict: "tampered" };
  if (ticket.platformSignature === "0x") return { cartridge: c, ticket, meta, verdict: "unpaired" };
  // A ticket names its contract: one from an abandoned deployment is a card
  // to re-pair, even if the same wallet holds the same token number on the
  // current contract (the Rust core refuses it too).
  if (!DEPLOYMENTS.gameLicense || ticket.contract.toLowerCase() !== DEPLOYMENTS.gameLicense.toLowerCase())
    return { cartridge: c, ticket, meta, verdict: "unpaired" };
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

type OwnerCheck = "ok" | "revoked" | "evicted" | "offline";

/** Is THIS machine still one of the account's active devices (max 2)?
 *  Unknown when ticketd is unreachable — the offline window applies. */
async function deviceStillActive(t: SignedTicket): Promise<boolean | null> {
  try {
    const res = await fetch(`${TICKETD_URL}/devices/${t.ownerAddress}/${t.devicePubKey}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { active: boolean }).active;
  } catch {
    return null;
  }
}

async function checkOwnerOnline(t: SignedTicket): Promise<OwnerCheck> {
  if (!chainClient || !DEPLOYMENTS.gameLicense) return "offline";
  try {
    const holder = t.ownerAddress.toLowerCase();
    const [owner, borrower] = await Promise.all([
      chainClient.readContract({
        address: DEPLOYMENTS.gameLicense,
        abi: LICENSE_ABI,
        functionName: "ownerOf",
        args: [BigInt(t.tokenId)],
      }),
      chainClient
        .readContract({
          address: DEPLOYMENTS.gameLicense,
          abi: LICENSE_ABI,
          functionName: "userOf",
          args: [BigInt(t.tokenId)],
        })
        .catch(() => ZERO_ADDR as `0x${string}`),
    ]);
    const loanActive = borrower.toLowerCase() !== ZERO_ADDR;
    // Règle cartouche : pendant un prêt, l'EMPRUNTEUR a le droit de jeu,
    // le propriétaire est révoqué ; sinon, le propriétaire comme toujours.
    const holds = loanActive ? borrower.toLowerCase() === holder : owner.toLowerCase() === holder;
    if (!holds) return "revoked";
    // Then the account's device slots: paired on 2 other machines since?
    return (await deviceStillActive(t)) === false ? "evicted" : "ok";
  } catch {
    return "offline";
  }
}

async function fetchFriends(): Promise<void> {
  const me = libraryAddress();
  if (!chainClient || !DEPLOYMENTS.gameLicense || !me) {
    state.friends = [];
    state.loans = [];
    return;
  }
  try {
    // Friendship lives in the platform DB (ticketd) — zero gas, zero chain.
    const res = await fetch(`${TICKETD_URL}/friends/${me}`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = (await res.json()) as { friends: Friend[]; incoming: unknown[] };
      state.friends = data.friends;
      state.incoming = data.incoming.length;
    }
    // Chat: unread counters + live stream (device session; skipped when the
    // library is only a watched address)
    const sum = await socialFetch("/chat");
    if (sum?.ok) {
      const rows = (await sum.json()) as { other: string; unread: number }[];
      state.chat.unread = Object.fromEntries(rows.map((r) => [r.other, r.unread]));
      if (state.chat.active) state.chat.unread[state.chat.active] = 0;
    }
    void connectEvents();
    // Live loans touching me — ON-CHAIN truth; token space is tiny, scan it.
    const lic = DEPLOYMENTS.gameLicense as `0x${string}`;
    const next = await chainClient.readContract({ address: lic, abi: LICENSE_ABI, functionName: "nextTokenId", args: [] });
    const loans: typeof state.loans = [];
    for (let i = 1n; i <= next; i++) {
      try {
        const user = await chainClient.readContract({ address: lic, abi: LICENSE_ABI, functionName: "userOf", args: [i] });
        if (user.toLowerCase() === ZERO_ADDR) continue;
        const [owner, exp] = await Promise.all([
          chainClient.readContract({ address: lic, abi: LICENSE_ABI, functionName: "ownerOf", args: [i] }),
          chainClient.readContract({ address: lic, abi: LICENSE_ABI, functionName: "userExpires", args: [i] }),
        ]);
        if (owner.toLowerCase() === me.toLowerCase() || user.toLowerCase() === me.toLowerCase()) {
          loans.push({ tokenId: i.toString(), owner, user, expires: Number(exp) });
        }
      } catch {
        /* burned / rpc hiccup */
      }
    }
    state.loans = loans;
  } catch {
    /* offline — keep last known */
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
    `&nonce=${nonce}&token=${encodeURIComponent(g.ticket.tokenId)}&contract=${encodeURIComponent(DEPLOYMENTS.gameLicense || g.ticket.contract)}`;
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
      fail(t("err.pairTimeoutT"), t("err.pairTimeoutM"), "ERR 0x31 · PAIRING TIMEOUT", "detail");
      return;
    }
    try {
      const res = await fetch(`${TICKETD_URL}/pending/${state.pairing.nonce}`, { signal: AbortSignal.timeout(3000) });
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
  if (
    !isTicketShape(ticket) ||
    !verifyPlatformSig(ticket) ||
    ticket.devicePubKey.toLowerCase() !== state.devicePubKey.toLowerCase() ||
    ticket.tokenId !== g.ticket?.tokenId // the ticket must be for THIS card (audit L12)
  ) {
    state.pairing = null;
    fail(t("err.cardReadT"), t("err.badTicketM"), "ERR 0x21 · LICENCE CHECKSUM MISMATCH · SLOT A", "detail");
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
    inst.status = t("ins.needTokenId");
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
        inst.status = t("ins.wrongEdition", { id: tokenId, ed: ed.toString(), other: other ? ` (« ${other.title} »)` : "", title: inst.edition.title });
        return render();
      }
    } catch {
      inst.status = t("ins.tokenMissing", { id: tokenId });
      return render();
    }
  }
  inst.stage = 1;
  inst.status = "";
  render();
  try {
    // The card is the KEY: meta + ticket only. The game itself downloads to
    // this PC (or to the card, by choice) through the download manager.
    inst.stage = 2;
    render();
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
      dataB64: "",
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
    fail(t("err.cardWriteT"), String(e), "ERR 0x42 · CARD WRITE FAILED", "detail");
  }
}

// ── Market ────────────────────────────────────────────────────

function tradeUrl(action: "list" | "unlist", tokenId: string, priceEth?: string): string {
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
  sfxInsert(); // la carte entre dans la fente — le lancement commence là
  const el = document.createElement("div");
  el.id = "launch-ov";
  el.className = "launch-ov";
  el.innerHTML = `
    <div class="lv-art" style="${artFor(ed?.editionId ?? "1")}"><div class="sheen"></div></div>
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
        chimeCash(); // la vente a payé — c'est le son du cash
        fail(t("err.movedT"), t("err.movedM"), "ERR 0x51 · OWNERSHIP MOVED ON-CHAIN", "detail");
        return;
      }
      if (check === "evicted") {
        state.ownerCheck = "DEVICE RELEASED";
        launchHide();
        chimeOut();
        fail(t("err.evictedT"), t("err.evictedM"), "ERR 0x53 · DEVICE SLOT RELEASED", "detail");
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
        invoke<{ kind: string; pid?: number }>("play_game", {
          mountPoint: g.cartridge.mount_point,
          buildPath: g.cartridge.has_build ? null : (libraryBuildFor(editionFor(g))?.path ?? null),
        }),
        900,
      );
    } catch (e) {
      const msg = String(e);
      launchHide();
      fail(
        t("err.cardReadT"),
        msg.includes("clé d'appareil") || msg.includes("authentication") ? t("err.scrambledM") : msg,
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
      startSessionWatchdog();
    } else {
      state.playing = g;
      startSessionWatchdog(); // web games are re-checked during play too
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

// Session watchdog — the ownership is re-checked DURING play, for native
// (.exe) and web games alike: resale (or a released device slot) ends the
// session within OWNER_CHECK_MS. Offline, the check returns "offline" and
// the session goes on (the offline window rule).
const OWNER_CHECK_MS = 20_000;
let sessionWatchdog: number | undefined;

function startSessionWatchdog(): void {
  stopSessionWatchdog();
  sessionWatchdog = window.setInterval(async () => {
    const native = state.nativeRun !== null;
    const ticket = native ? state.nativeRun?.g?.ticket : state.playing?.ticket;
    if (!ticket) return;
    const check = await checkOwnerOnline(ticket);
    if (check !== "revoked" && check !== "evicted") return;
    stopSessionWatchdog();
    await invoke("stop_game"); // drops the web bundle from memory / kills the native child
    if (!native) logPlayEnd(); // native: the "native-exited" event logs it
    state.playing = null;
    state.nativeRun = null;
    const ended = native ? "PROCESS TERMINATED" : "SESSION TERMINATED";
    if (check === "revoked") {
      chimeCash();
      fail(t("err.movedT"), t(native ? "err.resoldMidM" : "err.resoldMidWebM"), `ERR 0x52 · RESOLD MID-SESSION · ${ended}`, "detail");
    } else {
      chimeOut();
      fail(t("err.evictedT"), t("err.evictedM"), `ERR 0x53 · DEVICE SLOT RELEASED · ${ended}`, "detail");
    }
  }, OWNER_CHECK_MS);
}

function stopSessionWatchdog(): void {
  if (sessionWatchdog !== undefined) window.clearInterval(sessionWatchdog);
  sessionWatchdog = undefined;
}

void listen<{ code: number | null; seconds: number; killed: boolean }>("native-exited", (e) => {
  stopSessionWatchdog();
  logPlayEnd();
  const wasRunning = state.nativeRun !== null;
  state.nativeRun = null;
  if (wasRunning && !e.payload.killed) chimeOut(); // natural exit (window closed)
  if (state.screen !== "error") render();
});

function nativeView(run: NonNullable<typeof state.nativeRun>): string {
  const ed = run.g ? editionFor(run.g) : undefined;
  const guard = run.g?.ticket
    ? `OWNERSHIP RE-CHECKED EVERY ${OWNER_CHECK_MS / 1000} S · RESALE TERMINATES THE PROCESS`
    : "SESSION RESYNCED · TICKET UNKNOWN — EJECT TO REARM THE GUARD";
  return `
    <div class="launch-ov" style="animation:none">
      <div class="lv-art" style="${artFor(ed?.editionId ?? "1")}"><div class="sheen"></div></div>
      <div class="lv-title">${esc(run.g?.meta.title ?? ed?.title ?? "NATIVE GAME")}</div>
      <div class="lv-sub">NATIVE PROCESS · PID ${run.pid} · <span data-elapsed data-ts="${run.startedAt}">00:00</span></div>
      <div class="lv-sub" style="margin-top:4px">${guard}</div>
      <button class="pillbtn dashed" id="quit-btn" style="margin-top:18px">✕ EJECT · TERMINATE</button>
    </div>`;
}

async function quit(): Promise<void> {
  stopSessionWatchdog();
  await invoke("stop_game"); // drops the HTML bundle AND/OR kills the native child
  logPlayEnd();
  state.playing = null;
  state.nativeRun = null;
  render();
}

// ── Retro SFX (WebAudio, zero assets) ─────────────────────────

let audio: AudioContext | null = null;

function beep(freqs: number[], dur = 0.09, vol = 0.16, wave: OscillatorType = "sine", cat: SoundCat = "ui"): void {
  if (!settings.sound) return;
  vol *= settings.volume * settings.vol[cat];
  if (vol <= 0) return;
  try {
    audio ??= new AudioContext();
    void audio.resume();
    freqs.forEach((f, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = wave;
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

const chimeOut = (): void => beep([660, 440]);
const chimeLaunch = (): void => beep([523, 659, 880], 0.12, 0.16, "sine", "cine");

// ── Les moments signatures (DA v1) — WebAudio, zéro asset ─────

/** Carte SD qui s'insère : clic mécanique + petite montée en rotation. */
function sfxInsert(cat: SoundCat = "cine"): void {
  if (!settings.sound || settings.volume * settings.vol[cat] <= 0) return;
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const t0 = audio.currentTime;
    const v = settings.volume * settings.vol[cat];
    // clic : bouffée de bruit filtrée
    const buf = audio.createBuffer(1, 2205, 44100);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = audio.createBufferSource();
    src.buffer = buf;
    const bp = audio.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2600;
    const g = audio.createGain();
    g.gain.value = 0.5 * v;
    src.connect(bp).connect(g).connect(audio.destination);
    src.start(t0);
    // whir : le lecteur prend ses tours
    const o = audio.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(90, t0 + 0.07);
    o.frequency.exponentialRampToValueAtTime(360, t0 + 0.5);
    const og = audio.createGain();
    og.gain.setValueAtTime(0.0001, t0 + 0.07);
    og.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.11 * v), t0 + 0.14);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.58);
    o.connect(og).connect(audio.destination);
    o.start(t0 + 0.07);
    o.stop(t0 + 0.62);
  } catch {
    /* autoplay policy */
  }
}

/** Achat : fanfare courte, glorifiante (arpège majeur + éclat). */
function chimeBuy(): void {
  beep([523, 659, 784, 1047], 0.1, 0.18, "sine", "cine");
  setTimeout(() => beep([1568, 2093], 0.22, 0.09, "sine", "cine"), 430);
}

/** Revente/révocation : le ka-ching du tiroir-caisse. */
function chimeCash(): void {
  beep([2637, 2093], 0.055, 0.16, "square", "cine");
  setTimeout(() => beep([1047, 1319], 0.12, 0.12, "sine", "cine"), 120);
}

// ── Card insert/eject events (overlay layer, outside diff-render) ──

let slotEvent: { kind: "in" | "out"; until: number } | null = null;

// ── Helpers ───────────────────────────────────────────────────

const short = (h: string, n = 8): string => (h.length <= 2 * n ? h : `${h.slice(0, n)}…${h.slice(-4)}`);
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hueOf = (editionId: string): number => (Number(editionId) * 137) % 360;
const artGrad = (hue: number): string =>
  `background:linear-gradient(160deg, oklch(0.62 0.13 ${hue}) 0%, oklch(0.34 0.1 ${hue + 30}) 65%, oklch(0.22 0.06 265) 100%);`;

// Key art per edition (launcher/public/art). The edition-hue gradient stays
// ON TOP at reduced opacity: images read as AURA-64 material, not stickers —
// and the fallback (no file) is the plain gradient as before.
// Post-reset 2026-10-07 : 1 Snake (serpent), 2 Runner, 3 Native (carte SD à
// l'aura). ed3.webp (chasseur) attend un prochain titre.
const ART_FILES: Record<string, string> = { "1": "/art/ed1.webp", "2": "/art/ed2.webp", "3": "/art/ed4.webp" };
function artFor(editionId: string): string {
  const img = ART_FILES[editionId];
  const hue = hueOf(editionId);
  if (!img) return artGrad(hue);
  return `background:linear-gradient(160deg, oklch(0.62 0.13 ${hue} / 0.38) 0%, oklch(0.34 0.1 ${hue + 30} / 0.45) 55%, oklch(0.1 0.04 265 / 0.82) 100%), url('${img}') center/cover;`;
}

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
  return Boolean(g && g.verdict === "authentic" && isOurs(g) && (g.cartridge.has_build || libraryBuildFor(e)));
}

// ── Screens ───────────────────────────────────────────────────

function bootView(): string {
  return `
    <div class="boot">
      <div class="boot-left">
        <div class="boot-logo-wrap">
          <div class="boot-logo"></div>
          <svg class="aura-arcs" viewBox="0 0 172 172" aria-hidden="true">
            <path class="a1" d="M26 56 L14 48 M22 86 L8 86 M28 118 L15 128"></path>
            <path class="a2" d="M146 56 L158 48 M150 86 L164 86 M144 118 L157 128"></path>
            <path class="a1" d="M60 22 L52 10 M112 22 L120 10"></path>
            <path class="a2" d="M60 150 L52 162 M112 150 L120 162"></path>
          </svg>
        </div>
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
        <div class="boot-note">${esc(t("boot.note"))}</div>
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

function ticketDaysLeft(g: Game | undefined): string {
  if (!g?.ticket) return "—";
  const d = Math.ceil((g.ticket.expiresAt * 1000 - Date.now()) / 86_400_000);
  return d > 0 ? t("ticket.days", { n: d }) : t("ticket.expired");
}

function homeView(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const date = now
    .toLocaleDateString(locale(), { weekday: "short", day: "2-digit", month: "short" })
    .toUpperCase();
  const addr = libraryAddress();
  const playable = state.catalog.filter(playableNow).length;
  const recents = recentPlays();
  const seated = state.games[0];

  const top = `
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
      <button class="home-store" id="home-store">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6h15l-1.5 9h-12z"></path><path d="M6 6 5 3H2"></path><circle cx="9" cy="20" r="1.6"></circle><circle cx="18" cy="20" r="1.6"></circle></svg>
        STORE
        <span class="hs-count">${t("home.titles", { n: state.catalog.length })}</span>
      </button>
    </div>`;

  // ── PISTE A — no card seated: arcade attract mode ────────────
  if (!seated) {
    const recentRow = recents.length
      ? `<div class="home-recent">
          <div class="mono-label" style="margin-bottom:10px">LAST PLAYED</div>
          <div class="recent-tiles">
            ${recents
              .map(
                (r) => `
              <button class="recent-tile" data-edition="${esc(r.e.editionId)}">
                <div class="rart" style="${artFor(r.e.editionId)}"></div>
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
        ${top}
        <div class="attract-zone">
          <button class="attract" id="home-insert">
            <span class="atk-slotwrap" aria-hidden="true">
              <span class="atk-card"></span>
              <span class="atk-slot"><span class="atk-slot-line"></span></span>
            </span>
            <span>
              <span class="atk-line">INSERT SD CARD TO PLAY</span>
              <span class="atk-sub">${t("home.attractSub")}</span>
            </span>
          </button>
          <button class="pillbtn dashed" data-go="shelf">${t("home.browse", { n: playable })}</button>
        </div>
        ${recentRow}
      </div>`;
  }

  // ── PISTE B — card seated: the game takes the whole screen (SteamOS-like,
  // validated 2026-10-09). Same stage for every card state; only the primary
  // action changes: PLAY, PAIR (also RENEW: same flow), or FETCH the build.
  const ed = editionFor(seated);
  const editionId = ed?.editionId ?? seated.meta.edition ?? "1";
  const log = ed ? readLog()[ed.editionId] : undefined;
  const can = ed ? playableNow(ed) : false;
  const title = seated.meta.title ?? ed?.title ?? "GAME";
  const action: "play" | "pair" | "renew" | "fetch" | "sheet" = can
    ? "play"
    : seated.verdict === "unpaired" || !isOurs(seated)
      ? "pair"
      : seated.verdict === "expired"
        ? "renew"
        : !seated.cartridge.has_build && !libraryBuildFor(ed)
          ? "fetch"
          : "sheet";
  const warn = action !== "play";
  const vState = can
    ? { label: "READY · TICKET " + ticketDaysLeft(seated), cls: "" }
    : action === "pair"
      ? { label: "PAIR THIS MACHINE", cls: "warn" }
      : action === "renew"
        ? { label: t("home.ticketExpired"), cls: "warn" }
        : action === "fetch"
          ? { label: "NO BUILD — FETCH IPFS", cls: "warn" }
          : { label: seated.verdict.toUpperCase(), cls: "warn" };
  const tokenId = seated.ticket?.tokenId;
  const kicker = [
    can ? t("sx.continue") : t("sx.inserted"),
    t("pv.ed", { id: esc(editionId) }),
    tokenId ? `LICENCE #${esc(tokenId)}` : "",
  ].filter(Boolean).join(" · ");
  const sub = [ed?.studio, GENRES[editionId] ?? "INDIE"].filter(Boolean).map((x) => esc(String(x).toUpperCase())).join(" · ");
  const chips = can
    ? [
        log ? `▶ ${t("sx.plays", { n: log.playCount })}` : t("home.firstPlay"),
        log ? t("sx.played", { d: fmtDur(log.totalSeconds) }) : "",
        log ? `${t("sx.last")} · <span data-ago data-ts="${log.lastPlayedAt}">${fmtAgo(log.lastPlayedAt)}</span>` : "",
      ]
        .filter(Boolean)
        .map((c) => `<span class="sx-chip">${c}</span>`)
        .join("") + `<span class="sx-chip ok">${t("sx.offline", { d: ticketDaysLeft(seated) })}</span>`
    : "";
  const why = warn ? `<p class="sx-why">${t(`sx.why.${action}` as "sx.why.pair")}</p>` : "";
  const primaryLabel = t(`sx.act.${action}` as "sx.act.play");
  const icon = {
    play: `<span class="sx-key" aria-hidden="true">↵</span>`,
    pair: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"></path></svg>`,
    renew: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"></path></svg>`,
    fetch: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg>`,
    sheet: "",
  }[action];
  const friendHere = state.friends.find((f) => f.presence?.state === "playing");
  const friendChip = friendHere
    ? `<div class="sx-friend">
        <span class="lc-dot playing">${avatarHtml(friendHere, 34)}</span>
        <div style="min-width:0;flex:1">
          <div class="sx-friend-name">${esc(friendHere.name ?? short(friendHere.addr, 4))}</div>
          <div class="sx-friend-sub">${esc(presenceLabel(friendHere.presence))}</div>
        </div>
        <button class="sx-link" data-chat="${esc(friendHere.addr)}">CHAT ↗</button>
      </div>`
    : "";
  // Library rail: the seated game first, then what this machine can play,
  // then the rest of the catalog (peeking off the right edge, iiSU-style).
  const railEds = [
    ...state.catalog.filter((e) => e.editionId === editionId),
    ...state.catalog.filter((e) => e.editionId !== editionId && playableNow(e)),
    ...state.catalog.filter((e) => e.editionId !== editionId && !playableNow(e)),
  ];
  const rail = railEds
    .map(
      (e) => `
      <button class="sx-tile ${e.editionId === editionId ? "on" : ""}" data-edition="${esc(e.editionId)}" style="${artFor(e.editionId)}" aria-label="${esc(e.title)}">
        <span class="sx-tile-t">${esc(e.title)}</span>
      </button>`,
    )
    .join("");

  return `
    <div class="sx">
      <div class="sx-art ${warn ? "held" : ""}" style="${artFor(editionId)}"></div>
      <div class="sx-scrim-l"></div><div class="sx-scrim-b"></div>
      <div class="sx-side">
        <div class="card-widget sx-glass ${warn ? "warn" : ""}">
          <div class="mono-label" style="font-size:10px;letter-spacing:0.26em">SLOT A · CARD SEATED</div>
          <div class="cw-row">
            <span class="atk-slotwrap" aria-hidden="true">
              <span class="atk-card" style="animation:none"></span>
              <span class="atk-slot"><span class="atk-slot-line"></span></span>
            </span>
            <div style="min-width:0">
              <div class="cw-title">${esc(title)}</div>
              <div class="cw-state ${vState.cls}"><span class="cw-led"></span>${esc(vState.label)}</div>
              <div class="cw-dim">${esc(seated.cartridge.mount_point)} · ${seated.cartridge.has_build ? "BUILD OK" : "NO BUILD"}${addr && !warn ? " · OWNER ✔" : ""}</div>
            </div>
          </div>
        </div>
        ${friendChip}
      </div>
      <div class="sx-content">
        <div class="sx-main">
          <span class="sx-kicker ${warn ? "warn" : ""}">${kicker}</span>
          <h1 class="sx-title">${esc(title)}</h1>
          <div class="sx-sub">${sub}</div>
          ${chips ? `<div class="sx-chips">${chips}</div>` : ""}
          ${why}
          <div class="sx-actions">
            <button class="sx-play ${warn ? "warn" : ""}" id="home-hero">${icon}${esc(primaryLabel)}</button>
            ${action !== "sheet" ? `<button class="sx-btn" data-edition="${esc(editionId)}">${t("sx.sheet")}</button>` : ""}
            ${tokenId && /^\d{1,12}$/.test(tokenId) ? `<button class="sx-btn" data-prov="${esc(tokenId)}">${t("sx.prov")}</button>` : ""}
            ${can ? `<button class="sx-btn violet" id="home-lend">${t("sx.lend")}</button>` : ""}
          </div>
        </div>
        <div class="sx-rail">
          <div class="sx-rail-head">
            <span class="mono-label">${t("sx.library", { n: playable })}</span>
            <span class="sx-keys" aria-hidden="true"><span class="sx-kc">↵</span>${esc(primaryLabel)}<span class="sx-kc">F</span>${t("sx.sheet")}</span>
          </div>
          <div class="sx-tiles">
            ${rail}
            <button class="sx-tile store" id="home-store">+ STORE</button>
          </div>
        </div>
      </div>
    </div>`;
}

/** Status label + chip class for an edition, shared by grid, list & preview. */
function shelfStatus(e: OnchainEdition, g: Game | undefined, ownedTok: { tokenId: string }[], can: boolean): { label: string; cls: "ok" | "warn" | "buy" } {
  if (can) return { label: "READY", cls: "ok" };
  if (g) {
    if (g.verdict === "unpaired" || !isOurs(g)) return { label: "PAIR CARD", cls: "warn" };
    if (g.verdict === "expired") return { label: "RENEW", cls: "warn" };
    if (!g.cartridge.has_build && !libraryBuildFor(e)) return { label: t("dl.toDownload"), cls: "warn" };
    return { label: "CHECK CARD", cls: "warn" };
  }
  if (ownedTok.length) return { label: libraryBuildFor(e) ? "AWAITING CARD" : t("dl.toDownload"), cls: "warn" };
  return { label: `${formatEth(e.priceWei)} ETH`, cls: "buy" };
}

function previewPane(e: OnchainEdition): string {
  const g = cardForEdition(e.editionId);
  const ownedTok = state.owned.filter((o) => o.editionId === e.editionId);
  const can = playableNow(e);
  const log = readLog()[e.editionId];
  const { action, hint } = actionFor(e, g, ownedTok, can);
  return `
    <div class="shelf-preview">
      <div class="pv-banner" style="${artFor(e.editionId)}">
        <div class="pv-note">${t("pv.ed", { id: esc(e.editionId) })} · ${esc(e.studio.toUpperCase())}</div>
        <div class="pv-foot">
          <div class="pv-title">${esc(e.title)}</div>
          <div class="pv-kick">${g?.ticket ? `LICENCE #${esc(g.ticket.tokenId)} · ` : ownedTok.length ? `LICENCE #${esc(ownedTok[0].tokenId)} · ` : ""}${t("pv.minted", { m: e.minted, s: e.supply })} · ${e.resellable ? `ROYALTIES ${e.royaltyBps / 100}%` : "NO RESALE"}</div>
        </div>
      </div>
      <div class="pv-body">
        <div class="pv-stats">
          <div class="pv-stat"><div class="k">${t("pv.playtime")}</div><div class="v">${log ? fmtDur(log.totalSeconds) : "—"}</div></div>
          <div class="pv-stat"><div class="k">${t("pv.lastSession")}</div><div class="v">${log ? `<span data-ago data-ts="${log.lastPlayedAt}">${fmtAgo(log.lastPlayedAt)}</span>` : "—"}</div></div>
          <div class="pv-stat"><div class="k">${t("pv.card")}</div><div class="v ${g ? "on" : ""}">${g ? `${esc(g.cartridge.mount_point)} · ${g.verdict.toUpperCase()}` : t("pv.notInserted")}</div></div>
          <div class="pv-stat"><div class="k">TICKET</div><div class="v">${ticketDaysLeft(g)}</div></div>
        </div>
        <div class="pv-main">
          <div class="glass-menu">
            ${action}
            <button class="gm-item" data-edition="${esc(e.editionId)}">${t("pv.fullSheet")}</button>
            ${
              g?.ticket && isOurs(g) && g.verdict === "authentic"
                ? `<button class="gm-item violet" data-gosell="${esc(g.ticket.tokenId)}" data-goedition="${esc(e.editionId)}">${t("pv.resell")}</button>`
                : ""
            }
            ${
              (g?.ticket && isOurs(g)) || ownedTok.length
                ? `<button class="gm-item" data-lendfriend="1" title="${esc(t("pv.lendTitle"))}">${t("pv.lend")}</button>`
                : `<button class="gm-item" disabled title="${esc(t("pv.lendDisabledTitle"))}">${t("pv.lendDisabled")}</button>`
            }
          </div>
          <div class="pv-hint">${esc(hint)}</div>
        </div>
        ${
          settings.dev
            ? `<details class="tech-acc" id="tech-acc" ${state.techOpen ? "open" : ""}>
          <summary><span>${t("pv.tech")}</span><span>${state.techOpen ? t("pv.techHide") : t("pv.techShow")}</span></summary>
          <div class="debug">ed. #${esc(e.editionId)} · game #${esc(e.gameId)} · studio #${esc(e.studioId)} · chain ${CHAIN.id}<br>
            cid ${esc(e.buildCid)}<br>
            ${g?.ticket ? `ticket #${esc(g.ticket.tokenId)} · owner ${esc(short(g.ticket.ownerAddress, 8))} · exp ${new Date(g.ticket.expiresAt * 1000).toLocaleString(locale())}` : t("pv.noTicket")}
          </div>
        </details>`
            : ""
        }
      </div>
    </div>`;
}

function shelfView(): string {
  const addr = libraryAddress();
  const list = state.filter === "play" ? state.catalog.filter(playableNow) : state.catalog;
  const unlocked = state.catalog.filter(playableNow).length;
  const isList = state.shelfMode === "list";
  if (state.shelfMode === "storage") void refreshStorageSpace();
  const selEd = list.find((e) => e.editionId === state.sel) ?? list[0];

  const gridBody = `
      <div class="shelf-grid-wrap">
        <div class="shelf-grid">
          ${
            list.length
              ? list
                  .map((e) => {
                    const g = cardForEdition(e.editionId);
                    const ownedTok = state.owned.filter((o) => o.editionId === e.editionId);
                    const can = playableNow(e);
                    const status = shelfStatus(e, g, ownedTok, can).label;
                    return `
              <button class="gamecard" data-edition="${esc(e.editionId)}">
                <div class="art ${can || ownedTok.length || g ? "" : "locked"}" style="${artFor(e.editionId)}">
                  <div class="artnote">${t("pv.ed", { id: esc(e.editionId) })} · ${esc(e.studio)}</div>
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
      </div>`;

  const listBody = `
      <div class="shelf-split">
        <div class="shelf-listcol">
          ${
            list.length
              ? list
                  .map((e) => {
                    const g = cardForEdition(e.editionId);
                    const ownedTok = state.owned.filter((o) => o.editionId === e.editionId);
                    const can = playableNow(e);
                    const st = shelfStatus(e, g, ownedTok, can);
                    const log = readLog()[e.editionId];
                    return `
            <button class="listrow ${selEd?.editionId === e.editionId ? "on" : ""}" data-selrow="${esc(e.editionId)}">
              <div class="lr-art" style="${artFor(e.editionId)}"></div>
              <div style="min-width:0">
                <div class="lr-title">${esc(e.title)}</div>
                <div class="lr-meta">${esc(e.studio.toUpperCase())} · ${t("pv.ed", { id: esc(e.editionId) })}</div>
              </div>
              <div class="lr-right">
                <span class="lr-chip ${st.cls}">${esc(st.label)}</span>
                <div class="lr-time">${log ? fmtDur(log.totalSeconds) : "—"}</div>
              </div>
            </button>`;
                  })
                  .join("")
              : `<div class="slot-dim">${DEPLOYMENTS.gameRegistry ? "READING CHAIN…" : "NO CONTRACTS DEPLOYED"}</div>`
          }
        </div>
        ${selEd ? previewPane(selEd) : `<div class="shelf-preview"><div class="pv-body"><span class="slot-dim">${t("shelf.selectTitle")}</span></div></div>`}
      </div>`;

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
        <div style="display:flex;gap:8px;align-items:center">
          <button class="pillbtn ${state.filter === "all" ? "active" : ""}" id="filt-all">ALL</button>
          <button class="pillbtn ${state.filter === "play" ? "active" : ""}" id="filt-play">PLAYABLE</button>
          <div class="view-toggle">
            <button id="view-grid" class="${isList ? "" : "active"}" aria-label="${t("shelf.gridView")}"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5"></rect><rect x="13" y="3" width="8" height="8" rx="1.5"></rect><rect x="3" y="13" width="8" height="8" rx="1.5"></rect><rect x="13" y="13" width="8" height="8" rx="1.5"></rect></svg></button>
            <button id="view-list" class="${isList ? "active" : ""}" aria-label="${t("shelf.listView")}"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="4" width="18" height="3.4" rx="1.4"></rect><rect x="3" y="10.3" width="18" height="3.4" rx="1.4"></rect><rect x="3" y="16.6" width="18" height="3.4" rx="1.4"></rect></svg></button>
            <button id="view-storage" class="${state.shelfMode === "storage" ? "active" : ""}" aria-label="${t("stg.view")}" title="${t("stg.view")}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="1.6"></rect><rect x="3" y="13" width="18" height="7" rx="1.6"></rect><path d="M7 7.5h.01M7 16.5h.01"></path></svg></button>
          </div>
          <button class="pillbtn violet" id="home-insert">+ INSERT CARD</button>
          <button class="pillbtn" id="refresh-btn">🔄</button>
        </div>
      </div>
      ${
        !addr
          ? `<div class="watch-row">
              <span class="slot-dim">VIEW YOUR LICENCES:</span>
              <input class="aura-input" id="watch-addr" placeholder="${t("shelf.watchPlaceholder")}" style="width:24rem" />
              <button class="pillbtn" id="watch-btn">FOLLOW</button>
            </div>`
          : ""
      }
      ${state.shelfMode === "storage" ? storageBody() : isList ? listBody : gridBody}
    </div>`;
}

const FRIEND_AGE_SEC = 3 * 86400;

function avatarHtml(f: { addr: string; name: string | null; hasAvatar?: boolean }, size: number): string {
  const hue = Number.parseInt(f.addr.slice(2, 8), 16) % 360;
  const inner = f.hasAvatar
    ? `<img src="${TICKETD_URL}/profile/avatar/${esc(f.addr)}" alt="" />`
    : esc((f.name?.trim()[0] ?? f.addr.slice(2, 3)).toUpperCase());
  return `<span class="lc-av" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:linear-gradient(150deg, oklch(0.72 0.12 ${hue}), oklch(0.36 0.08 ${(hue + 50) % 360}))">${inner}</span>`;
}

function presenceLabel(p?: Presence): string {
  if (p?.state === "playing") {
    const title = state.catalog.find((e) => e.editionId === p.editionId)?.title ?? "";
    return t("chat.playing", { g: title.toUpperCase() });
  }
  return p?.state === "online" ? t("chat.online") : t("chat.offline");
}

function friendsView(): string {
  const me = libraryAddress();
  const now = Math.floor(Date.now() / 1000);
  const rank = (f: Friend) => (f.presence?.state === "playing" ? 0 : f.presence?.state === "online" ? 1 : 2);
  const groups: [string, Friend[]][] = [
    [t("chat.gPlaying"), state.friends.filter((f) => rank(f) === 0)],
    [t("chat.gOnline"), state.friends.filter((f) => rank(f) === 1)],
    [t("chat.gOffline"), state.friends.filter((f) => rank(f) === 2)],
  ];
  const friendRows = state.friends.length
    ? groups
        .filter(([, list]) => list.length)
        .map(
          ([label, list]) => `
          <div class="mono-label lc-group">${esc(label)} · ${list.length}</div>
          ${list
            .map((f) => {
              const unread = state.chat.unread[f.addr] ?? 0;
              const matured = now >= f.since + FRIEND_AGE_SEC;
              return `
              <button class="lc-friend${state.chat.active === f.addr ? " on" : ""}" data-chat="${esc(f.addr)}">
                <span class="lc-dot ${f.presence?.state ?? "offline"}">${avatarHtml(f, 36)}</span>
                <span style="flex:1;min-width:0">
                  <span class="lc-name">${esc(f.name ?? short(f.addr, 6))}</span>
                  <span class="lc-sub ${f.presence?.state ?? "offline"}">${esc(presenceLabel(f.presence))}${matured ? "" : ` · ${t("fr.lendIn", { n: Math.max(1, Math.ceil((f.since + FRIEND_AGE_SEC - now) / 86400)) })}`}</span>
                </span>
                ${unread ? `<span class="lc-unread">${unread}</span>` : ""}
              </button>`;
            })
            .join("")}`,
        )
        .join("")
    : `<div class="slot-dim" style="padding:14px 4px">${t("fr.none")}</div>`;

  const loanRows = state.loans
    .map((l) => {
      const lent = me && l.owner.toLowerCase() === me.toLowerCase();
      const days = Math.max(0, Math.ceil((l.expires - now) / 86400));
      const owned = state.owned.find((o) => o.tokenId === l.tokenId);
      const title = state.catalog.find((e) => e.editionId === owned?.editionId)?.title ?? `Licence #${l.tokenId}`;
      return `<div class="lc-loanrow"><span>${esc(title)} · #${esc(l.tokenId)}</span><span class="lr-chip ${lent ? "warn" : "ok"}">${lent ? t("fr.atFriend") : t("fr.yourTurn")} · J-${days}</span></div>`;
    })
    .join("");

  const friend = state.friends.find((f) => f.addr === state.chat.active) ?? null;
  const panel = !friend
    ? `<div class="lc-empty-panel">${t(state.friends.length ? "chat.pick" : "fr.none")}</div>`
    : `
      <div class="lc-head">
        ${avatarHtml(friend, 42)}
        <div style="flex:1;min-width:0">
          <div class="lc-title">${esc(friend.name ?? short(friend.addr, 8))}</div>
          <div class="lc-sub ${friend.presence?.state ?? "offline"}">${esc(presenceLabel(friend.presence))} · ${t("fr.since", { d: new Date(friend.since * 1000).toLocaleDateString(locale()) })}</div>
        </div>
        <button class="pillbtn" data-profile="${esc(friend.addr)}">${t("chat.profile")}</button>
        <button class="pillbtn violet" id="friends-lend">${t("chat.lend")}</button>
        <button class="pillbtn dashed" disabled title="${esc(t("chat.inviteSoon"))}">${t("chat.invite")}</button>
      </div>
      <div class="lc-thread" id="lc-thread">
        ${state.chat.thread.length ? state.chat.thread.map(bubbleHtml).join("") : `<div class="lc-empty">${t(state.chat.ready ? "chat.empty" : "chat.noSession")}</div>`}
      </div>
      <div class="lc-compose">
        <input id="lc-input" class="aura-input" maxlength="1000" placeholder="${esc(t("chat.write", { n: friend.name ?? short(friend.addr, 6) }))}" aria-label="${esc(t("chat.write", { n: friend.name ?? short(friend.addr, 6) }))}" />
        <button class="cta" id="lc-send">${t("chat.send")}</button>
      </div>`;

  return `
    <div class="shelf">
      <div class="shelf-head">
        <div style="display:flex;align-items:center;gap:18px">
          <button class="backbtn" data-go="home">&#8592;</button>
          <div>
            <div class="shelf-title">${esc(t("fr.title"))}</div>
            <div class="shelf-meta">${t("fr.meta", { f: state.friends.length, l: state.loans.length })}${me ? "" : t("fr.metaNoAddr")}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          ${state.incoming ? `<button class="pillbtn violet" id="friends-manage">${t("chat.requests", { n: state.incoming })}</button>` : `<button class="pillbtn violet" id="friends-manage">${t("fr.manage")}</button>`}
          <button class="pillbtn" id="refresh-btn">🔄</button>
        </div>
      </div>
      <div class="lc-split">
        <div class="lc-col">
          ${friendRows}
          ${loanRows ? `<div class="mono-label lc-group">${t("fr.loans")}</div>${loanRows}` : ""}
          <div class="pv-hint lc-rule">${esc(t("fr.rule"))}</div>
        </div>
        <div class="lc-panel">${panel}</div>
      </div>
    </div>`;
}

function settingsView(): string {
  const lang = getLang();
  const skins: { id: Skin; name: string; sub: string; swatch: string }[] = [
    { id: "midnight", name: t("set.skin.midnight"), sub: t("set.skin.midnightSub"), swatch: "linear-gradient(135deg, #05060d 0 40%, oklch(0.8 0.1 200) 40% 70%, oklch(0.8 0.11 310) 70%)" },
    { id: "sunset", name: t("set.skin.sunset"), sub: t("set.skin.sunsetSub"), swatch: "linear-gradient(135deg, oklch(0.12 0.05 300) 0 40%, oklch(0.72 0.19 340) 40% 70%, oklch(0.75 0.15 45) 70%)" },
    { id: "crt", name: t("set.skin.crt"), sub: t("set.skin.crtSub"), swatch: "linear-gradient(135deg, oklch(0.11 0.015 250) 0 40%, oklch(0.85 0.12 190) 40% 70%, oklch(0.8 0.13 75) 70%)" },
  ];
  const toggle = (id: string, on: boolean, label: string, sub: string) => `
    <div class="set-row">
      <div><div class="set-label">${esc(label)}</div><div class="set-sub">${esc(sub)}</div></div>
      <button class="set-toggle ${on ? "on" : ""}" id="${id}" role="switch" aria-checked="${on}" aria-label="${esc(label)}">
        <span class="knob"></span><span class="set-state">${on ? t("set.on") : t("set.off")}</span>
      </button>
    </div>`;
  return `
    <div class="shelf">
      <div class="shelf-head">
        <div style="display:flex;align-items:center;gap:18px">
          <button class="backbtn" data-go="home">&#8592;</button>
          <div>
            <div class="shelf-title">${esc(t("set.title"))}</div>
            <div class="shelf-meta">${esc(t("set.saved"))}</div>
          </div>
        </div>
      </div>
      <div class="settings-wrap">
        ${accountCard()}
        <section class="set-card">
          <div class="mono-label">${t("set.start")}</div>
          <div class="set-row">
            <div><div class="set-label">${esc(t("set.startPage"))}</div><div class="set-sub">${esc(t("set.startPageSub"))}</div></div>
            <div class="seg">
              ${START_PAGES.map((p) => `<button class="seg-btn ${settings.startPage === p ? "on" : ""}" data-startpage="${p}">${esc(t(`set.page.${p}` as "set.page.home"))}</button>`).join("")}
            </div>
          </div>
          ${toggle("set-autostart", autostartOn, t("set.autostart"), t("set.autostartSub"))}
          <div class="${autostartOn ? "" : "dim"}">${toggle("set-trayStart", settings.startInTray, t("set.trayStart"), t("set.trayStartSub"))}</div>
          ${toggle("set-localServices", settings.localServices, t("set.localServices"), t("set.localServicesSub"))}
        </section>
        <section class="set-card">
          <div class="mono-label">${t("set.a11y")}</div>
          <div class="set-row">
            <div><div class="set-label">${esc(t("set.scale"))}</div><div class="set-sub">${esc(t("set.scaleSub"))}</div></div>
            <div class="seg">
              ${UI_SCALES.map((n) => `<button class="seg-btn ${settings.uiScale === n ? "on" : ""}" data-uiscale="${n}">${Math.round(n * 100)} %</button>`).join("")}
            </div>
          </div>
          <div class="set-row">
            <div><div class="set-label">${esc(t("set.cvd"))}</div><div class="set-sub">${esc(t("set.cvdSub"))}</div></div>
            <div class="seg">
              ${CVD_MODES.map((m) => `<button class="seg-btn ${settings.cvd === m ? "on" : ""}" data-cvd="${m}">${esc(t(`set.cvd.${m}` as "set.cvd.std"))}</button>`).join("")}
            </div>
          </div>
          ${toggle("set-motion", settings.reducedMotion || osReducedMotion(), t("set.motion"), osReducedMotion() ? t("set.motionOs") : t("set.motionSub"))}
          ${toggle("set-calmFx", settings.calmFx, t("set.calm"), t("set.calmSub"))}
        </section>
        <section class="set-card">
          <div class="mono-label">${t("set.dl")}</div>
          <div class="set-row">
            <div><div class="set-label">${esc(t("set.libraries"))}</div><div class="set-sub">${esc(t("set.librariesSub"))}</div>
              ${settings.libraries.map((d, i) => `<div class="set-lib"><code>${esc(d)}</code><button class="pillbtn" data-rmlib="${i}">${esc(t("set.removeLib"))}</button></div>`).join("")}
            </div>
            <button class="pillbtn" id="dl-addlib">${esc(t("dl.addDir"))}</button>
          </div>
          <div class="set-row">
            <div><div class="set-label">${esc(t("set.dlLimit"))}</div><div class="set-sub">${esc(t("set.dlLimitSub"))}</div></div>
            <div class="seg">
              ${DL_LIMITS.map((n) => `<button class="seg-btn ${settings.dlLimitMBs === n ? "on" : ""}" data-dllimit="${n}">${n ? `${n} MO/S` : esc(t("set.dlUnlimited"))}</button>`).join("")}
            </div>
          </div>
          ${toggle("set-dlDuringPlay", settings.dlDuringPlay, t("set.dlDuringPlay"), t("set.dlDuringPlaySub"))}
          ${toggle("set-lowBandwidth", settings.lowBandwidth, t("set.eco"), t("set.ecoSub", { n: ECO_LIMIT_MBS }))}
          <div class="set-row" id="set-cache">
            <div><div class="set-label">${esc(t("cache.title"))}</div><div class="set-sub">${esc(t("cache.sub"))}</div></div>
            ${cacheAsk ? "" : `<button class="pillbtn" id="cache-clear" ${cacheInfo && cacheInfo.files && !activeJob() ? "" : "disabled"}>${esc(cacheInfo ? (cacheInfo.files ? t("cache.btn", { n: fmtBytes(cacheInfo.bytes) }) : t("cache.empty")) : "…")}</button>`}
          </div>
          ${cacheAsk ? `<div class="acc-confirm" role="alertdialog" aria-labelledby="cache-q">
            <div id="cache-q" class="set-label">${esc(t("cache.confirmQ", { n: fmtBytes(cacheInfo?.bytes ?? 0), f: cacheInfo?.files ?? 0 }))}</div>
            <div class="set-sub">${esc(t("cache.confirmSub"))}</div>
            <div class="acc-btns"><button class="pillbtn" id="cache-cancel">${esc(t("acc.cancel"))}</button><button class="pillbtn danger" id="cache-yes">${esc(t("cache.yes"))}</button></div>
          </div>` : ""}
        </section>
        <section class="set-card">
          <div class="mono-label">${t("set.lang")}</div>
          <div class="seg">
            <button class="seg-btn ${lang === "fr" ? "on" : ""}" data-setlang="fr">Français</button>
            <button class="seg-btn ${lang === "en" ? "on" : ""}" data-setlang="en">English</button>
          </div>
        </section>
        <section class="set-card">
          <div class="mono-label">${t("set.skin")}</div>
          <div class="skin-grid">
            ${skins
              .map(
                (s) => `
              <button class="skin-tile ${settings.skin === s.id ? "on" : ""}" data-setskin="${s.id}">
                <span class="skin-swatch" style="background:${s.swatch}"></span>
                <span class="skin-name">${esc(s.name)}</span>
                <span class="set-sub">${esc(s.sub)}</span>
              </button>`,
              )
              .join("")}
          </div>
        </section>
        <section class="set-card">
          <div class="mono-label">${t("set.prefs")}</div>
          ${toggle("set-sound", settings.sound, t("set.sound"), t("set.soundSub"))}
          <div class="set-row ${settings.sound ? "" : "dim"}">
            <div><div class="set-label">${esc(t("set.volume"))}</div></div>
            <input type="range" id="set-volume" min="0" max="100" step="5" value="${Math.round(settings.volume * 100)}" ${settings.sound ? "" : "disabled"} aria-label="${esc(t("set.volume"))}" />
          </div>
          ${SOUND_CATS.map(
            (c) => `<div class="set-row sub ${settings.sound ? "" : "dim"}">
            <div><div class="set-label">${esc(t(`set.vol.${c}` as "set.vol.ui"))}</div><div class="set-sub">${esc(t(`set.vol.${c}Sub` as "set.vol.uiSub"))}</div></div>
            <input type="range" min="0" max="100" step="5" data-volcat="${c}" value="${Math.round(settings.vol[c] * 100)}" ${settings.sound ? "" : "disabled"} aria-label="${esc(t(`set.vol.${c}` as "set.vol.ui"))}" />
          </div>`,
          ).join("")}
          ${toggle("set-dev", settings.dev, t("set.dev"), t("set.devSub"))}
          <div class="set-row">
            <div><div class="set-label">${esc(t("set.veille"))}</div><div class="set-sub">${esc(t("set.veilleSub"))}</div></div>
            <div class="seg">
              ${VEILLE_CHOICES.map(
                (m) => `<button class="seg-btn ${settings.veilleMin === m ? "on" : ""}" data-setveille="${m}">${m ? `${m} MIN` : esc(t("set.never"))}</button>`,
              ).join("")}
            </div>
          </div>
        </section>
        <section class="set-card">
          <div class="mono-label">${t("set.notif")}</div>
          ${toggle("set-nt-download", settings.notif.download, t("set.nt.download"), t("set.nt.downloadSub"))}
          ${toggle("set-nt-message", settings.notif.message, t("set.nt.message"), t("set.nt.messageSub"))}
          ${toggle("set-nt-card", settings.notif.card, t("set.nt.card"), t("set.nt.cardSub"))}
          ${toggle("set-nt-security", settings.notif.security, t("set.nt.security"), t("set.nt.securitySub"))}
          <div class="set-row"><div><div class="set-label">${esc(t("set.nt.test"))}</div></div><button class="pillbtn" id="set-nt-test">${esc(t("set.nt.testBtn"))}</button></div>
        </section>
        <div class="set-sub" style="text-align:center;margin-top:4px">${esc(t("set.about"))}</div>
      </div>
    </div>`;
}

/** The one next step for an edition (PLAY / PAIR / RENEW / FETCH / WRITE /
 *  BUY) — shared by the detail screen and the shelf preview pane. */
function actionFor(e: OnchainEdition, g: Game | undefined, ownedTok: { tokenId: string }[], can: boolean): { action: string; hint: string } {
  if (can && g) {
    return {
      action: `<button class="cta" data-play="${esc(g.cartridge.mount_point)}">▶ &nbsp;PLAY</button>`,
      hint: t("hint.play"),
    };
  }
  if (g && (g.verdict === "unpaired" || !isOurs(g))) {
    return {
      action: `<button class="cta violet" data-pair="${esc(g.cartridge.mount_point)}">${t("act.pair")}</button>`,
      hint: t("hint.pair"),
    };
  }
  if (g && g.verdict === "expired" && isOurs(g)) {
    return {
      action: `<button class="cta violet" data-pair="${esc(g.cartridge.mount_point)}">${t("act.renew")}</button>`,
      hint: t("hint.renew"),
    };
  }
  const job = jobFor(e);
  if (job && job.kind === "download" && job.phase !== "done") {
    return {
      action: `<button class="cta" data-go="downloads">${t("dl.inProgress", { p: dlPercent(job) })}</button>`,
      hint: t("dl.hintProgress"),
    };
  }
  const hasBuild = Boolean(g?.cartridge.has_build || libraryBuildFor(e));
  if ((g || ownedTok.length) && !hasBuild) {
    return {
      action: `<button class="cta" data-dlopen="${esc(e.editionId)}">${t("dl.btn")}</button>`,
      hint: t("dl.hintDownload"),
    };
  }
  if (ownedTok.length) {
    return {
      action: `<button class="cta violet" data-install="${esc(e.editionId)}" data-token="${esc(ownedTok[0].tokenId)}">${t("act.write")}</button>`,
      hint: t("hint.write", { id: ownedTok[0].tokenId }),
    };
  }
  return {
    action: `<button class="cta sunset" id="buy-btn" data-buy-edition="${esc(e.editionId)}">${t("act.buy", { p: formatEth(e.priceWei) })}</button>`,
    hint: t("hint.buy"),
  };
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

  const { action, hint } = actionFor(e, g, ownedTok, can);

  // Provenance (subgraph page on the web app): the licence on the card,
  // otherwise every licence of this edition the library address owns.
  const provIds = g?.ticket ? [g.ticket.tokenId] : ownedTok.map((o) => o.tokenId);
  const provRow = provIds
    .filter((id) => /^\d{1,12}$/.test(id))
    .map((id) => `<button class="pillbtn" data-prov="${esc(id)}" title="${esc(t("det.provTitle", { id }))}">📜 PROVENANCE #${esc(id)} ↗</button>`)
    .join("");

  let marketRow = "";
  if (g?.ticket && isOurs(g) && g.verdict === "authentic" && !resold && e.resellable) {
    if (listed && m) {
      marketRow = `<button class="pillbtn" data-unlist="${esc(g.ticket.tokenId)}">🏷 LISTED ${formatEth(m.price)} ETH — UNLIST ↗</button>`;
    } else if (state.selling === g.ticket.tokenId) {
      marketRow = `
        <input class="aura-input" id="sell-price" placeholder="${t("det.pricePlaceholder")}" style="width:8rem" />
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
        <div class="hero-art" style="${artFor(e.editionId)}">
          <div class="artnote">${t("det.boxArt", { id: esc(e.editionId) })}</div>
          <div class="sheen"></div>
        </div>
      </div>
      <div class="detail-right">
        <div class="detail-kicker">${esc(e.studio.toUpperCase())} &nbsp;&#183;&nbsp; ${e.resellable ? `ROYALTIES ${e.royaltyBps / 100}%` : "NO RESALE"} &nbsp;&#183;&nbsp; ${e.minted}/${e.supply} MINTED</div>
        <div class="detail-title">${esc(e.title)}</div>
        <div class="detail-blurb">${esc(BLURBS[e.editionId] ?? t("det.blurb"))}</div>
        <div class="stat-row">
          <div class="stat"><div class="k">LICENCE CARD</div><div class="v">${
            g?.ticket ? `#${esc(g.ticket.tokenId)} · ${esc(short(g.ticket.ownerAddress, 6))}` : ownedTok.length ? ownedTok.map((o) => `#${esc(o.tokenId)}`).join(" · ") : "—"
          }</div></div>
          <div class="stat"><div class="k">CARTRIDGE</div><div class="v">${g ? `${esc(g.cartridge.mount_point)} · ${g.verdict.toUpperCase()}` : t("det.notInserted")}</div></div>
          <div class="stat"><div class="k">${g?.ticket && g.verdict === "authentic" ? "EXPIRES" : "BUILD CID"}</div><div class="v">${
            g?.ticket && g.verdict === "authentic" ? new Date(g.ticket.expiresAt * 1000).toLocaleDateString(locale()) : short(e.buildCid, 8)
          }</div></div>
        </div>
        ${resold && m ? `<div class="errbox">${t("det.resold", { a: short(m.owner) })}</div>` : ""}
        ${settings.dev ? `<div class="debug" style="margin-top:14px">ed. #${esc(e.editionId)} · game #${esc(e.gameId)} · studio #${esc(e.studioId)} · chain ${CHAIN.id} · cid ${esc(e.buildCid)}</div>` : ""}
        <div class="detail-actions">
          ${action}
          <div class="detail-hint">${esc(hint)}</div>
          <div style="flex-basis:100%;display:flex;gap:8px;flex-wrap:wrap">${marketRow}${provRow}${g?.cartridge.has_build || libraryBuildFor(e) ? `<button class="pillbtn" data-repair="${esc(e.editionId)}">${t("dl.verify")}</button>` : ""}</div>
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

  let headline = t("ins.slot");
  let sub = t("ins.slotSub");
  let steps: { label: string; st: "idle" | "run" | "ok" | "fail"; note: string }[] = [];
  let extra = "";

  if (inst) {
    headline = inst.stage === 0 ? t("ins.choose") : t("ins.writing");
    sub = t("ins.writeSub");
    steps = [
      { label: "DETECT CARD", st: inst.stage >= 1 ? "ok" : "run", note: inst.stage >= 1 ? "SELECTED" : "CHOOSE BELOW" },
      { label: "CHECK LICENCE", st: inst.stage === 1 ? "run" : inst.stage > 1 ? "ok" : "idle", note: inst.stage > 1 ? "OK" : inst.stage === 1 ? "…" : "—" },
      { label: "WRITE KEY", st: inst.stage === 2 ? "run" : inst.stage > 2 ? "ok" : "idle", note: inst.stage > 2 ? "DONE" : inst.stage === 2 ? "…" : "—" },
      { label: "PAIR MACHINE", st: inst.stage >= 3 ? "run" : "idle", note: inst.stage >= 3 ? "NEXT" : "—" },
    ];
    if (inst.stage === 0) {
      extra = `
        <p style="margin-top:18px"><label class="slot-dim">${t("ins.licenceNo")}
          <input class="aura-input" id="install-token" inputmode="numeric" placeholder="ex. 2" value="${esc(inst.tokenId)}" style="width:6rem;margin-left:8px" /></label></p>
        <div class="vol-list">
          ${
            inst.volumes.length
              ? inst.volumes
                  .map(
                    (v) => `<button class="pillbtn" data-volume="${esc(v.mount_point)}">💾 ${esc(v.volume_label || "CARD")} — ${esc(v.mount_point)}${v.has_gamevault ? " · REWRITE" : ""}</button>`,
                  )
                  .join("")
              : `<span class="slot-dim">${t("ins.noCard")}</span>`
          }
        </div>
        ${inst.status ? `<div class="errbox">${esc(inst.status)}</div>` : ""}`;
    }
  } else if (p) {
    headline = t("ins.sigRequired");
    sub = t("ins.sigSub");
    steps = [
      { label: "DETECT CARD", st: "ok", note: "SEATED" },
      { label: "READ LICENCE BLOCK", st: "ok", note: `#${esc(g?.ticket?.tokenId ?? "?")}` },
      { label: "OWNER SIGNATURE", st: "run", note: "WAITING…" },
      { label: "UNLOCK TITLE", st: "idle", note: "—" },
    ];
    extra = `
      <div class="qr-zone">
        <img src="${p.qrDataUrl}" alt="QR" />
        <div class="qr-note">${esc(t("ins.qrNote"))}
          <div style="margin-top:10px"><button class="pillbtn" id="open-pair-url">OPEN IN BROWSER ↗</button></div>
        </div>
      </div>`;
  } else if (g) {
    headline = t("ins.seated");
    sub = t("ins.seatedSub");
    steps = [
      { label: "DETECT CARD", st: "ok", note: esc(g.cartridge.mount_point) },
      { label: "READ LICENCE BLOCK", st: g.ticket ? "ok" : "fail", note: g.ticket ? `#${esc(g.ticket.tokenId)}` : "UNREADABLE" },
      { label: "VERIFY SIGNATURE", st: g.verdict === "authentic" ? "ok" : g.verdict === "unpaired" ? "run" : "fail", note: g.verdict.toUpperCase() },
      { label: "UNLOCK TITLE", st: playableNow(editionFor(g) ?? ({ editionId: "" } as OnchainEdition)) ? "ok" : "idle", note: isOurs(g) ? "THIS MACHINE" : "PAIR NEEDED" },
    ];
  }

  return `
    <div class="insert">
      <div class="reader">
        ${cardIn ? `<div class="lic-card"><div class="lic-head"><div class="lic-brand">AURA-64 LICENCE</div><div class="lic-chip"></div></div><div class="lic-art" style="${artFor(e?.editionId ?? state.sel ?? "1")}"></div><div class="lic-title">${esc(title)}</div><div class="lic-id">${g?.ticket ? `N° ${esc(g.ticket.tokenId)} · GV-${esc(g.ticket.tokenId.padStart(4, "0"))}-${esc((state.sel ?? "?").padStart(2, "0"))}` : "GV-????"}</div></div>` : ""}
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
          <button class="pillbtn" data-go="${state.sel ? "detail" : "home"}">${state.sel ? t("ins.gamePage") : "HOME"}</button>
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
          <button class="cta amber" id="err-retry">${t("err.tryAgain")}</button>
          <button class="cta amber-ghost" data-go="home">${t("err.home")}</button>
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
      <iframe src="${GAME_URL}" title="game"></iframe>
    </div>`;
}

// ── Render ────────────────────────────────────────────────────

const SCREENS: Record<Screen, () => string> = {
  boot: bootView,
  home: homeView,
  shelf: shelfView,
  detail: detailView,
  insert: insertView,
  friends: friendsView,
  settings: settingsView,
  downloads: downloadsView,
  error: errorView,
};

/** index.html chrome (outside the render() tree) — re-applied on language change. */
function applyStaticI18n(): void {
  const label = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  label("nav-home", t("nav.home"));
  label("nav-shelf", t("nav.shelf"));
  label("nav-friends", t("nav.friends"));
  label("nav-downloads", t("nav.downloads"));
  const gear = document.getElementById("nav-settings");
  if (gear) {
    gear.setAttribute("aria-label", t("nav.settings"));
    gear.title = t("nav.settings");
  }
  const store = document.getElementById("store-btn");
  if (store) store.title = t("top.store.title");
  const win = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.title = text;
      el.setAttribute("aria-label", text);
    }
  };
  win("win-min", t("win.min"));
  win("win-max", t(maximized ? "win.restore" : "win.max"));
  win("win-close", t("win.close"));
}

// Window chrome is ours (decorations off): minimize, maximize/restore, and
// close — which, Steam-like, only hides the launcher in the notification
// area (the Rust side intercepts it); Quit lives in the tray menu.
let maximized = false;
const MAX_ICON = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
const RESTORE_ICON = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="4" width="6" height="6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 2.5h4a1 1 0 0 1 1 1v4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;

async function syncMaximized(): Promise<void> {
  try {
    maximized = await getCurrentWindow().isMaximized();
  } catch {
    return; // not running inside Tauri
  }
  const btn = document.getElementById("win-max");
  if (btn) btn.innerHTML = maximized ? RESTORE_ICON : MAX_ICON;
  applyStaticI18n();
}

function wireWindowControls(): void {
  const w = getCurrentWindow();
  document.getElementById("win-min")?.addEventListener("click", () => void w.minimize());
  document.getElementById("win-max")?.addEventListener("click", () => void w.toggleMaximize());
  document.getElementById("win-close")?.addEventListener("click", () => void w.close());
  void w.onResized(() => void syncMaximized());
  void syncMaximized();
}

function renderChrome(): void {
  // Topbar nav active state (static chrome — survives screen rebuilds)
  const navMap: Record<string, Screen[]> = {
    "nav-home": ["home"],
    "nav-shelf": ["shelf", "detail", "insert"],
    "nav-friends": ["friends"],
    "nav-downloads": ["downloads"],
    "nav-settings": ["settings"],
  };
  syncDownloadsWithGame();
  const aj = activeJob();
  const barDl = document.getElementById("bar-dl");
  if (barDl) barDl.textContent = `${settings.lowBandwidth ? `${t("set.ecoBadge")}${aj ? " · " : ""}` : ""}${aj ? `↓ ${aj.title.toUpperCase()} ${dlPercent(aj)} % · ${fmtRate(aj.netBps)}` : ""}`;
  for (const [id, screens] of Object.entries(navMap)) {
    document.getElementById(id)?.classList.toggle("active", screens.includes(state.screen));
  }
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
  const dateStr = now.toLocaleDateString(locale(), { weekday: "short", day: "2-digit", month: "short" }).toUpperCase();
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
  const vTime = document.getElementById("veille-time");
  if (vTime) vTime.innerHTML = `${hh}<span class="big-colon">:</span>${mm}`;
  const vSec = document.getElementById("veille-sec");
  if (vSec) vSec.textContent = String(now.getSeconds()).padStart(2, "0");
  const vDate = document.getElementById("veille-date");
  if (vDate) vDate.textContent = dateStr;
  checkVeille();
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

function renderUnreadBadge(): void {
  const total = Object.values(state.chat.unread).reduce((a, b) => a + b, 0);
  const btn = document.getElementById("nav-friends");
  if (btn) btn.textContent = total ? `${t("nav.friends")} · ${total}` : t("nav.friends");
}

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
    dj: Object.values(dl.jobs).map((j) => [j.id, j.phase, j.kind]),
    dli: dl.library.map((l) => l.cid + l.status + l.dir),
    dp: dl.picker ? [dl.picker.editionId, dl.picker.choice, dl.picker.options.length] : null,
    dr: dl.repair,
    ses: state.session?.address ?? null,
    lo: logoutAsk,
    au: autostartOn,
    ci: cacheInfo ? [cacheInfo.bytes, cacheInfo.files] : null,
    ca: cacheAsk,
    p: state.pairing?.status ?? null,
    i: state.installing ? [state.installing.stage, state.installing.status, state.installing.volumes.length] : null,
    a: libraryAddress(),
    t: state.ticketdOk,
    oc: state.ownerCheck,
    b: state.bootLines.map((l) => l.state + l.value).join("|"),
    pl: state.playing?.cartridge.mount_point ?? null,
    nr: state.nativeRun?.pid ?? null,
    sm: state.shelfMode,
    to: state.techOpen,
    fr: state.friends.map((f) => f.addr + f.since + (f.presence?.state ?? "") + (f.presence?.editionId ?? "")),
    inc: state.incoming,
    ch: [state.chat.active, state.chat.thread.length, state.chat.ready, state.chat.unread],
    ln: state.loans.map((l) => l.tokenId + l.user + l.expires),
    ft: state.fatal?.code ?? null,
    r: recentPlays().map((x) => [x.e.editionId, x.log.playCount, Math.floor(x.log.totalSeconds / 60)]),
  });
}

function render(): void {
  renderChrome();
  renderUnreadBadge();
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
  root.innerHTML = SCREENS[state.screen]() + pickerView() + repairView();
  wire(root);
  lastSig = sigOf();
}

function wire(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) =>
    b.addEventListener("click", () => go(b.dataset.go as Screen)),
  );
  root.querySelectorAll<HTMLButtonElement>(".gamecard, [data-edition]:not(.gamecard)").forEach((b) =>
    b.addEventListener("click", () => {
      if (!b.dataset.edition) return;
      state.sel = b.dataset.edition;
      go("detail");
    }),
  );
  document.getElementById("skip-boot")?.addEventListener("click", () => go(settings.startPage));
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
  document.getElementById("home-store")?.addEventListener("click", () => void openUrl(MARKETPLACE_URL));
  document.getElementById("friends-manage")?.addEventListener("click", () => void openUrl(`${MARKETPLACE_URL}/friends`));
  document.getElementById("friends-lend")?.addEventListener("click", () => void openUrl(`${MARKETPLACE_URL}/friends`));
  root.querySelectorAll<HTMLButtonElement>("[data-chat]").forEach((b) => b.addEventListener("click", () => void openChat(b.dataset.chat!)));
  root.querySelectorAll<HTMLButtonElement>("[data-profile]").forEach((b) =>
    b.addEventListener("click", () => {
      const a = b.dataset.profile ?? "";
      if (/^0x[0-9a-fA-F]{40}$/.test(a)) void openUrl(`${MARKETPLACE_URL}/u/${a}`);
    }),
  );
  document.getElementById("lc-send")?.addEventListener("click", () => void sendChat());
  document.getElementById("lc-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void sendChat();
  });
  document.getElementById("home-hero")?.addEventListener("click", () => {
    const g = state.games[0];
    if (!g) return;
    const ed = editionFor(g);
    state.sel = ed?.editionId ?? null;
    if (ed && playableNow(ed)) void play(g);
    // pairing and renewal are the same flow (a fresh ticket for this machine)
    else if (g.verdict === "unpaired" || g.verdict === "expired" || !isOurs(g)) void startPairing(g);
    else if (ed && !g.cartridge.has_build && !libraryBuildFor(ed)) void openDownload(ed.editionId);
    else go("detail");
  });
  document.getElementById("home-lend")?.addEventListener("click", () => void openUrl(`${MARKETPLACE_URL}/friends`));
  document.getElementById("view-grid")?.addEventListener("click", () => {
    state.shelfMode = "grid";
    localStorage.setItem("gv-shelfmode", "grid");
    render();
  });
  document.getElementById("view-storage")?.addEventListener("click", () => {
    state.shelfMode = "storage";
    localStorage.setItem("gv-shelfmode", "storage");
    render();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-reveal]").forEach((b) =>
    b.addEventListener("click", () => void invoke("reveal_folder", { path: b.dataset.reveal }).catch((err) => toast(String(err)))),
  );
  document.getElementById("view-list")?.addEventListener("click", () => {
    state.shelfMode = "list";
    localStorage.setItem("gv-shelfmode", "list");
    render();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-selrow]").forEach((b) =>
    b.addEventListener("click", () => {
      state.sel = b.dataset.selrow ?? null;
      render();
    }),
  );
  // ── Settings screen ──
  root.querySelectorAll<HTMLButtonElement>("[data-setlang]").forEach((b) =>
    b.addEventListener("click", () => {
      setLang(b.dataset.setlang as Lang);
      applySettings();
      applyStaticI18n();
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-setskin]").forEach((b) =>
    b.addEventListener("click", () => {
      settings.skin = b.dataset.setskin as Skin;
      saveSettings();
      render();
    }),
  );
  const flip = (id: string, key: "sound" | "reducedMotion" | "dev") =>
    document.getElementById(id)?.addEventListener("click", () => {
      settings[key] = !settings[key];
      saveSettings();
      render();
      if (key === "sound" && settings.sound) chimeOut();
    });
  flip("set-sound", "sound");
  flip("set-motion", "reducedMotion");
  flip("set-dev", "dev");
  wireStartup(root);
  (["download", "message", "card", "security"] as const).forEach((k) =>
    document.getElementById(`set-nt-${k}`)?.addEventListener("click", () => {
      settings.notif[k] = !settings.notif[k];
      saveSettings();
      render();
    }),
  );
  document.getElementById("set-nt-test")?.addEventListener("click", () =>
    void notify({ kind: "download", title: t("nt.dlDone", { t: "GameVault Runner" }), body: t("nt.dlDoneBody"), action: () => go("downloads") }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-rmlib]").forEach((b) =>
    b.addEventListener("click", () => {
      settings.libraries.splice(Number(b.dataset.rmlib), 1);
      saveSettings();
      void refreshLibrary().then(render);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-setveille]").forEach((b) =>
    b.addEventListener("click", () => {
      settings.veilleMin = Number(b.dataset.setveille);
      saveSettings();
      render();
    }),
  );
  root.querySelectorAll<HTMLInputElement>("[data-volcat]").forEach((r) =>
    r.addEventListener("change", () => {
      const cat = r.dataset.volcat as SoundCat;
      settings.vol[cat] = Number(r.value) / 100;
      saveSettings();
      if (cat === "cine") chimeLaunch();
      else beep([880, 1175], 0.08, 0.16, "sine", cat); // preview at the new level
    }),
  );
  document.getElementById("set-volume")?.addEventListener("change", (ev) => {
    settings.volume = Number((ev.target as HTMLInputElement).value) / 100;
    saveSettings();
    beep([880], 0.08); // preview at the new level
  });

  root.querySelectorAll<HTMLButtonElement>("[data-prov]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.prov ?? "";
      if (/^\d{1,12}$/.test(id)) void openUrl(`${MARKETPLACE_URL}/provenance/${id}`);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-lendfriend]").forEach((b) =>
    b.addEventListener("click", () => void openUrl(`${MARKETPLACE_URL}/friends`)),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-gosell]").forEach((b) =>
    b.addEventListener("click", () => {
      state.sel = b.dataset.goedition ?? state.sel;
      state.selling = b.dataset.gosell ?? null;
      go("detail"); // le flux prix/LIST vit sur la fiche
    }),
  );
  document.getElementById("tech-acc")?.addEventListener("toggle", (ev) => {
    state.techOpen = (ev.target as HTMLDetailsElement).open;
    lastSig = sigOf(); // no rebuild — the browser already toggled the pane
  });
  document.getElementById("watch-btn")?.addEventListener("click", () => {
    const addr = (document.getElementById("watch-addr") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return alert(t("alert.badAddr"));
    localStorage.setItem("gv-watch", addr);
    void forceRefresh();
  });
  document.getElementById("buy-btn")?.addEventListener("click", (ev) => {
    chimeBuy(); // le moment de gloire
    // Straight to this game's store page (new copy), not the store root.
    const ed = (ev.currentTarget as HTMLElement).dataset.buyEdition ?? "";
    void openUrl(/^\d{1,9}$/.test(ed) ? `${MARKETPLACE_URL}/game/${ed}` : MARKETPLACE_URL);
  });
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
  wireDownloads(root);
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
      if (!/^\d*\.?\d+$/.test(price)) return alert(t("alert.badPrice"));
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
  if (settings.localServices) {
    state.bootLines[3] = { ...state.bootLines[3], value: t("svc.starting"), state: "idle" };
    if (state.screen === "boot") render();
    try {
      await invoke("start_local_services");
    } catch {
      /* repo not found (installed build): ticketd is expected online */
    }
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
  void fetchFriends(); // non-blocking: the AMIS screen fills in seconds
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
      startSessionWatchdog();
    }
  } catch {
    /* command absent on an older rust build */
  }

  setTimeout(() => {
    if (state.screen === "boot") go(settings.startPage);
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
        .forEach((g) => {
          if (veilleOn) {
            hideVeille();
            if (!settings.notif.card) sfxInsert("notif"); // otherwise the slot toast plays it
          }
          void cardEvent("in", g.meta.title ?? g.cartridge.volume_label ?? "CARD", g);
        });
      state.games
        .filter((g) => !cur.has(g.cartridge.mount_point))
        .forEach((g) => void cardEvent("out", g.meta.title ?? g.cartridge.volume_label ?? "CARD", g));
    }
    state.games = newGames;
    state.lastScan = new Date().toLocaleTimeString();
    // Low-bandwidth mode: the network refreshes run 4 to 6 times rarer.
    if (scanCount % (settings.lowBandwidth ? 60 : 15) === 0) {
      void fetchOnchainCatalog(chainClient ?? undefined)
        .then((c) => {
          state.catalog = c;
        })
        .catch(() => {});
      void fetchFriends();
    }
    if (scanCount % 5 === 0) void refreshLibrary();
    if (scanCount++ % (settings.lowBandwidth ? 30 : 5) === 0) {
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

// ── Storage (P7 #3, 2026-10-10) ───────────────────────────────────────────
// Game Shelf › Storage: every place a game can live — library folders on
// this PC, and the inserted cards — with its free space, and each game's
// size, state and location. The card is the key: a key-only card says
// where its game is.
let storageSpace: Record<string, [number, number] | null> = {};

async function refreshStorageSpace(): Promise<void> {
  const paths = [...settings.libraries, ...state.games.map((g) => g.cartridge.mount_point)];
  const next: Record<string, [number, number] | null> = {};
  for (const p of paths) {
    try {
      next[p] = await invoke<[number, number] | null>("disk_space", { path: p });
    } catch {
      next[p] = null;
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(storageSpace);
  storageSpace = next;
  if (changed && state.screen === "shelf" && state.shelfMode === "storage") render();
}

const ICON_DIR = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 7h6l2 2h10v10H3z"></path></svg>`;
const ICON_CARD = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"></path><path d="M10 3v4M13 3v4"></path></svg>`;

function storageBody(): string {
  type Row = { title: string; editionId: string | null; size: number; status: string; cls: string; reveal: string | null; repair: string | null; resume: string | null };
  const sections: { kind: "dir" | "card"; name: string; path: string; reveal: string | null; rows: Row[] }[] = [];

  for (const dir of settings.libraries) {
    const rows: Row[] = dl.library
      .filter((l) => l.dir === dir)
      .map((l) => {
        const e = state.catalog.find((c) => c.buildCid === l.cid);
        const folder = l.path.replace(/[\\/][^\\/]+$/, "");
        return {
          title: e?.title ?? t("stg.unknown", { c: l.cid.slice(0, 10) }),
          editionId: e?.editionId ?? null,
          size: l.size,
          status: l.status === "installed" ? t("stg.installed") : t("stg.partial"),
          cls: l.status === "installed" ? "ok" : "warn",
          reveal: folder,
          repair: l.status === "installed" && e ? e.editionId : null,
          resume: l.status === "partial" && e ? e.buildCid : null,
        };
      });
    sections.push({ kind: "dir", name: t("dl.dirName", { d: dir }), path: dir, reveal: dir, rows });
  }
  for (const g of state.games) {
    const e = editionFor(g);
    const title = g.meta.title ?? e?.title ?? "GAME";
    const lib = libraryBuildFor(e);
    const row: Row = g.cartridge.has_build
      ? { title, editionId: e?.editionId ?? null, size: g.cartridge.build_size, status: t("stg.onCard"), cls: "ok", reveal: null, repair: e?.editionId ?? null, resume: null }
      : { title, editionId: e?.editionId ?? null, size: 0, status: lib ? t("stg.keyOnlyPc") : t("stg.keyOnly"), cls: lib ? "" : "warn", reveal: null, repair: null, resume: null };
    const m = g.cartridge.mount_point;
    sections.push({ kind: "card", name: t("dl.cardName", { d: m }), path: m, reveal: `${m.replace(/[\\/]$/, "")}\\gamevault`, rows: [row] });
  }

  const games = sections.flatMap((s) => s.rows).filter((r) => r.size > 0);
  const total = games.reduce((a, r) => a + r.size, 0);
  const summary = `<div class="stg-summary">
      <span><b>${games.length}</b> ${t("stg.games")}</span>
      <span><b>${games.length ? fmtBytes(total) : "0"}</b> ${t("stg.used")}</span>
      <span><b>${sections.length}</b> ${t("stg.places")}</span>
      <button class="pillbtn" id="dl-addlib">${t("dl.addDir")}</button>
    </div>`;
  if (!sections.length) {
    return `<div class="stg-wrap">${summary}<div class="dl-empty">${t("stg.empty")}</div></div>`;
  }
  const section = (s: (typeof sections)[number]) => {
    const sp = storageSpace[s.path];
    const mine = s.rows.reduce((a, r) => a + r.size, 0);
    const used = sp ? sp[1] - sp[0] : 0;
    const pct = (n: number) => (sp && sp[1] ? Math.max(n > 0 ? 0.6 : 0, (n / sp[1]) * 100) : 0);
    return `
      <section class="stg">
        <div class="stg-head">
          <span class="stg-ico ${s.kind}">${s.kind === "card" ? ICON_CARD : ICON_DIR}</span>
          <div class="stg-name">
            <div class="stg-title">${esc(s.name)}</div>
            <div class="stg-sub">${sp ? esc(t("stg.space", { f: fmtBytes(sp[0]), t: fmtBytes(sp[1]) })) : esc(t("stg.spaceUnknown"))}</div>
          </div>
          ${s.reveal ? `<button class="pillbtn" data-reveal="${esc(s.reveal)}">${t("stg.open")}</button>` : ""}
        </div>
        <div class="stg-gauge" role="img" aria-label="${esc(sp ? t("stg.space", { f: fmtBytes(sp[0]), t: fmtBytes(sp[1]) }) : "")}">
          <i class="g" style="width:${pct(mine).toFixed(2)}%"></i><i class="o" style="width:${pct(Math.max(0, used - mine)).toFixed(2)}%"></i>
        </div>
        <div class="stg-legend"><span><i class="g"></i>${t("stg.lgGames", { n: fmtBytes(mine || 0) })}</span><span><i class="o"></i>${t("stg.lgOther")}</span><span><i></i>${t("stg.lgFree")}</span></div>
        ${
          s.rows.length
            ? s.rows
                .map(
                  (r) => `
          <div class="stg-row">
            <div class="dl-thumb" style="${r.editionId ? artFor(r.editionId) : ""}"></div>
            <div class="stg-rowmain"><div class="dl-item-t">${esc(r.title)}</div><div class="dl-sub ${r.cls}">${esc(r.status)}</div></div>
            <div class="stg-size">${r.size ? fmtBytes(r.size) : "—"}</div>
            <div class="stg-acts">
              ${r.resume ? `<button class="sx-btn primary" data-dlresume="${esc(r.resume)}">${t("dl.resume")}</button>` : ""}
              ${r.repair ? `<button class="sx-btn" data-repair="${esc(r.repair)}">${t("dl.verify")}</button>` : ""}
              ${r.reveal ? `<button class="sx-btn ghost" data-reveal="${esc(r.reveal)}" aria-label="${esc(t("stg.openGame"))}">${t("stg.open")}</button>` : ""}
            </div>
          </div>`,
                )
                .join("")
            : `<div class="stg-none">${t("stg.noneHere")}</div>`
        }
      </section>`;
  };
  return `<div class="stg-wrap">${summary}${sections.map(section).join("")}</div>`;
}

// ── Account & startup (P7 #2, 2026-10-10) ─────────────────────────────────
// The launcher's account is the wallet that owns the cards paired here
// (or an address only watched, read-only). Signing out forgets it on this
// machine — sessions, friends, chat, presence — but keeps the machine key
// and the cards: a paired card still plays, and pairing (or watching an
// address) brings an account back.
let logoutAsk = false;
let autostartOn = false;

function accountCard(): string {
  const watched = !state.session && localStorage.getItem("gv-watch");
  const addr = state.session?.address ?? (watched || "");
  if (!addr) {
    return `<section class="set-card">
      <div class="mono-label">${t("acc.title")}</div>
      <div class="set-row"><div><div class="set-label">${esc(t("acc.none"))}</div><div class="set-sub">${esc(t("acc.noneSub"))}</div></div></div>
    </section>`;
  }
  const confirm = logoutAsk
    ? `<div class="acc-confirm" role="alertdialog" aria-labelledby="acc-q">
        <div id="acc-q" class="set-label">${esc(t("acc.confirmQ"))}</div>
        <div class="set-sub">${esc(t("acc.confirmSub"))}</div>
        <div class="acc-btns">
          <button class="pillbtn" id="acc-cancel">${esc(t("acc.cancel"))}</button>
          <button class="pillbtn danger" id="acc-logout-yes">${esc(t("acc.logoutYes"))}</button>
        </div>
      </div>`
    : "";
  return `<section class="set-card">
    <div class="mono-label">${t("acc.title")}</div>
    <div class="set-row">
      <div style="min-width:0">
        <div class="set-label">${esc(short(addr, 6))}</div>
        <div class="set-sub">${esc(watched ? t("acc.watched") : t("acc.paired"))}</div>
      </div>
      ${logoutAsk ? "" : `<button class="pillbtn" id="acc-logout">${esc(t(watched ? "acc.forget" : "acc.logout"))}</button>`}
    </div>
    ${confirm}
  </section>`;
}

async function logout(): Promise<void> {
  const token = social?.token;
  if (token) {
    void fetch(`${TICKETD_URL}/session`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }
  social = null;
  events?.close();
  events = null;
  state.session = null;
  try {
    localStorage.removeItem("gv-session");
    localStorage.removeItem("gv-watch");
  } catch {
    /* storage blocked */
  }
  state.friends = [];
  state.incoming = 0;
  state.loans = [];
  state.owned = [];
  state.chat = { active: null, thread: [], unread: {}, ready: true };
  deviceWasActive = null;
  logoutAsk = false;
  toast(t("acc.loggedOut"));
  render();
}

async function refreshAutostart(): Promise<void> {
  try {
    autostartOn = await invoke<boolean>("plugin:autostart|is_enabled");
  } catch {
    autostartOn = false;
  }
}

/** At a Windows-startup launch, stay in the tray if asked; else show the window. */
async function showAtLaunch(): Promise<void> {
  try {
    const atStartup = await invoke<boolean>("launched_at_startup");
    if (atStartup && !settings.startInTray) await getCurrentWindow().show();
  } catch {
    /* not inside Tauri */
  }
}

function wireStartup(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-startpage]").forEach((b) =>
    b.addEventListener("click", () => {
      settings.startPage = b.dataset.startpage as StartPage;
      saveSettings();
      render();
    }),
  );
  document.getElementById("set-autostart")?.addEventListener("click", async () => {
    try {
      await invoke(autostartOn ? "plugin:autostart|disable" : "plugin:autostart|enable");
    } catch (err) {
      toast(String(err));
    }
    await refreshAutostart();
    render();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-uiscale]").forEach((b) =>
    b.addEventListener("click", () => {
      settings.uiScale = Number(b.dataset.uiscale);
      saveSettings(); // applySettings → native zoom
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-cvd]").forEach((b) =>
    b.addEventListener("click", () => {
      settings.cvd = b.dataset.cvd as Settings["cvd"];
      saveSettings();
      render();
    }),
  );
  document.getElementById("set-calmFx")?.addEventListener("click", () => {
    settings.calmFx = !settings.calmFx;
    saveSettings();
    render();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-dllimit]").forEach((b) =>
    b.addEventListener("click", () => {
      settings.dlLimitMBs = Number(b.dataset.dllimit);
      saveSettings();
      applyDownloadLimit();
      render();
    }),
  );
  document.getElementById("set-lowBandwidth")?.addEventListener("click", () => {
    settings.lowBandwidth = !settings.lowBandwidth;
    saveSettings();
    applyDownloadLimit();
    render();
  });
  if (document.getElementById("set-cache") && cacheInfo === null) void refreshCacheInfo();
  document.getElementById("cache-clear")?.addEventListener("click", () => {
    cacheAsk = true;
    render();
  });
  document.getElementById("cache-cancel")?.addEventListener("click", () => {
    cacheAsk = false;
    render();
  });
  document.getElementById("cache-yes")?.addEventListener("click", () => void clearCache());
  document.getElementById("set-dlDuringPlay")?.addEventListener("click", () => {
    settings.dlDuringPlay = !settings.dlDuringPlay;
    saveSettings();
    applyGamePolicy(); // mid-game: resume now if allowed, pause now if not
    render();
  });
  document.getElementById("set-localServices")?.addEventListener("click", () => {
    settings.localServices = !settings.localServices;
    saveSettings();
    render();
  });
  document.getElementById("set-trayStart")?.addEventListener("click", () => {
    settings.startInTray = !settings.startInTray;
    saveSettings();
    render();
  });
  document.getElementById("acc-logout")?.addEventListener("click", () => {
    logoutAsk = true;
    render();
  });
  document.getElementById("acc-cancel")?.addEventListener("click", () => {
    logoutAsk = false;
    render();
  });
  document.getElementById("acc-logout-yes")?.addEventListener("click", () => void logout());
}

// ── Notifications (P7 #1, 2026-10-10) ─────────────────────────────────────
// Steam-like DESKTOP toasts: a small AURA-64 window bottom-right of the
// screen, over every other app (src/toast.ts, sized and placed by Rust).
// A click brings the launcher back where the toast points. Inside the
// launcher, a card going in or out plays the SLOT A widget instead.
type NotifKind = "download" | "message" | "card" | "security";
interface Notif {
  kind: NotifKind;
  title: string;
  body: string;
  action?: () => void;
  out?: boolean; // card removed
}

const toastActions = new Map<string, () => void>();

/** "front" = visible and focused; "back" = visible, not focused; "tray" = hidden. */
async function windowState(): Promise<"front" | "back" | "tray"> {
  try {
    const w = getCurrentWindow();
    if (!(await w.isVisible())) return "tray";
    return (await w.isFocused()) ? "front" : "back";
  } catch {
    return "front"; // not inside Tauri (dev in a browser)
  }
}

async function notify(n: Notif): Promise<void> {
  if (!settings.notif[n.kind]) return;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (n.action) {
    toastActions.set(id, n.action);
    window.setTimeout(() => toastActions.delete(id), 60_000);
  }
  await invoke("desktop_toast", {
    payload: {
      id,
      kind: n.kind,
      kindLabel: t(`nt.${n.kind}` as "nt.download"),
      title: n.title,
      body: n.body,
      hint: n.action ? t("nt.clickHint") : undefined,
      out: n.out ?? false,
      calm: settings.calmFx || settings.reducedMotion || osReducedMotion(),
      cvd: settings.cvd,
    },
  }).catch(() => {});
}

// a click on a desktop toast: launcher back in front, then the toast's page
void listen<{ id: string }>("toast-action", (ev) => {
  void invoke("focus_main");
  const run = toastActions.get(ev.payload.id);
  toastActions.delete(ev.payload.id);
  run?.();
});

/** What the SLOT A widget says about a card. */
function cardStateLabel(g: Game | undefined): { label: string; cls: string } {
  if (!g) return { label: "SLOT EMPTY", cls: "off" };
  const ed = editionFor(g);
  if (ed && playableNow(ed)) return { label: "READY · TICKET " + ticketDaysLeft(g), cls: "" };
  if (g.verdict === "unpaired" || !isOurs(g)) return { label: "PAIR THIS MACHINE", cls: "warn" };
  if (g.verdict === "expired") return { label: t("home.ticketExpired"), cls: "warn" };
  if (!g.cartridge.has_build && !libraryBuildFor(ed)) return { label: t("dl.toDownload"), cls: "warn" };
  return { label: g.verdict.toUpperCase(), cls: "warn" };
}

/** The SLOT A widget slides in, the card drops into the slot (or rises out). */
function slotToast(kind: "in" | "out", g: Game | undefined, title: string): void {
  const layer = document.getElementById("overlay-layer");
  if (!layer) return;
  layer.querySelectorAll(".slot-toast").forEach((x) => x.remove());
  const st = kind === "in" ? cardStateLabel(g) : { label: "CARD EJECTED", cls: "off" };
  const where = g ? `${g.cartridge.mount_point} · ${g.cartridge.has_build ? "BUILD SUR LA CARTE" : libraryBuildFor(editionFor(g)) ? "JEU SUR CE PC" : "CLÉ SEULE"}` : "";
  const el = document.createElement("div");
  el.className = `card-widget slot-toast ${kind}`;
  el.innerHTML = `
    <div class="mono-label" style="font-size:10px;letter-spacing:0.26em">SLOT A · ${kind === "in" ? "CARD SEATED" : "CARD EJECTED"}</div>
    <div class="cw-row">
      <span class="st-reader" aria-hidden="true"><span class="st-card"></span><span class="st-slot"><span class="st-slot-line"></span></span><span class="st-led"></span></span>
      <div style="min-width:0">
        <div class="cw-title">${esc(title)}</div>
        <div class="cw-state ${st.cls}"><span class="cw-led"></span>${esc(st.label)}</div>
        ${where ? `<div class="cw-dim">${esc(where)}</div>` : ""}
      </div>
    </div>`;
  layer.appendChild(el);
  if (kind === "in") sfxInsert("notif");
  else beep([660, 440], 0.09, 0.16, "sine", "notif");
  slotEvent = { kind, until: Date.now() + 3000 };
  window.setTimeout(() => el.classList.add("bye"), 3400);
  window.setTimeout(() => el.remove(), 3900);
}

/** A card went in or out: the SLOT A widget in front, a desktop toast otherwise. */
async function cardEvent(kind: "in" | "out", title: string, g?: Game): Promise<void> {
  if (!settings.notif.card) return;
  if ((await windowState()) === "front") {
    slotToast(kind, g, title);
    return;
  }
  void notify({
    kind: "card",
    title: t(kind === "in" ? "nt.cardIn" : "nt.cardOut"),
    body: g && kind === "in" ? `${title} · ${cardStateLabel(g).label}` : title,
    out: kind === "out",
    action: () => go("home"),
  });
}

// This machine's place on the account (2 machines max): pairing another
// machine elsewhere can release it — say so instead of failing silently
// at the next launch.
let deviceWasActive: boolean | null = null;
async function checkDeviceSlot(): Promise<void> {
  const wallet = libraryAddress();
  if (!wallet || !state.devicePubKey) return;
  try {
    const res = await fetch(`${TICKETD_URL}/devices/${wallet}/${state.devicePubKey}/status`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return;
    const active = ((await res.json()) as { active: boolean }).active;
    if (deviceWasActive === true && !active) {
      chimeOut();
      void notify({
        kind: "security",
        title: t("nt.secTitle"),
        body: t("nt.secBody"),
        action: () => go("home"),
      });
    }
    deviceWasActive = active;
  } catch {
    /* offline: nothing to say */
  }
}

// ── Download manager (UI side of src-tauri/src/download.rs) ───────────────
// The card is the key; the game lives on this PC (library folders, default)
// or on the card if it has room. Downloads run in Rust (parallel ranges,
// verified chunks, server first then IPFS mirrors, resumable); this side
// queues them, shows progress and repairs.
interface DlJob {
  id: string; // = cid
  kind: "download" | "repair";
  editionId: string;
  title: string;
  cid: string;
  sha256: string;
  destKind: "library" | "card";
  dest: string;
  phase: string; // queued | prepare | download | read | fetch | final | paused | done | error | cancelled
  done: number;
  total: number;
  netBps: number;
  diskBps: number;
  chunks: string;
  source: string;
  mirrorChunks: number;
  error: string;
  log: string[];
  netHist: number[];
  diskHist: number[];
  autoPaused?: boolean; // paused because a game started; resumes after it
}
interface LibraryEntry {
  dir: string;
  cid: string;
  path: string;
  size: number;
  status: "installed" | "partial";
}
interface DestOption {
  kind: "library" | "card" | "create"; // create = a first GameVault folder, made on confirm
  dest: string;
  label: string;
  free: number | null;
  total: number | null;
  folder: string; // the exact game folder the build lands in
}
const ACTIVE_PHASES = ["prepare", "download", "read", "fetch", "final"];
const dl = {
  jobs: {} as Record<string, DlJob>,
  library: [] as LibraryEntry[],
  picker: null as null | { editionId: string; size: number | null; options: DestOption[]; choice: string },
  repair: null as string | null,
};

const fmtBytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2).replace(".", ",")} GO` : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} MO` : `${Math.max(1, Math.round(n / 1e3))} KO`;
const fmtRate = (bps: number): string => `${fmtBytes(bps)}/S`;

function libraryBuildFor(e: OnchainEdition | undefined): LibraryEntry | undefined {
  return e ? dl.library.find((l) => l.cid === e.buildCid && l.status === "installed") : undefined;
}

async function refreshLibrary(): Promise<void> {
  try {
    dl.library = await invoke<LibraryEntry[]>("library_scan", { dirs: settings.libraries });
  } catch {
    dl.library = [];
  }
  // A part file left by a pause or a restart = a resumable job.
  for (const l of dl.library.filter((x) => x.status === "partial")) {
    if (dl.jobs[l.cid]) continue;
    const e = state.catalog.find((c) => c.buildCid === l.cid);
    if (!e) continue;
    dl.jobs[l.cid] = newJob(e, "download", "library", l.dir, "paused");
  }
}

function newJob(e: OnchainEdition, kind: DlJob["kind"], destKind: DlJob["destKind"], dest: string, phase = "queued"): DlJob {
  return {
    id: e.buildCid, kind, editionId: e.editionId, title: e.title, cid: e.buildCid, sha256: e.buildSha256, destKind, dest, phase,
    done: 0, total: 0, netBps: 0, diskBps: 0, chunks: "", source: "", mirrorChunks: 0, error: "", log: [], netHist: [], diskHist: [],
  };
}

const activeJob = (): DlJob | undefined => Object.values(dl.jobs).find((j) => ACTIVE_PHASES.includes(j.phase));
const jobFor = (e: OnchainEdition | undefined): DlJob | undefined => (e ? dl.jobs[e.buildCid] : undefined);

/** One job at a time: the next queued one starts when the line is free. */
function pump(): void {
  if (activeJob() || holdForGame()) return;
  const next = Object.values(dl.jobs).find((j) => j.phase === "queued");
  if (!next) return;
  next.phase = "prepare";
  next.error = "";
  const cmd = next.kind === "repair" ? "dl_repair" : "dl_start";
  invoke(cmd, { id: next.id, cid: next.cid, sha256: next.sha256, destKind: next.destKind, dest: next.dest, title: next.title, edition: next.editionId }).catch((err) => {
    next.phase = "error";
    next.error = String(err);
    render();
    pump();
  });
  render();
}

async function openDownload(editionId: string): Promise<void> {
  const e = state.catalog.find((c) => c.editionId === editionId);
  if (!e) return;
  let size: number | null = null;
  try {
    const r = await fetch(`${TICKETD_URL}/build/${e.buildCid}/manifest`);
    if (r.ok) size = Number(((await r.json()) as { size: number }).size) || null;
  } catch {
    /* size unknown: the Rust side still checks the space */
  }
  const space = async (p: string) => {
    try {
      return await invoke<[number, number] | null>("disk_space", { path: p });
    } catch {
      return null;
    }
  };
  const preview = async (kind: string, dest: string) => {
    try {
      return await invoke<string>("dl_preview", { destKind: kind === "create" ? "library" : kind, dest, cid: e.buildCid, title: e.title });
    } catch {
      return dest;
    }
  };
  const options: DestOption[] = [];
  for (const dir of settings.libraries) {
    const s = await space(dir);
    options.push({ kind: "library", dest: dir, label: dir, free: s?.[0] ?? null, total: s?.[1] ?? null, folder: await preview("library", dir) });
  }
  // No game folder yet: propose creating GameVault on the roomiest drive.
  if (!settings.libraries.length) {
    const d = await invoke<[string, number, number] | null>("default_library").catch(() => null);
    if (d) options.push({ kind: "create", dest: d[0], label: d[0], free: d[1], total: d[2], folder: await preview("create", d[0]) });
  }
  const card = cardForEdition(editionId);
  if (card) {
    const s = await space(card.cartridge.mount_point);
    const m = card.cartridge.mount_point;
    options.push({ kind: "card", dest: m, label: m, free: s?.[0] ?? null, total: s?.[1] ?? null, folder: `${m.replace(/[\\/]$/, "")}\\gamevault` });
  }
  const fits = (o: DestOption) => size === null || o.free === null || o.free >= size * 1.01;
  const first = options.find(fits);
  dl.picker = { editionId, size, options, choice: first ? `${first.kind}|${first.dest}` : "" };
  render();
}

async function addLibraryFolder(): Promise<void> {
  try {
    const picked = await invoke<string | null>("plugin:dialog|open", { options: { directory: true, multiple: false, title: t("dl.pickTitle") } });
    if (picked && !settings.libraries.includes(picked)) {
      settings.libraries.push(picked);
      saveSettings();
      await refreshLibrary();
    }
  } catch (err) {
    toast(String(err));
  }
  if (dl.picker) await openDownload(dl.picker.editionId);
  else render();
}

async function confirmDownload(): Promise<void> {
  const p = dl.picker;
  const e = p ? state.catalog.find((c) => c.editionId === p.editionId) : undefined;
  if (!p || !e || !p.choice) return;
  const [kind, ...rest] = p.choice.split("|");
  let dest = rest.join("|");
  if (kind === "create") {
    try {
      dest = await invoke<string>("create_library", { path: dest });
      settings.libraries.push(dest);
      saveSettings();
    } catch (err) {
      toast(String(err));
      return;
    }
  }
  dl.jobs[e.buildCid] = newJob(e, "download", kind === "card" ? "card" : "library", dest);
  dl.picker = null;
  state.screen = "downloads";
  pump();
  render();
}

function startRepair(editionId: string): void {
  const e = state.catalog.find((c) => c.editionId === editionId);
  if (!e) return;
  const card = cardForEdition(editionId);
  const lib = libraryBuildFor(e);
  if (card?.cartridge.has_build) dl.jobs[e.buildCid] = newJob(e, "repair", "card", card.cartridge.mount_point);
  else if (lib) dl.jobs[e.buildCid] = newJob(e, "repair", "library", lib.dir);
  else return;
  dl.repair = e.buildCid;
  pump();
  render();
}

function pauseJob(id: string): void {
  void invoke("dl_pause", { id });
}

function resumeJob(id: string): void {
  const j = dl.jobs[id];
  if (!j) return;
  j.autoPaused = false;
  j.phase = "queued";
  pump();
  render();
}

function cancelJob(id: string): void {
  const j = dl.jobs[id];
  if (!j) return;
  if (ACTIVE_PHASES.includes(j.phase)) {
    void invoke("dl_cancel", { id });
    return;
  }
  if (j.phase === "paused" && j.destKind === "library") {
    // the part file must go too: a short start the cancel flag stops at once
    j.phase = "prepare";
    void invoke("dl_start", { id, cid: j.cid, sha256: j.sha256, destKind: j.destKind, dest: j.dest, title: j.title, edition: j.editionId }).then(() => invoke("dl_cancel", { id }));
    return;
  }
  delete dl.jobs[id];
  render();
}

function chunkMap(chunks: string, id: string): string {
  return `<div class="dlm" id="dl-map-${id}">${[...chunks].map((c) => `<i class="c-${c}"></i>`).join("")}</div>`;
}

function speedGraph(j: DlJob): string {
  const W = 246, H = 62;
  const hist = (h: number[]) => {
    const max = Math.max(1, ...j.netHist, ...j.diskHist);
    const pts = h.slice(-60);
    return pts.map((v, i) => `${((i / Math.max(1, pts.length - 1)) * W).toFixed(1)},${(H - 2 - (v / max) * (H - 8)).toFixed(1)}`).join(" ");
  };
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-label="${esc(t("dl.graph"))}">
    <path d="M0 ${H - 0.5}H${W}" stroke="rgba(200,225,255,0.12)"></path>
    <polyline points="${hist(j.netHist)}" fill="none" stroke="oklch(0.86 0.1 200)" stroke-width="2"></polyline>
    <polyline points="${hist(j.diskHist)}" fill="none" stroke="oklch(0.85 0.11 310)" stroke-width="1.6" stroke-dasharray="4 3"></polyline>
  </svg>`;
}

function dlPercent(j: DlJob): number {
  return j.total ? Math.min(100, Math.floor((j.done / j.total) * 100)) : 0;
}

function phaseLabel(j: DlJob): string {
  if (j.phase === "paused" && j.autoPaused) return t("dl.ph.pausedGame");
  if (j.phase === "queued" && holdForGame()) return t("dl.ph.queuedGame");
  return t(`dl.ph.${j.phase}` as "dl.ph.download");
}

// ── While a game runs (P7 #4): downloads pause, then resume by themselves,
// unless the player allowed them during play.
const inGame = (): boolean => Boolean(state.playing || state.nativeRun);
const holdForGame = (): boolean => inGame() && !settings.dlDuringPlay;
let wasInGame = false;

/** One rule: while held, what runs pauses (remembered); otherwise what a
 *  game paused resumes. Applied when a session starts or ends, and when
 *  the setting changes mid-game. */
function applyGamePolicy(): void {
  if (holdForGame()) {
    for (const j of Object.values(dl.jobs)) {
      if (ACTIVE_PHASES.includes(j.phase)) {
        j.autoPaused = true;
        pauseJob(j.id);
      }
    }
    return;
  }
  for (const j of Object.values(dl.jobs)) {
    if (j.autoPaused) {
      j.autoPaused = false;
      if (j.phase === "paused") j.phase = "queued";
    }
  }
  pump();
}

function syncDownloadsWithGame(): void {
  const now = inGame();
  if (now === wasInGame) return;
  wasInGame = now;
  applyGamePolicy();
}

const ECO_LIMIT_MBS = 2;
function effectiveLimitMBs(): number {
  if (!settings.lowBandwidth) return settings.dlLimitMBs;
  return settings.dlLimitMBs ? Math.min(settings.dlLimitMBs, ECO_LIMIT_MBS) : ECO_LIMIT_MBS;
}
function applyDownloadLimit(): void {
  void invoke("dl_set_limit", { bps: effectiveLimitMBs() * 1_000_000 }).catch(() => {});
}

// ── Cache (P7 B) ─────────────────────────────────────────────────────────
let cacheInfo: { bytes: number; files: number } | null = null;
let cacheAsk = false;
async function refreshCacheInfo(): Promise<void> {
  try {
    cacheInfo = await invoke<{ bytes: number; files: number }>("cache_info", { dirs: settings.libraries });
  } catch {
    cacheInfo = { bytes: 0, files: 0 }; // never null after a try: no refetch loop
  }
  if (state.screen === "settings") render();
}
async function clearCache(): Promise<void> {
  try {
    const r = await invoke<{ bytes: number; files: number }>("clear_cache", { dirs: settings.libraries });
    // interrupted downloads are gone: so are their resumable jobs
    for (const j of Object.values(dl.jobs)) if (j.phase === "paused" && j.kind === "download") delete dl.jobs[j.id];
    toast(t("cache.cleared", { n: fmtBytes(r.bytes), f: r.files }));
  } catch (err) {
    toast(String(err));
  }
  cacheAsk = false;
  await refreshLibrary();
  await refreshCacheInfo();
}

function dlCard(j: DlJob): string {
  const pct = dlPercent(j);
  const remain = j.netBps > 0 ? Math.ceil((j.total - j.done) / j.netBps) : 0;
  const active = ACTIVE_PHASES.includes(j.phase);
  const verified = [...j.chunks].filter((c) => c === "v" || c === "m").length;
  return `
    <section class="dl-card ${active ? "on" : ""}">
      <div class="dl-row">
        <div class="dl-art" style="${artFor(j.editionId)}"></div>
        <div class="dl-main">
          <div class="dl-head">
            <div style="min-width:0">
              <div class="dl-title">${esc(j.title)}</div>
              <div class="dl-sub">${esc(j.destKind === "card" ? t("dl.toCard", { d: j.dest }) : t("dl.toDir", { d: j.dest }))} · ${esc(phaseLabel(j))}</div>
            </div>
            <div class="dl-btns">
              ${active ? `<button class="sx-btn" data-dlpause="${j.id}">${t("dl.pause")}</button>` : j.phase === "paused" || j.phase === "error" ? `<button class="sx-btn primary" data-dlresume="${j.id}">${t("dl.resume")}</button>` : ""}
              ${j.phase === "done" ? `<button class="sx-btn" data-repair="${esc(j.editionId)}">${t("dl.verify")}</button>` : `<button class="sx-btn ghost" data-dlcancel="${j.id}">${t("dl.cancel")}</button>`}
            </div>
          </div>
          <div class="dl-line">
            <span class="dl-pct" id="dl-pct-${j.id}">${pct} %</span>
            <span class="dl-bytes" id="dl-bytes-${j.id}">${j.total ? `${fmtBytes(j.done)} / ${fmtBytes(j.total)}` : "…"}${remain ? ` · ${t("dl.remaining", { s: remain })}` : ""}</span>
          </div>
          <div class="dl-bar"><span id="dl-bar-${j.id}" style="width:${pct}%"></span>${active ? `<i class="dl-sheen"></i>` : ""}</div>
          <div class="dl-chips">
            ${j.source ? `<span class="dl-chip ok" id="dl-src-${j.id}">● ${esc(j.source)}</span>` : `<span class="dl-chip" id="dl-src-${j.id}">${t("dl.srcOrder")}</span>`}
            ${j.mirrorChunks ? `<span class="dl-chip vi">◆ ${t("dl.mirrorChunks", { n: j.mirrorChunks })}</span>` : ""}
            ${j.error ? `<span class="dl-chip bad">${esc(j.error)}</span>` : ""}
          </div>
        </div>
        <div class="dl-speed">
          <div class="dl-speed-top">
            <div><div class="dl-k">${t("dl.net")}</div><div class="dl-v cy" id="dl-net-${j.id}">${fmtRate(j.netBps)}</div></div>
            <div style="text-align:right"><div class="dl-k">${t("dl.disk")}</div><div class="dl-v vi" id="dl-disk-${j.id}">${fmtRate(j.diskBps)}</div></div>
          </div>
          <div id="dl-graph-${j.id}">${speedGraph(j)}</div>
        </div>
      </div>
      ${j.chunks ? `<div class="dl-maphead"><span class="mono-label">${t("dl.chunks", { a: verified, b: j.chunks.length })}</span>
        <span class="dl-legend"><span><i class="c-v"></i>${t("dl.lgV")}</span><span><i class="c-a"></i>${t("dl.lgA")}</span><span><i class="c-m"></i>${t("dl.lgM")}</span><span><i class="c-p"></i>${t("dl.lgP")}</span></span></div>
        ${chunkMap(j.chunks, j.id)}` : ""}
    </section>`;
}

function downloadsView(): string {
  const jobs = Object.values(dl.jobs).filter((j) => j.kind === "download");
  const live = jobs.filter((j) => ACTIVE_PHASES.includes(j.phase) || j.phase === "paused" || j.phase === "error");
  const queued = jobs.filter((j) => j.phase === "queued");
  const doneIds = new Set(jobs.filter((j) => j.phase === "done").map((j) => j.cid));
  const installed = [
    ...jobs.filter((j) => j.phase === "done").map((j) => ({ e: state.catalog.find((c) => c.editionId === j.editionId), where: j.destKind === "card" ? j.dest : j.dest })),
    ...dl.library.filter((l) => l.status === "installed" && !doneIds.has(l.cid)).map((l) => ({ e: state.catalog.find((c) => c.buildCid === l.cid), where: l.dir })),
    ...state.games.filter((g) => g.cartridge.has_build).map((g) => ({ e: editionFor(g), where: g.cartridge.mount_point })),
  ].filter((x): x is { e: OnchainEdition; where: string } => Boolean(x.e));
  const a = activeJob();
  return `
    <div class="shelf dl-screen">
      <div class="shelf-head">
        <div>
          <div class="mono-label">${t("dl.manager")}</div>
          <div class="shelf-title">${t("dl.title")}</div>
        </div>
        <div class="dl-totals">
          ${a ? `<span>${t("dl.net")} <b class="cy" id="dl-tot-net">${fmtRate(a.netBps)}</b> · ${t("dl.disk")} <b class="vi" id="dl-tot-disk">${fmtRate(a.diskBps)}</b></span>` : ""}
          <button class="pillbtn" data-go="settings" title="${esc(t("set.dl"))}">${effectiveLimitMBs() ? esc(t(settings.lowBandwidth ? "dl.limitEco" : "dl.limitOn", { n: effectiveLimitMBs() })) : esc(t("dl.limitOff"))}</button>
          <button class="pillbtn" id="dl-addlib">${t("dl.add")}</button>
        </div>
      </div>
      <div class="dl-list">
        ${live.length ? live.map(dlCard).join("") : `<div class="dl-empty">${t("dl.empty")}</div>`}
        ${queued.length ? `<div class="mono-label dl-sec">${t("dl.queued", { n: queued.length })}</div>` + queued.map((j) => `
          <div class="dl-item">
            <div class="dl-thumb" style="${artFor(j.editionId)}"></div>
            <div style="flex:1;min-width:0"><div class="dl-item-t">${esc(j.title)}</div><div class="dl-sub">${esc(j.destKind === "card" ? t("dl.toCard", { d: j.dest }) : t("dl.toDir", { d: j.dest }))}</div></div>
            <button class="sx-btn ghost" data-dlcancel="${j.id}" aria-label="${esc(t("dl.cancel"))}">✕</button>
          </div>`).join("") : ""}
        ${installed.length ? `<div class="mono-label dl-sec">${t("dl.done")}</div>` + installed.map((x) => `
          <div class="dl-item">
            <div class="dl-thumb" style="${artFor(x.e.editionId)}"></div>
            <div style="flex:1;min-width:0"><div class="dl-item-t">${esc(x.e.title)}</div><div class="dl-sub ok">${esc(t("dl.installedAt", { d: x.where }))}</div></div>
            <button class="sx-btn" data-repair="${esc(x.e.editionId)}">${t("dl.verify")}</button>
          </div>`).join("") : ""}
      </div>
    </div>`;
}

function pickerView(): string {
  const p = dl.picker;
  if (!p) return "";
  const e = state.catalog.find((c) => c.editionId === p.editionId);
  const need = p.size;
  const opt = (o: DestOption, i: number) => {
    const key = `${o.kind}|${o.dest}`;
    const lacks = need !== null && o.free !== null && o.free < need * 1.01 ? need * 1.01 - o.free : 0;
    const used = o.free !== null && o.total ? Math.round(((o.total - o.free) / o.total) * 100) : 0;
    const badge =
      o.kind === "create" ? `<span class="dp-badge">${t("dl.toCreate")}</span>` : o.kind === "library" && i === 0 ? `<span class="dp-badge">${t("dl.default")}</span>` : o.kind === "card" ? `<span class="dp-badge vi">${t("dl.option")}</span>` : "";
    return `
      <label class="dp-opt ${p.choice === key ? "on" : ""} ${lacks ? "bad" : ""}">
        <input type="radio" name="dp" value="${esc(key)}" ${p.choice === key ? "checked" : ""} ${lacks ? "disabled" : ""} data-dpchoice="${esc(key)}" />
        <span class="dp-body">
          <span class="dp-name">${o.kind === "card" ? t("dl.cardName", { d: o.label }) : o.kind === "create" ? t("dl.createName", { d: o.label }) : t("dl.dirName", { d: o.label })} ${badge}</span>
          <span class="dp-sub ${lacks ? "bad" : ""}">${lacks ? t("dl.lacks", { n: fmtBytes(lacks) }) : o.kind === "card" ? t("dl.cardSub") : o.kind === "create" ? t("dl.createSub") : t("dl.libSub")}</span>
          <span class="dp-path">→ ${esc(o.folder)}</span>
          <span class="dp-gauge"><i style="width:${used}%"></i></span>
        </span>
        <span class="dp-free">${o.free !== null ? `${t("dl.free", { n: fmtBytes(o.free) })}<br><span>${t("dl.of", { n: fmtBytes(o.total ?? 0) })}</span>` : ""}</span>
      </label>`;
  };
  const chosen = p.options.find((o) => `${o.kind}|${o.dest}` === p.choice);
  return `
    <div class="dp-scrim" id="dp-scrim"></div>
    <div class="dp" role="dialog" aria-labelledby="dp-title">
      <div class="mono-label">${t("dl.btn")}</div>
      <h2 id="dp-title">${esc(t("dl.where", { t: e?.title ?? "" }))}</h2>
      <p>${need !== null ? esc(t("dl.whereSub", { n: fmtBytes(need) })) : esc(t("dl.whereSubUnknown"))}</p>
      <div class="dp-opts">
        ${p.options.length ? p.options.map(opt).join("") : `<div class="dp-none">${t("dl.noLib")}</div>`}
        <button class="dp-add" id="dp-add">${t("dl.addDir")}</button>
      </div>
      <div class="dp-rules">${t("dl.sources")}<br>${t("dl.verifyRule")}</div>
      <div class="dp-actions">
        <button class="sx-btn ghost" id="dp-cancel">${t("dl.cancel")}</button>
        <button class="sx-play dp-go" id="dp-go" ${chosen ? "" : "disabled"}>${chosen ? esc(t(chosen.kind === "create" ? "dl.goCreate" : "dl.go", { d: chosen.label })) : esc(t("dl.chooseFirst"))}</button>
      </div>
    </div>`;
}

function repairView(): string {
  const j = dl.repair ? dl.jobs[dl.repair] : undefined;
  if (!j) return "";
  const order = ["read", "fetch", "final", "done"];
  const at = j.phase === "prepare" ? 0 : Math.max(0, order.indexOf(j.phase));
  const bad = [...j.chunks].filter((c) => c === "x").length;
  const step = (i: number, label: string, sub: string) =>
    `<li class="${j.phase === "done" || i < at ? "ok" : i === at ? "on" : ""}"><div class="rp-k">${i < at || j.phase === "done" ? "✓" : i === at ? "●" : ""} ${i + 1} · ${label}</div><div class="rp-s">${sub}</div></li>`;
  return `
    <div class="dp-scrim"></div>
    <div class="dp rp" role="dialog" aria-labelledby="rp-title">
      <div class="rp-head">
        <div>
          <div class="mono-label">${t("rp.kicker")}</div>
          <h2 id="rp-title">${esc(j.title)}</h2>
          <p>${esc(j.destKind === "card" ? t("dl.toCard", { d: j.dest }) : t("dl.toDir", { d: j.dest }))}</p>
        </div>
        <div class="rp-status ${j.phase === "done" ? "ok" : j.phase === "error" ? "bad" : ""}">${esc(phaseLabel(j))}</div>
      </div>
      <ol class="rp-steps">
        ${step(0, t("rp.s1"), t("rp.s1sub", { n: j.chunks.length || 0 }))}
        ${step(1, t("rp.s2"), bad ? t("rp.s2bad", { n: bad }) : t("rp.s2ok"))}
        ${step(2, t("rp.s3"), t("rp.s3sub"))}
        ${step(3, t("rp.s4"), `0x${j.sha256.replace(/^0x/, "").slice(0, 4)}…${j.sha256.slice(-4)}`)}
      </ol>
      ${j.chunks ? chunkMap(j.chunks, j.id) : ""}
      <div class="rp-log" id="rp-log">${j.log.slice(-40).map((l) => `<div>&gt; ${esc(l)}</div>`).join("")}</div>
      ${j.error ? `<div class="dl-chip bad" style="margin-top:10px">${esc(j.error)}</div>` : ""}
      <div class="dp-actions">
        ${ACTIVE_PHASES.includes(j.phase) ? `<button class="sx-btn ghost" data-dlcancel="${j.id}">${t("rp.stop")}</button>` : `<button class="sx-btn primary" id="rp-close">${t("rp.close")}</button>`}
      </div>
    </div>`;
}

/** Surgical progress update (no rebuild: animations and scroll stay put). */
function patchDl(j: DlJob): void {
  const set = (id: string, v: string, html = false) => {
    const el = document.getElementById(id);
    if (el) html ? (el.innerHTML = v) : (el.textContent = v);
  };
  const pct = dlPercent(j);
  set(`dl-pct-${j.id}`, `${pct} %`);
  const remain = j.netBps > 0 ? Math.ceil((j.total - j.done) / j.netBps) : 0;
  set(`dl-bytes-${j.id}`, `${j.total ? `${fmtBytes(j.done)} / ${fmtBytes(j.total)}` : "…"}${remain ? ` · ${t("dl.remaining", { s: remain })}` : ""}`);
  const bar = document.getElementById(`dl-bar-${j.id}`);
  if (bar) bar.style.width = `${pct}%`;
  set(`dl-net-${j.id}`, fmtRate(j.netBps));
  set(`dl-disk-${j.id}`, fmtRate(j.diskBps));
  set("dl-tot-net", fmtRate(j.netBps));
  set("dl-tot-disk", fmtRate(j.diskBps));
  if (j.source) set(`dl-src-${j.id}`, `● ${j.source}`);
  set(`dl-graph-${j.id}`, speedGraph(j), true);
  const map = document.getElementById(`dl-map-${j.id}`);
  if (map) map.outerHTML = chunkMap(j.chunks, j.id);
}

function wireDownloads(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-dlopen]").forEach((b) => b.addEventListener("click", () => void openDownload(b.dataset.dlopen!)));
  root.querySelectorAll<HTMLButtonElement>("[data-repair]").forEach((b) => b.addEventListener("click", () => startRepair(b.dataset.repair!)));
  root.querySelectorAll<HTMLButtonElement>("[data-dlpause]").forEach((b) => b.addEventListener("click", () => pauseJob(b.dataset.dlpause!)));
  root.querySelectorAll<HTMLButtonElement>("[data-dlresume]").forEach((b) => b.addEventListener("click", () => resumeJob(b.dataset.dlresume!)));
  root.querySelectorAll<HTMLButtonElement>("[data-dlcancel]").forEach((b) => b.addEventListener("click", () => cancelJob(b.dataset.dlcancel!)));
  root.querySelectorAll<HTMLInputElement>("[data-dpchoice]").forEach((r) =>
    r.addEventListener("change", () => {
      if (dl.picker) dl.picker.choice = r.dataset.dpchoice!;
      render();
    }),
  );
  document.getElementById("dp-add")?.addEventListener("click", () => void addLibraryFolder());
  document.getElementById("dl-addlib")?.addEventListener("click", () => void addLibraryFolder());
  document.getElementById("dp-go")?.addEventListener("click", () => void confirmDownload());
  const closePicker = () => {
    dl.picker = null;
    render();
  };
  document.getElementById("dp-cancel")?.addEventListener("click", closePicker);
  document.getElementById("dp-scrim")?.addEventListener("click", closePicker);
  document.getElementById("rp-close")?.addEventListener("click", () => {
    if (dl.repair && dl.jobs[dl.repair]?.kind === "repair" && !ACTIVE_PHASES.includes(dl.jobs[dl.repair].phase)) delete dl.jobs[dl.repair];
    dl.repair = null;
    render();
  });
}

void listen<{ id: string; phase: string; done?: number; total?: number; net_bps?: number; disk_bps?: number; chunks?: string; source?: string; mirror_chunks?: number; error?: string | null }>(
  "dl-progress",
  (ev) => {
    const p = ev.payload;
    const j = dl.jobs[p.id];
    if (!j) return;
    const before = j.phase;
    j.phase = p.phase;
    if (p.done !== undefined) j.done = p.done;
    if (p.total !== undefined) j.total = p.total;
    if (p.net_bps !== undefined) j.netBps = p.net_bps;
    if (p.disk_bps !== undefined) j.diskBps = p.disk_bps;
    if (p.chunks !== undefined) j.chunks = p.chunks;
    if (p.source) j.source = p.source;
    if (p.mirror_chunks !== undefined) j.mirrorChunks = p.mirror_chunks;
    if (p.error) j.error = p.error;
    if (ACTIVE_PHASES.includes(p.phase)) {
      j.netHist.push(j.netBps);
      j.diskHist.push(j.diskBps);
      if (j.netHist.length > 120) j.netHist.shift(), j.diskHist.shift();
    }
    if (["done", "error", "paused", "cancelled"].includes(p.phase)) {
      j.netBps = 0;
      j.diskBps = 0;
      if (p.phase === "done") {
        beep([660, 880, 1320], 0.12, 0.16, "sine", "notif");
        void notify({
          kind: "download",
          title: t(j.kind === "repair" ? "nt.repaired" : "nt.dlDone", { t: j.title }),
          body: t("nt.dlDoneBody"),
          action: () => go("downloads"),
        });
      }
      if (p.phase === "error") {
        void notify({ kind: "download", title: t("nt.dlError", { t: j.title }), body: p.error ?? "", action: () => go("downloads") });
      }
      if (p.phase === "cancelled") delete dl.jobs[p.id];
      void refreshLibrary().then(() => {
        render();
        pump();
      });
      return;
    }
    if (before !== p.phase) render();
    else patchDl(j);
  },
);

void listen<{ id: string; line: string }>("dl-log", (ev) => {
  const j = dl.jobs[ev.payload.id];
  if (!j) return;
  j.log.push(ev.payload.line);
  if (j.log.length > 200) j.log.shift();
  const box = document.getElementById("rp-log");
  if (box && dl.repair === j.id) {
    box.insertAdjacentHTML("beforeend", `<div>&gt; ${esc(ev.payload.line)}</div>`);
    box.scrollTop = box.scrollHeight;
  }
});

// ── Veille (screensaver, validated 2026-10-09) ──────────────────────────
// After settings.veilleMin minutes without mouse or keyboard — never during
// a session, a pairing or an install — the console chrome gives way to the
// home's own orbital clock, the outrun horizon and a marquee of what the
// network is doing. Any input, or a card inserted, wakes it; the waking
// input does not also act on the screen behind.
let veilleOn = false;
let lastActivity = Date.now();

function canSleep(): boolean {
  return (
    settings.veilleMin > 0 &&
    !state.playing &&
    !state.nativeRun &&
    state.screen !== "boot" &&
    !state.pairing &&
    !state.installing
  );
}

function checkVeille(): void {
  if (!veilleOn && canSleep() && Date.now() - lastActivity >= settings.veilleMin * 60_000) showVeille();
}

function veilleTicker(): string {
  const items: string[] = [];
  const titleOf = (id?: string | null) => state.catalog.find((e) => e.editionId === id)?.title;
  for (const f of state.friends) {
    const who = (f.name ?? short(f.addr, 4)).toUpperCase();
    if (f.presence?.state === "playing") {
      const g = titleOf(f.presence.editionId);
      items.push(`<span class="vl-dot ok">●</span> ${esc(t("veille.playing", { who, game: (g ?? "").toUpperCase() }))}`);
    } else if (f.presence?.state === "online") items.push(`<span class="vl-dot ok">●</span> ${esc(t("veille.online", { who }))}`);
  }
  const offers = Object.values(state.market).filter((m) => m.seller.toLowerCase() !== ZERO_ADDR && m.seller.toLowerCase() === m.owner.toLowerCase()).length;
  if (offers) items.push(`<span class="vl-dot cy">▲</span> ${esc(t("veille.offers", { n: offers }))}`);
  const newest = state.catalog[state.catalog.length - 1];
  if (newest) items.push(`<span class="vl-dot vi">◆</span> STORE · ${esc(newest.title.toUpperCase())} · ${esc(formatEth(newest.priceWei))} ETH`);
  if (!items.length) items.push(`<span class="vl-dot cy">▲</span> AURA-64 · GAMEVAULT`);
  // twice: the marquee loops seamlessly by sliding exactly one copy
  const run = items.map((i) => `<span>${i}</span>`).join("");
  return run + run;
}

function veilleView(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const date = now.toLocaleDateString(locale(), { weekday: "short", day: "2-digit", month: "short" }).toUpperCase();
  const seated = state.games[0];
  let below = `<div class="vl-insert">INSERT SD CARD TO PLAY</div>`;
  if (seated) {
    const ed = editionFor(seated);
    const log = ed ? readLog()[ed.editionId] : undefined;
    const ready = ed ? playableNow(ed) : false;
    const title = seated.meta.title ?? ed?.title ?? "GAME";
    const status = [
      "SLOT A",
      ready ? t("veille.ready") : t("veille.check"),
      log ? `${t("sx.last")} ${fmtAgo(log.lastPlayedAt)}` : "",
    ].filter(Boolean).join(" · ");
    below = `
      <div class="vl-card">
        <span class="vl-card-art" style="${artFor(ed?.editionId ?? seated.meta.edition ?? "1")}"></span>
        <span style="min-width:0">
          <span class="vl-card-title">${esc(title)}</span>
          <span class="vl-card-sub ${ready ? "" : "warn"}">● ${esc(status)}</span>
        </span>
      </div>`;
  }
  return `
    ${homeBg()}
    <div class="vl-horizon" aria-hidden="true"><div class="vl-grid"></div></div>
    <div class="vl-brand"><span class="logo-chip"></span>AURA-64</div>
    <div class="vl-cluster">
      <div class="vl-time"><div class="big-time" id="veille-time">${hh}<span class="big-colon">:</span>${mm}</div></div>
      <div class="vl-under">
        <div class="vl-meta">
          <span class="big-sec" id="veille-sec">${ss}</span>
          <span class="big-date" id="veille-date">${esc(date)}</span>
        </div>
        ${below}
      </div>
    </div>
    <div class="vl-marquee"><div class="vl-track">${veilleTicker()}</div></div>
    <div class="vl-hint">${esc(t("veille.hint"))}</div>`;
}

function showVeille(): void {
  if (veilleOn) return;
  veilleOn = true;
  const el = document.createElement("div");
  el.id = "veille";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", t("veille.hint"));
  el.innerHTML = veilleView();
  document.body.appendChild(el);
}

function hideVeille(): void {
  if (!veilleOn) return;
  veilleOn = false;
  lastActivity = Date.now();
  const el = document.getElementById("veille");
  if (!el) return;
  el.id = "veille-out"; // its clock ids stop ticking at once
  el.classList.add("out");
  window.setTimeout(() => el.remove(), 600);
}

for (const type of ["mousemove", "mousedown", "keydown", "wheel", "touchstart"]) {
  window.addEventListener(
    type,
    (e) => {
      lastActivity = Date.now();
      if (!veilleOn) return;
      // the input that wakes the launcher must not also click or type behind
      if (type !== "mousemove") {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      hideVeille();
    },
    { capture: true, passive: false },
  );
}

// Seated home shortcuts (shown in the rail header): Enter = the primary
// action, F = the game page. Never while typing or during a session.
window.addEventListener("keydown", (e) => {
  if (state.screen !== "home" || state.playing || state.nativeRun || !state.games[0]) return;
  const tag = (document.activeElement as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Enter" && tag !== "BUTTON") {
    e.preventDefault();
    document.getElementById("home-hero")?.click();
  } else if (e.key === "f" || e.key === "F") {
    const ed = editionFor(state.games[0]);
    if (ed) {
      state.sel = ed.editionId;
      go("detail");
    }
  }
});

window.addEventListener("DOMContentLoaded", () => {
  applySettings();
  applyStaticI18n();
  wireWindowControls();
  void showAtLaunch();
  applyDownloadLimit();
  void refreshAutostart();
  void refreshLibrary();
  loadSession();
  document.getElementById("restart-btn")?.addEventListener("click", () => void runBoot());
  document.getElementById("store-btn")?.addEventListener("click", () => void openUrl(MARKETPLACE_URL));
  document.querySelectorAll<HTMLButtonElement>("[data-navgo]").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.screen === "boot" || state.playing || state.nativeRun) return;
      const s = b.dataset.navgo as Screen;
      if (s === "friends") void fetchFriends().then(() => render());
      if (s === "settings") cacheInfo = null;
      go(s);
    }),
  );
  void runBoot();
  setInterval(() => void refresh(), 2000);
  setInterval(renderChrome, 1000); // bottom-bar clock ticks every second
  let netTick = 0;
  setInterval(() => {
    netTick++;
    if (!settings.lowBandwidth || netTick % 2 === 0) pushPresence(); // friends see "online" / "playing X"
    if (!settings.lowBandwidth || netTick % 3 === 0) void checkDeviceSlot();
  }, 60_000);
  window.setTimeout(() => void checkDeviceSlot(), 8000);
  pushPresence();
});
