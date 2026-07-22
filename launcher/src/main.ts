import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import QRCode from "qrcode";
import { createPublicClient, http } from "viem";
import { verifyTicket, isExpired, unhex, type SignedTicket } from "@gamevault/shared";
import { MOCK_EDITIONS } from "@gamevault/shared/catalog";
import { DEPLOYMENTS, WORLDCHAIN_SEPOLIA } from "@gamevault/shared/deployments";

// Browsing is data — the full catalog renders natively in the launcher.
// Only the PAYMENT needs the wallet, so only checkout jumps to the system
// browser (where the wallet lives). Same split Steam uses for its checkout.
const MARKETPLACE_URL = "http://localhost:3000";

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

type Route = "home" | "store" | "library";

// Custom-protocol URL — WebView2 (Windows) maps schemes to http://<scheme>.localhost
const GAME_URL = navigator.userAgent.includes("Windows") ? "http://game.localhost/" : "game://localhost/";

const TICKETD_URL = "http://localhost:8787";

interface Pairing {
  nonce: string;
  url: string;
  qrDataUrl: string;
  status: "waiting" | "error";
  error?: string;
}

const state = {
  route: "home" as Route,
  games: [] as Game[],
  session: null as { address: string } | null,
  devicePubKey: "",
  pairing: null as Pairing | null,
  lastScan: "",
  ownerCheck: "",
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

/** Is this ticket sealed to THIS machine's device key? */
const isOurs = (g: Game): boolean =>
  Boolean(g.ticket && state.devicePubKey && g.ticket.devicePubKey.toLowerCase() === state.devicePubKey.toLowerCase());

// ── Real pairing: QR -> owner signs SIWE on web/ -> ticketd seals a ticket
//    to this device -> launcher fetches it and writes it on the cartridge ──

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
  const qrDataUrl = await QRCode.toDataURL(url, { width: 260, margin: 2 });
  state.pairing = { nonce, url, qrDataUrl, status: "waiting" };
  render();

  const startedAt = Date.now();
  pollTimer = window.setInterval(async () => {
    if (!state.pairing) return stopPolling();
    if (Date.now() - startedAt > 10 * 60 * 1000) {
      state.pairing.status = "error";
      state.pairing.error = "Appairage expiré — relancez depuis le launcher.";
      stopPolling();
      return render();
    }
    try {
      const res = await fetch(`${TICKETD_URL}/pending/${state.pairing.nonce}`);
      if (!res.ok) return; // not signed yet — keep waiting
      const ticket = (await res.json()) as SignedTicket;
      await completePairing(g, ticket);
    } catch {
      /* ticketd briefly unreachable — keep polling */
    }
  }, 1500);
}

function stopPolling(): void {
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
  pollTimer = undefined;
}

async function completePairing(g: Game, ticket: SignedTicket): Promise<void> {
  stopPolling();
  // Trust nothing: platform signature + sealed to OUR device key
  if (!verifyTicket(ticket, PLATFORM_PUB) || ticket.devicePubKey.toLowerCase() !== state.devicePubKey.toLowerCase()) {
    if (state.pairing) {
      state.pairing.status = "error";
      state.pairing.error = "Ticket reçu invalide ou scellé pour un autre appareil.";
    }
    return render();
  }
  // The rewritable-media moment: refreshed ticket goes back on the cartridge
  await invoke("write_ticket", { mountPoint: g.cartridge.mount_point, ticketJson: JSON.stringify(ticket, null, 2) });
  state.session = { address: ticket.ownerAddress };
  localStorage.setItem("gv-session", JSON.stringify(state.session));
  state.pairing = null;
  await refresh();
}

function cancelPairing(): void {
  stopPolling();
  state.pairing = null;
  render();
}

