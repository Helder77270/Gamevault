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
import { fetchBuild, GATEWAYS } from "@gamevault/shared/storage";
import { LICENSE_ABI, MARKETPLACE_ABI } from "@gamevault/shared/abi";
import { getLang, locale, setLang, t, type Lang } from "./i18n";

const MARKETPLACE_URL = "http://localhost:3000";
const TICKETD_URL = "http://localhost:8787";
const GAME_URL = navigator.userAgent.includes("Windows") ? "http://game.localhost/" : "game://localhost/";
// Builds come from ticketd (local cache, no CORS); IPFS gateways are the
// backup. Integrity is checked HERE against the on-chain sha256 either way.
const BUILD_MIRRORS = [`${TICKETD_URL}/build/`, ...GATEWAYS];

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

type Screen = "boot" | "home" | "shelf" | "detail" | "insert" | "friends" | "settings" | "error";

// ── Settings (per machine, localStorage) ─────────────────────
type Skin = "midnight" | "sunset" | "crt";
interface Settings {
  skin: Skin;
  sound: boolean;
  volume: number; // 0..1
  reducedMotion: boolean;
  dev: boolean;
}

const SETTINGS_DEFAULT: Settings = { skin: "midnight", sound: true, volume: 0.8, reducedMotion: false, dev: true };

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem("gv-settings") ?? "{}") as Partial<Settings>;
    const s = { ...SETTINGS_DEFAULT, ...raw };
    if (!["midnight", "sunset", "crt"].includes(s.skin)) s.skin = "midnight";
    s.volume = Math.min(1, Math.max(0, Number(s.volume) || 0));
    return s;
  } catch {
    return { ...SETTINGS_DEFAULT };
  }
}

const settings: Settings = loadSettings();

