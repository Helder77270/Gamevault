import { invoke } from "@tauri-apps/api/core";
import { verifyTicket, isExpired, unhex, type SignedTicket } from "@gamevault/shared";

// Platform public key embedded in the launcher (dev key for now — swapped
// for the production key at ticketd deploy time).
const PLATFORM_PUB = unhex("0x038d78e7c9ea67e401f6e9dbf8fccae4563dc21c0e3f569338012ba95c50700f2b");

interface Cartridge {
  mount_point: string;
  volume_label: string;
  ticket_json: string;
  meta_json: string | null;
  has_build: boolean;
}

type Verdict = "authentic" | "tampered" | "expired" | "unreadable";

interface Game {
  cartridge: Cartridge;
  ticket: SignedTicket | null;
  meta: { title?: string; studio?: string };
  verdict: Verdict;
}

type Route = "home" | "library";

// Custom-protocol URL — WebView2 (Windows) maps schemes to http://<scheme>.localhost
const GAME_URL = navigator.userAgent.includes("Windows") ? "http://game.localhost/" : "game://localhost/";

const state = {
  route: "home" as Route,
  games: [] as Game[],
  session: null as { address: string } | null,
  lastScan: "",
  playing: null as Game | null,
  playError: "",
};

// ── Verification ──────────────────────────────────────────────

function judge(c: Cartridge): Game {
  let meta: Game["meta"] = {};
  try {
    meta = c.meta_json ? JSON.parse(c.meta_json) : {};
  } catch {
    /* meta is cosmetic — ignore */
  }
  let ticket: SignedTicket | null = null;
  try {
    ticket = JSON.parse(c.ticket_json) as SignedTicket;
  } catch {
    return { cartridge: c, ticket: null, meta, verdict: "unreadable" };
  }
  if (!verifyTicket(ticket, PLATFORM_PUB)) return { cartridge: c, ticket, meta, verdict: "tampered" };
  if (isExpired(ticket)) return { cartridge: c, ticket, meta, verdict: "expired" };
  return { cartridge: c, ticket, meta, verdict: "authentic" };
}

// ── Session (simulated — replaced by QR/SIWE pairing next) ────

function loadSession(): void {
  const raw = localStorage.getItem("gv-session");
  state.session = raw ? JSON.parse(raw) : null;
}

function connect(): void {
  // Placeholder: the real flow shows a QR embedding the device pubkey and
  // waits for the owner's SIWE signature. Until then, simulate the result.
  state.session = { address: "0x000000000000000000000000000000000000dEaD" };
  localStorage.setItem("gv-session", JSON.stringify(state.session));
  render();
}

function disconnect(): void {
  state.session = null;
  localStorage.removeItem("gv-session");
  state.route = "home";
  render();
}

// ── Rendering ─────────────────────────────────────────────────

const short = (h: string, n = 10): string => (h.length <= 2 * n ? h : `${h.slice(0, n)}…${h.slice(-4)}`);
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const VERDICT_BADGE: Record<Verdict, string> = {
  authentic: `<span class="badge ok">✔ ticket authentique</span>`,
  tampered: `<span class="badge bad">⛔ signature invalide</span>`,
  expired: `<span class="badge warn">⏳ expiré — renouvellement en ligne requis</span>`,
  unreadable: `<span class="badge bad">ticket illisible</span>`,
};

function ticketDetails(g: Game): string {
  if (!g.ticket) return "";
  const t = g.ticket;
  return `
    <dl class="ticket-grid">
      <dt>Jeu (tokenId)</dt><dd>${esc(t.tokenId)} · ${short(t.contract)}</dd>
      <dt>Propriétaire</dt><dd>${short(t.ownerAddress)}</dd>
      <dt>Appareil autorisé</dt><dd>${short(t.devicePubKey)}</dd>
      <dt>Clé scellée (ECIES)</dt><dd>${short(t.wrappedContentKey, 16)}</dd>
      <dt>Expire le</dt><dd>${new Date(t.expiresAt * 1000).toLocaleString()}</dd>
      <dt>Build chiffré</dt><dd>${g.cartridge.has_build ? "présent" : "build.enc manquant"}</dd>
    </dl>`;
}

function homeView(): string {
  const cards = state.games.length
    ? state.games
        .map(
          (g) => `
      <article class="cartridge-card">
        <header>
          <h3>💾 ${esc(g.meta.title ?? g.cartridge.volume_label ?? "Cartouche")}</h3>
          ${VERDICT_BADGE[g.verdict]}
          <span class="mount">${esc(g.cartridge.mount_point)}</span>
        </header>
        ${ticketDetails(g)}
      </article>`,
        )
        .join("")
    : `<p class="waiting">Insérez une cartouche GameVault (USB ou SD)…</p>`;
  return `
    <section class="hero">
      <h1>Vos jeux, possédés pour de vrai.</h1>
      <p>Chaque cartouche GameVault porte une licence ERC-721 : jouable hors ligne,
         prêtable, revendable — avec royalties automatiques aux studios.</p>
      <p class="tagline">« Le support est le véhicule, la blockchain est le verrou. »</p>
    </section>
    <h2 class="section">Cartouches détectées</h2>
    <div class="cards">${cards}</div>`;
}