function connect(): void {
  const g = state.games.find((x) => x.ticket);
  if (!g) {
    alert("Insérez une cartouche GameVault : l'appairage autorise cette machine pour une licence précise.");
    return;
  }
  void startPairing(g);
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

function pairingView(p: Pairing): string {
  return `
    <div class="modal-overlay">
      <div class="modal">
        <h2>Appairer cette machine</h2>
        ${
          p.status === "error"
            ? `<p class="play-error">${esc(p.error ?? "Erreur")}</p>`
            : `
        <p>Scannez avec votre téléphone, ou ouvrez le lien sur ce PC — puis signez avec le wallet
           propriétaire de la licence.</p>
        <img class="qr" src="${p.qrDataUrl}" alt="QR d'appairage" />
        <button class="btn ghost" id="open-pair-url">Ouvrir dans le navigateur</button>
        <p class="hint">En attente de la signature… la clé publique de CETTE machine est dans le QR :
           votre signature autorisera cet appareil et aucun autre.</p>`
        }
        <button class="btn ghost" id="cancel-pairing">Annuler</button>
      </div>
    </div>`;
}

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
          ${g.ticket && !isOurs(g) ? `<span class="badge warn">autre appareil</span>` : ""}
          <span class="mount">${esc(g.cartridge.mount_point)}</span>
        </header>
        ${ticketDetails(g)}
        ${
          g.ticket && !isOurs(g)
            ? `<p class="pending">Le ticket est scellé pour une autre machine — le propriétaire doit
                 appairer celle-ci. <button class="btn pair-btn" data-mount="${esc(g.cartridge.mount_point)}">
                 Appairer cette machine</button></p>`
            : ""
        }
        ${
          g.ticket && isOurs(g) && g.verdict === "expired"
            ? `<p class="pending">Ticket expiré — le renouvellement re-vérifie la propriété on-chain puis
                 réécrit un ticket frais sur la cartouche.
                 <button class="btn pair-btn" data-mount="${esc(g.cartridge.mount_point)}">
                 Renouveler (en ligne)</button></p>`
            : ""
        }
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
          const canPlay = g.verdict === "authentic" && g.cartridge.has_build && isOurs(g);
          return `
        <article class="game-card">
          <div class="cover">${esc(title.charAt(0).toUpperCase())}</div>
          <div class="body">
            <h3>${esc(title)}</h3>
            <span class="studio">${esc(g.meta.studio ?? "Studio inconnu")}</span>
            <div class="row">
              ${VERDICT_BADGE[g.verdict]}
              <button class="btn play-btn" data-mount="${esc(g.cartridge.mount_point)}" ${canPlay ? "" : "disabled"}
                title="${canPlay ? "Déchiffrer et lancer" : isOurs(g) ? "Ticket invalide ou build.enc manquant" : "Ticket scellé pour un autre appareil — appairez cette machine"}">▶ Jouer</button>
            </div>
          </div>
        </article>`;
        })
        .join("")}
    </div>`;
}

// ── Hybrid owner check (security-map launch step 5) ───────────
// Online (2s budget): live ownerOf() -> INSTANT revocation (the demo moment).
// Offline or contracts not deployed: fall back to sig + expiry, never block.

type OwnerCheck = "ok" | "revoked" | "offline";

const chainClient = DEPLOYMENTS.gameLicense
  ? createPublicClient({ transport: http(WORLDCHAIN_SEPOLIA.rpcUrl, { timeout: 2000, retryCount: 0 }) })
  : null;

async function checkOwnerOnline(t: SignedTicket): Promise<OwnerCheck> {
  if (!chainClient || !DEPLOYMENTS.gameLicense) return "offline"; // P1 pending
  try {
    const owner = await chainClient.readContract({
      address: DEPLOYMENTS.gameLicense,
      abi: [
        {
          name: "ownerOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "tokenId", type: "uint256" }],
          outputs: [{ type: "address" }],
        },
      ] as const,
      functionName: "ownerOf",
      args: [BigInt(t.tokenId)],
    });
    return owner.toLowerCase() === t.ownerAddress.toLowerCase() ? "ok" : "revoked";
  } catch {
    return "offline"; // network unreachable within 2s — offline window applies
  }
}

// ── Play ──────────────────────────────────────────────────────

async function play(g: Game): Promise<void> {
  state.playError = "";
  if (g.ticket) {
    const check = await checkOwnerOnline(g.ticket);
    if (check === "revoked") {
      state.playError = "Révoqué : cette licence a changé de propriétaire on-chain. Le nouveau propriétaire doit appairer sa machine.";
      state.ownerCheck = "révoqué ⛔";
      return render();
    }
    state.ownerCheck = check === "ok" ? "ownerOf ✔ en direct" : "hors ligne — fenêtre 30 j";
  }
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

function storeView(): string {
  return `
    <h2 class="section">Boutique</h2>
    <div class="game-grid">
      ${MOCK_EDITIONS.map((e) => {
        const owned = state.games.some((g) => g.meta.title === e.title);
        return `
        <article class="game-card">
          <div class="cover">${esc(e.title.charAt(0))}</div>
          <div class="body">
            <h3>${esc(e.title)}</h3>
            <span class="studio">${esc(e.studio)} · royalties ${e.royaltyPct} % · ${e.minted}/${e.supply} mintés</span>
            <span class="studio">${esc(e.blurb)}</span>
            <div class="row">
              <span class="price">${e.price} ETH</span>
              ${
                owned
                  ? `<span class="badge ok">✔ possédé</span>`
                  : `<button class="btn buy-btn" ${e.available ? "" : "disabled"}
                       title="${e.available ? "Le paiement s'ouvre dans le navigateur — là où vit votre wallet" : "Bientôt disponible"}">
                       Acheter ↗</button>`
              }
            </div>
          </div>
        </article>`;
      }).join("")}
    </div>
    <p class="store-note">Catalogue affiché nativement (données partagées avec le site). Seul le paiement bascule
       vers le navigateur : c'est lui qui détient votre wallet — le launcher, lui, ne touche jamais votre clé privée.</p>`;
}