function applySettings(): void {
  const root = document.documentElement;
  root.dataset.skin = settings.skin;
  root.classList.toggle("reduced-motion", settings.reducedMotion);
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
  friends: [] as { addr: string; since: number; name: string | null }[],
  /** live loans touching the library wallet, lent or borrowed */
  loans: [] as { tokenId: string; owner: string; user: string; expires: number }[],
  ticketdOk: false,
  /** selected editionId for detail/insert screens */
  sel: null as string | null,
  filter: "all" as "all" | "play",
  /** shelf layout: retro grid, or Steam-style list + preview pane */
  shelfMode: (localStorage.getItem("gv-shelfmode") === "list" ? "list" : "grid") as "grid" | "list",
  /** preview pane: technical data accordion (CID/hash/ticket) open? */
  techOpen: false,
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
  const seconds = Math.round((Date.now() - sessionStart) / 1000);
  const log = readLog();
  const e = log[sessionEdition];
  if (e) {
    e.totalSeconds += seconds;
    writeLog(log);
  }
  // Profil « les plus joués » (cosmétique) — fire and forget vers ticketd
  const addr = libraryAddress();
  if (addr && seconds > 0) {
    void fetch(`${TICKETD_URL}/profile/playstat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addr, editionId: sessionEdition, seconds }),
    }).catch(() => {});
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
      const data = (await res.json()) as { friends: { addr: string; since: number; name: string | null }[] };
      state.friends = data.friends;
    }
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

async function downloadBuild(g: Game): Promise<void> {
  const ed = editionFor(g);
  if (!ed?.buildCid) return;
  const mount = g.cartridge.mount_point;
  state.dlStatus[mount] = "FETCH + VERIFY…";
  render();
  try {
    const bytes = await fetchBuild(ed.buildCid, ed.buildSha256, BUILD_MIRRORS);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await invoke("write_build", { mountPoint: mount, dataB64: btoa(bin) });
    delete state.dlStatus[mount];
  } catch (e) {
    state.dlStatus[mount] = t("dl.failed", { e: String(e) });
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
    const bytes = await fetchBuild(inst.edition.buildCid, inst.edition.buildSha256, BUILD_MIRRORS);
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
        invoke<{ kind: string; pid?: number }>("play_game", { mountPoint: g.cartridge.mount_point }),
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
    const ticket = state.nativeRun?.g?.ticket;
    if (!ticket) return;
    const check = await checkOwnerOnline(ticket);
    if (check === "revoked" || check === "evicted") {
      stopNativeWatchdog();
      await invoke("stop_game"); // kills the child, cleans the run dir
      state.nativeRun = null;
      if (check === "revoked") {
        chimeCash();
        fail(t("err.movedT"), t("err.resoldMidM"), "ERR 0x52 · RESOLD MID-SESSION · PROCESS TERMINATED", "detail");
      } else {
        chimeOut();
        fail(t("err.evictedT"), t("err.evictedM"), "ERR 0x53 · DEVICE SLOT RELEASED · PROCESS TERMINATED", "detail");
      }
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
      <div class="lv-art" style="${artFor(ed?.editionId ?? "1")}"><div class="sheen"></div></div>
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

function beep(freqs: number[], dur = 0.09, vol = 0.16, wave: OscillatorType = "sine"): void {
  if (!settings.sound || settings.volume <= 0) return;
  vol *= settings.volume;
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
const chimeLaunch = (): void => beep([523, 659, 880], 0.12);

// ── Les moments signatures (DA v1) — WebAudio, zéro asset ─────

/** Carte SD qui s'insère : clic mécanique + petite montée en rotation. */
function sfxInsert(): void {
  if (!settings.sound || settings.volume <= 0) return;
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const t0 = audio.currentTime;
    const v = settings.volume;
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
  beep([523, 659, 784, 1047], 0.1, 0.18);
  setTimeout(() => beep([1568, 2093], 0.22, 0.09), 430);
}

/** Revente/révocation : le ka-ching du tiroir-caisse. */
function chimeCash(): void {
  beep([2637, 2093], 0.055, 0.16, "square");
  setTimeout(() => beep([1047, 1319], 0.12, 0.12), 120);
}

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
  (kind === "in" ? sfxInsert : chimeOut)();
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
  return Boolean(g && g.verdict === "authentic" && g.cartridge.has_build && isOurs(g));
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

  // ── PISTE B — card seated: hero continue + card widget ───────
  const ed = editionFor(seated);
  const log = ed ? readLog()[ed.editionId] : undefined;
  const can = ed ? playableNow(ed) : false;
  const title = seated.meta.title ?? ed?.title ?? "GAME";
  const vState = can
    ? { label: "READY · TICKET " + ticketDaysLeft(seated), cls: "" }
    : seated.verdict === "unpaired" || !isOurs(seated)
      ? { label: "PAIR THIS MACHINE", cls: "warn" }
      : seated.verdict === "expired"
        ? { label: t("home.ticketExpired"), cls: "warn" }
        : !seated.cartridge.has_build
          ? { label: "NO BUILD — FETCH IPFS", cls: "warn" }
          : { label: seated.verdict.toUpperCase(), cls: "warn" };
  const stats = log
    ? `▶ ×${log.playCount} · ${fmtDur(log.totalSeconds)} · <span data-ago data-ts="${log.lastPlayedAt}">${fmtAgo(log.lastPlayedAt)}</span>`
    : t("home.firstPlay");

  return `
    ${homeBg()}
    <div class="home">
      ${top}
      <div class="heroB">
        <button class="home-hero" id="home-hero" style="${artFor(ed?.editionId ?? "1")}">
          <span class="sheen"></span>
          <span class="hh-kicker">${can ? "CONTINUE" : "INSERTED"} · ${t("pv.ed", { id: esc(ed?.editionId ?? "?") })}${seated.ticket ? ` · LICENCE #${esc(seated.ticket.tokenId)}` : ""}</span>
          <span class="hh-bottom">
            <span style="min-width:0">
              <span class="hh-title">${esc(title)}</span>
              <span class="hh-stats">${stats}</span>
            </span>
            <span class="hh-play ${can ? "" : "ghost"}">${can ? "▶ PLAY" : t("home.openSheet")}</span>
          </span>
        </button>
        <div class="card-widget">
          <div class="mono-label" style="font-size:10px;letter-spacing:0.26em">SLOT A · CARD SEATED</div>
          <div class="cw-row">
            <span class="atk-slotwrap" aria-hidden="true">
              <span class="atk-card" style="animation:none"></span>
              <span class="atk-slot"><span class="atk-slot-line"></span></span>
            </span>
            <div style="min-width:0">
              <div class="cw-title">${esc(title)}</div>
              <div class="cw-state ${vState.cls}"><span class="cw-led"></span>${esc(vState.label)}</div>
              <div class="cw-dim">${esc(seated.cartridge.mount_point)} · ${seated.cartridge.has_build ? "BUILD OK" : "NO BUILD"}${addr ? " · OWNER ✔" : ""}</div>
            </div>
          </div>
          <div class="cw-pills">
            <button class="pillbtn" data-go="shelf">GAME SHELF · ${playable}/${state.catalog.length}</button>
            <button class="pillbtn violet" id="home-insert">${t("home.cardPair")}</button>
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
    if (!g.cartridge.has_build) return { label: "NO BUILD", cls: "warn" };
    return { label: "CHECK CARD", cls: "warn" };
  }
  if (ownedTok.length) return { label: "AWAITING CARD", cls: "warn" };
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
          <div class="pv-kick">${g?.ticket ? `LICENCE #${esc(g.ticket.tokenId)} · ` : ownedTok.length ? `LICENCE #${esc(ownedTok[0].tokenId)} · ` : ""}${t("pv.minted", { m: e.minted, s: e.supply })} · ROYALTIES ${e.royaltyBps / 100}%</div>
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
      ${isList ? listBody : gridBody}
    </div>`;
}

const FRIEND_AGE_SEC = 3 * 86400;

function friendsView(): string {
  const me = libraryAddress();
  const now = Math.floor(Date.now() / 1000);

  const friendRows = state.friends.length
    ? state.friends
        .map((f) => {
          const matured = now >= f.since + FRIEND_AGE_SEC;
          const daysLeft = Math.max(1, Math.ceil((f.since + FRIEND_AGE_SEC - now) / 86400));
          return `
          <div class="listrow" style="cursor:default">
            <div style="width:40px;height:40px;border-radius:999px;flex:none;background:linear-gradient(150deg, oklch(0.7 0.1 ${(Number.parseInt(f.addr.slice(2, 8), 16) % 360)}), oklch(0.4 0.08 265));border:1px solid rgba(255,255,255,0.2)"></div>
            <div style="min-width:0">
              <div class="lr-title">${esc(f.name ?? short(f.addr, 8))}</div>
              <div class="lr-meta">${f.name ? `${esc(short(f.addr, 6).toUpperCase())} · ` : ""}${t("fr.since", { d: new Date(f.since * 1000).toLocaleDateString(locale()) })}</div>
            </div>
            <div class="lr-right">
              <span class="lr-chip ${matured ? "ok" : "warn"}">${matured ? t("fr.canLend") : t("fr.lendIn", { n: daysLeft })}</span>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="slot-dim" style="padding:14px 4px">${t("fr.none")}</div>`;

  const loanRows = state.loans.length
    ? state.loans
        .map((l) => {
          const lent = me && l.owner.toLowerCase() === me.toLowerCase();
          const days = Math.max(0, Math.ceil((l.expires - now) / 86400));
          const owned = state.owned.find((o) => o.tokenId === l.tokenId);
          const title = state.catalog.find((e) => e.editionId === owned?.editionId)?.title ?? `Licence #${l.tokenId}`;
          return `
          <div class="listrow" style="cursor:default">
            <div class="lr-art" style="${artFor(owned?.editionId ?? "0")}"></div>
            <div style="min-width:0">
              <div class="lr-title">${esc(title)} · #${esc(l.tokenId)}</div>
              <div class="lr-meta">${lent ? t("fr.lentTo", { a: esc(short(l.user, 6).toUpperCase()) }) : t("fr.borrowedFrom", { a: esc(short(l.owner, 6).toUpperCase()) })}</div>
            </div>
            <div class="lr-right">
              <span class="lr-chip ${lent ? "warn" : "ok"}">${lent ? t("fr.atFriend") : t("fr.yourTurn")} · J-${days}</span>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="slot-dim" style="padding:14px 4px">${t("fr.noLoans")}</div>`;

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
          <button class="pillbtn violet" id="friends-manage">${t("fr.manage")}</button>
          <button class="pillbtn" id="refresh-btn">🔄</button>
        </div>
      </div>
      <div class="shelf-split" style="padding-top:20px">
        <div class="shelf-listcol" style="width:46%">
          <div class="mono-label" style="margin:2px 0 8px">${t("fr.myFriends")}</div>
          ${friendRows}
        </div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:14px">
          <div class="mono-label" style="margin:2px 0 -4px">${t("fr.loans")}</div>
          ${loanRows}
          <div class="pv-hint" style="border-left:2px solid oklch(0.8 0.1 200 / 0.5);padding-left:12px;line-height:1.8;margin-top:auto">
            ${esc(t("fr.rule"))}
          </div>
        </div>
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
          ${toggle("set-motion", settings.reducedMotion, t("set.motion"), t("set.motionSub"))}
          ${toggle("set-dev", settings.dev, t("set.dev"), t("set.devSub"))}
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
  if (g && !g.cartridge.has_build) {
    return {
      action: `<button class="cta violet" data-dl="${esc(g.cartridge.mount_point)}">${t("act.fetch")}</button>`,
      hint: state.dlStatus[g.cartridge.mount_point] ?? t("hint.fetch"),
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
  if (g?.ticket && isOurs(g) && g.verdict === "authentic" && !resold) {
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
        <div class="detail-kicker">${esc(e.studio.toUpperCase())} &nbsp;&#183;&nbsp; ROYALTIES ${e.royaltyBps / 100}% &nbsp;&#183;&nbsp; ${e.minted}/${e.supply} MINTED</div>
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
          <div style="flex-basis:100%;display:flex;gap:8px;flex-wrap:wrap">${marketRow}${provRow}</div>
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
      { label: "FETCH BUILD · IPFS", st: inst.stage === 1 ? "run" : inst.stage > 1 ? "ok" : "idle", note: inst.stage > 1 ? "VERIFIED" : inst.stage === 1 ? "…" : "—" },
      { label: "WRITE CARD", st: inst.stage === 2 ? "run" : inst.stage > 2 ? "ok" : "idle", note: inst.stage > 2 ? "DONE" : inst.stage === 2 ? "…" : "—" },
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
  const gear = document.getElementById("nav-settings");
  if (gear) {
    gear.setAttribute("aria-label", t("nav.settings"));
    gear.title = t("nav.settings");
  }
  const store = document.getElementById("store-btn");
  if (store) store.title = t("top.store.title");
}

function renderChrome(): void {
  // Topbar nav active state (static chrome — survives screen rebuilds)
  const navMap: Record<string, Screen[]> = {
    "nav-home": ["home"],
    "nav-shelf": ["shelf", "detail", "insert"],
    "nav-friends": ["friends"],
    "nav-settings": ["settings"],
  };
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
    sm: state.shelfMode,
    to: state.techOpen,
    fr: state.friends.map((f) => f.addr + f.since),
    ln: state.loans.map((l) => l.tokenId + l.user + l.expires),
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
  root.querySelectorAll<HTMLButtonElement>(".gamecard, [data-edition]:not(.gamecard)").forEach((b) =>
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
  document.getElementById("home-store")?.addEventListener("click", () => void openUrl(MARKETPLACE_URL));
  document.getElementById("friends-manage")?.addEventListener("click", () => void openUrl(`${MARKETPLACE_URL}/friends`));
  document.getElementById("home-hero")?.addEventListener("click", () => {
    const g = state.games[0];
    if (!g) return;
    const ed = editionFor(g);
    state.sel = ed?.editionId ?? null;
    if (ed && playableNow(ed)) void play(g);
    else go("detail");
  });
  document.getElementById("view-grid")?.addEventListener("click", () => {
    state.shelfMode = "grid";
    localStorage.setItem("gv-shelfmode", "grid");
    render();
  });
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
      void fetchFriends();
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
  applySettings();
  applyStaticI18n();
  loadSession();
  document.getElementById("restart-btn")?.addEventListener("click", () => void runBoot());
  document.getElementById("store-btn")?.addEventListener("click", () => void openUrl(MARKETPLACE_URL));
  document.querySelectorAll<HTMLButtonElement>("[data-navgo]").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.screen === "boot" || state.playing || state.nativeRun) return;
      const s = b.dataset.navgo as Screen;
      if (s === "friends") void fetchFriends().then(() => render());
      go(s);
    }),
  );
  void runBoot();
  setInterval(() => void refresh(), 2000);
  setInterval(renderChrome, 1000); // bottom-bar clock ticks every second
});