function libraryView(): string {
  if (!state.session) {
    return `
      <div class="locked">
        <div class="big">🔒</div>
        <h2>Bibliothèque verrouillée</h2>
        <p>Connectez votre wallet pour voir vos jeux. L'appairage lie cette machine
           à votre adresse — ensuite, tout fonctionne hors ligne.</p>
        <button class="btn" id="connect-btn">Se connecter</button>
      </div>`;
  }
  const playable = state.games;
  if (!playable.length) {
    return `<h2 class="section">Ma bibliothèque</h2>
      <p class="waiting">Aucun jeu détecté — insérez une cartouche.</p>`;
  }
  return `
    <h2 class="section">Ma bibliothèque</h2>
    ${state.playError ? `<p class="play-error">⛔ Lancement refusé : ${esc(state.playError)}</p>` : ""}
    <div class="game-grid">
      ${playable
        .map((g) => {
          const title = g.meta.title ?? "Jeu inconnu";
          const canPlay = g.verdict === "authentic" && g.cartridge.has_build;
          return `
        <article class="game-card">
          <div class="cover">${esc(title.charAt(0).toUpperCase())}</div>
          <div class="body">
            <h3>${esc(title)}</h3>
            <span class="studio">${esc(g.meta.studio ?? "Studio inconnu")}</span>
            <div class="row">
              ${VERDICT_BADGE[g.verdict]}
              <button class="btn play-btn" data-mount="${esc(g.cartridge.mount_point)}" ${canPlay ? "" : "disabled"}
                title="${canPlay ? "Déchiffrer et lancer" : "Ticket invalide ou build.enc manquant"}">▶ Jouer</button>
            </div>
          </div>
        </article>`;
        })
        .join("")}
    </div>`;
}

// ── Play ──────────────────────────────────────────────────────

async function play(g: Game): Promise<void> {
  state.playError = "";
  try {
    // Rust: unwrap content key with device key -> decrypt build in RAM
    await invoke("play_game", { mountPoint: g.cartridge.mount_point });
    state.playing = g;
  } catch (e) {
    state.playError = String(e);
  }
  render();
}

async function quit(): Promise<void> {
  await invoke("stop_game"); // drop decrypted bundle from memory
  state.playing = null;
  render();
}

function playerView(g: Game): string {
  return `
    <div class="player">
      <header>
        <span class="title">🎮 ${esc(g.meta.title ?? "Jeu")} — déchiffré en mémoire, licence ${esc(g.ticket?.tokenId ?? "?")}</span>
        <button class="btn ghost" id="quit-btn">✕ Quitter le jeu</button>
      </header>
      <iframe src="${GAME_URL}" title="jeu"></iframe>
    </div>`;
}

function render(): void {
  if (state.playing) {
    document.getElementById("view")!.innerHTML = playerView(state.playing);
    document.getElementById("quit-btn")?.addEventListener("click", () => void quit());
    return;
  }
  document.getElementById("tabs")!.innerHTML = `
    <button class="tab ${state.route === "home" ? "active" : ""}" data-route="home">Accueil</button>
    <button class="tab ${state.route === "library" ? "active" : ""}" data-route="library">
      Bibliothèque ${state.session ? "" : `<span class="lock">🔒</span>`}
    </button>`;

  document.getElementById("session-zone")!.innerHTML = state.session
    ? `<div class="session-chip"><span class="dot"></span>${short(state.session.address)}
         <button class="btn ghost" id="disconnect-btn">Quitter</button></div>`
    : `<button class="btn" id="connect-btn-top">Se connecter</button>`;

  document.getElementById("view")!.innerHTML = state.route === "home" ? homeView() : libraryView();

  document.getElementById("statusbar")!.innerHTML = `
    <span>${state.games.length} cartouche(s) · ${state.lastScan}</span>
    <span>session simulée — appairage QR/SIWE : prochaine étape</span>`;

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      state.route = b.dataset.route as Route;
      render();
    }),
  );
  document.getElementById("connect-btn")?.addEventListener("click", connect);
  document.getElementById("connect-btn-top")?.addEventListener("click", connect);
  document.getElementById("disconnect-btn")?.addEventListener("click", disconnect);
  document.querySelectorAll<HTMLButtonElement>(".play-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const g = state.games.find((x) => x.cartridge.mount_point === b.dataset.mount);
      if (g) void play(g);
    }),
  );
}

// ── Scan loop ─────────────────────────────────────────────────

async function refresh(): Promise<void> {
  if (state.playing) return; // don't re-render (and destroy the iframe) mid-game
  try {
    const found = await invoke<Cartridge[]>("scan_cartridges");
    state.games = found.map(judge);
    state.lastScan = `scan ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    state.lastScan = `erreur de scan : ${String(e)}`;
  }
  render();
}

window.addEventListener("DOMContentLoaded", () => {
  loadSession();
  void refresh();
  setInterval(() => void refresh(), 2000);
});