const VIEWS: Record<Route, () => string> = { home: homeView, store: storeView, library: libraryView };

function render(): void {
  if (state.playing) {
    document.getElementById("view")!.innerHTML = playerView(state.playing);
    document.getElementById("quit-btn")?.addEventListener("click", () => void quit());
    return;
  }
  if (state.pairing) {
    document.getElementById("view")!.innerHTML = pairingView(state.pairing);
    document.getElementById("cancel-pairing")?.addEventListener("click", cancelPairing);
    document
      .getElementById("open-pair-url")
      ?.addEventListener("click", () => void openUrl(state.pairing!.url));
    return;
  }
  document.getElementById("tabs")!.innerHTML = `
    <button class="tab ${state.route === "home" ? "active" : ""}" data-route="home">Accueil</button>
    <button class="tab ${state.route === "store" ? "active" : ""}" data-route="store">Boutique</button>
    <button class="tab ${state.route === "library" ? "active" : ""}" data-route="library">
      Bibliothèque ${state.session ? "" : `<span class="lock">🔒</span>`}
    </button>`;

  document.getElementById("session-zone")!.innerHTML = state.session
    ? `<div class="session-chip"><span class="dot"></span>${short(state.session.address)}
         <button class="btn ghost" id="disconnect-btn">Quitter</button></div>`
    : `<button class="btn" id="connect-btn-top">Se connecter</button>`;

  document.getElementById("view")!.innerHTML = VIEWS[state.route]();

  document.getElementById("statusbar")!.innerHTML = `
    <span>${state.games.length} cartouche(s) · ${state.lastScan}${state.ownerCheck ? ` · ${state.ownerCheck}` : ""}</span>
    <span>appareil ${state.devicePubKey ? short(state.devicePubKey) : "…"} · clé au keystore OS${DEPLOYMENTS.gameLicense ? "" : " · contrats non déployés"}</span>`;

  document.querySelectorAll<HTMLButtonElement>(".tab[data-route]").forEach((b) =>
    b.addEventListener("click", () => {
      state.route = b.dataset.route as Route;
      render();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>(".buy-btn").forEach((b) =>
    b.addEventListener("click", () => void openUrl(MARKETPLACE_URL)),
  );
  document.querySelectorAll<HTMLButtonElement>(".pair-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const g = state.games.find((x) => x.cartridge.mount_point === b.dataset.mount);
      if (g) void startPairing(g);
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

window.addEventListener("DOMContentLoaded", async () => {
  loadSession();
  try {
    // Creates the device keypair in the OS keystore on first launch
    state.devicePubKey = await invoke<string>("get_device_pubkey");
  } catch (e) {
    state.lastScan = `keystore inaccessible : ${String(e)}`;
  }
  void refresh();
  setInterval(() => void refresh(), 2000);
});
