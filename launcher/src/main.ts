import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import QRCode from "qrcode";
import { createPublicClient, http } from "viem";
import { verifyTicket, isExpired, unhex, type SignedTicket } from "@gamevault/shared";
import { fetchOnchainCatalog, BLURBS, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { DEPLOYMENTS, CHAIN } from "@gamevault/shared/deployments";
import { fetchBuild } from "@gamevault/shared/storage";
import { LICENSE_ABI, MARKETPLACE_ABI } from "@gamevault/shared/abi";

// Browsing is data — the full catalog renders natively in the launcher.
// Only the PAYMENT needs the wallet, so only checkout jumps to the system
// browser (where the wallet lives). Same split Steam uses for its checkout.
const MARKETPLACE_URL = "http://localhost:3000";

// Platform public keys embedded in the launcher. First: the real platform
// key (matches ticketd/.env PLATFORM_PRIVKEY). Second: the deterministic
// dev key, kept so local fixtures (make-dev-ticket) still verify.
const PLATFORM_PUBS = [
  unhex("0x0314864d3e6672b07e9a046c044f329cc38c7ad7c3af7075b4d54e273bddbc1149"),
  unhex("0x038d78e7c9ea67e401f6e9dbf8fccae4563dc21c0e3f569338012ba95c50700f2b"),
];

const verifyPlatformSig = (t: SignedTicket): boolean => PLATFORM_PUBS.some((k) => verifyTicket(t, k));

interface Cartridge {
  mount_point: string;
  volume_label: string;
  ticket_json: string;
  meta_json: string | null;
  has_build: boolean;
}

type Verdict = "authentic" | "tampered" | "expired" | "unreadable" | "unpaired";

interface Volume {
  mount_point: string;
  volume_label: string;
  has_gamevault: boolean;
}

interface Game {
  cartridge: Cartridge;
  ticket: SignedTicket | null;
  meta: { title?: string; studio?: string; edition?: string };
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
  /** per-mount-point download status message */
  dlStatus: {} as Record<string, string>,
  /** on-chain market state per tokenId (10s refresh) */
  market: {} as Record<string, { owner: string; seller: string; price: bigint }>,
  /** tokenId whose sell-price input is open */
  selling: null as string | null,
  /** SD-card install flow in progress */
  installing: null as { edition: OnchainEdition; volumes: Volume[]; status: string; tokenId: string } | null,
  /** on-chain catalog (editionCount enumeration) — no mock data */
  catalog: [] as OnchainEdition[],
  /** licences owned by the session/watched address (nextTokenId sweep) */
  owned: [] as { tokenId: string; editionId: string }[],
};

/** Address whose licences we display: paired session, else watch-only. */
function libraryAddress(): string {
  return state.session?.address ?? localStorage.getItem("gv-watch") ?? "";
}

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
  // Freshly installed cartridge: placeholder ticket awaiting first pairing
  if (ticket.platformSignature === "0x") return { cartridge: c, ticket, meta, verdict: "unpaired" };
  if (!verifyPlatformSig(ticket)) return { cartridge: c, ticket, meta, verdict: "tampered" };
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
  if (!verifyPlatformSig(ticket) || ticket.devicePubKey.toLowerCase() !== state.devicePubKey.toLowerCase()) {
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
  unpaired: `<span class="badge warn">🆕 installée — à appairer</span>`,
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
      <dt>Édition</dt><dd>#${esc(g.meta.edition ?? editionFor(g)?.editionId ?? "?")} · chaîne ${t.chainId}</dd>
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
          g.ticket && !g.cartridge.has_build
            ? editionFor(g)
              ? `<p class="pending">Build absent — récupérable depuis IPFS, intégrité vérifiée contre le hash
                   publié. <button class="btn dl-btn" data-mount="${esc(g.cartridge.mount_point)}"
                   ${state.dlStatus[g.cartridge.mount_point]?.startsWith("Télé") ? "disabled" : ""}>
                   ⬇ Télécharger le build</button>
                   ${state.dlStatus[g.cartridge.mount_point] ? `<span class="dl-status">${esc(state.dlStatus[g.cartridge.mount_point])}</span>` : ""}</p>`
              : `<p class="pending">Build absent et aucun CID publié pour ce titre — écrivez la cartouche
                   via la station (npm run write -w station).</p>`
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

function ownedSection(): string {
  const addr = libraryAddress();
  if (!addr) return "";
  const rows = state.owned
    .map((o) => {
      const cat = state.catalog.find((c) => c.editionId === o.editionId);
      const onCard = state.games.some((g) => g.ticket?.tokenId === o.tokenId && g.verdict !== "tampered");
      return `<li>
        🎫 Licence <b>#${esc(o.tokenId)}</b> — ${esc(cat?.title ?? `édition #${o.editionId}`)}
        <span class="debug">éd. #${esc(o.editionId)}</span>
        ${
          onCard
            ? `<span class="badge ok">sur cartouche</span>`
            : cat
              ? `<button class="btn install-owned-btn" data-token="${esc(o.tokenId)}" data-edition="${esc(o.editionId)}">
                   💾 Installer sur une carte SD</button>`
              : `<span class="badge warn">édition inconnue du catalogue</span>`
        }
      </li>`;
    })
    .join("");
  return `
    <h2 class="section">Mes licences on-chain — ${short(addr)}</h2>
    ${state.owned.length ? `<ul class="owned">${rows}</ul>` : `<p class="waiting">Aucune licence pour cette adresse (🔄 après un achat).</p>`}`;
}

function libraryView(): string {
  if (!libraryAddress()) {
    return `
      <div class="locked">
        <div class="big">🔒</div>
        <h2>Bibliothèque verrouillée</h2>
        <p>Appairez une cartouche pour vous connecter — ou suivez votre adresse en lecture seule
           pour voir vos licences et les installer.</p>
        <button class="btn" id="connect-btn">Se connecter</button>
        <p style="margin-top:1rem">
          <input id="watch-addr" placeholder="0x… votre adresse wallet" style="width:22rem" />
          <button class="btn ghost" id="watch-btn">Suivre</button>
        </p>
      </div>`;
  }
  const playable = state.games;
  if (!playable.length) {
    return `${ownedSection()}
      <h2 class="section">Cartouches insérées</h2>
      <p class="waiting">Aucune cartouche détectée — installez une licence ci-dessus sur une carte SD.</p>`;
  }
  return `
    ${ownedSection()}
    <h2 class="section">Cartouches insérées</h2>
    ${
      state.playError
        ? `<p class="play-error">⛔ Lancement refusé : ${esc(state.playError)}${
            state.playError.includes("déchiffrement du build")
              ? ` — le fichier est peut-être corrompu ; repassez par l'Accueil pour re-télécharger le build depuis IPFS.`
              : ""
          }</p>`
        : ""
    }
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
            ${
              g.ticket && !isOurs(g)
                ? `<div class="row"><button class="btn ghost pair-btn" data-mount="${esc(g.cartridge.mount_point)}">
                     🔗 Appairer cette machine</button></div>`
                : ""
            }
            ${g.verdict === "authentic" ? marketControls(g) : ""}
          </div>
        </article>`;
        })
        .join("")}
    </div>`;
}

// ── P3: verified re-download ──────────────────────────────────
// "You own the game" made tangible: cartridge damaged/wiped -> pull the
// PUBLIC encrypted build back from IPFS, verify it against the published
// hash (the gateway is untrusted), rewrite it on the cartridge. The
// ticket — not the bytes — is what makes it playable.

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
  state.dlStatus[mount] = "Téléchargement + vérification d'intégrité…";
  render();
  try {
    const bytes = await fetchBuild(ed.buildCid, ed.buildSha256);
    // chunked base64 (1 MB+ would blow the stack with a single fromCharCode)
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    await invoke("write_build", { mountPoint: mount, dataB64: btoa(bin) });
    delete state.dlStatus[mount];
  } catch (e) {
    state.dlStatus[mount] = `Échec : ${String(e)}`;
  }
  await refresh();
}

// ── Install onto a real SD/USB card ───────────────────────────
// THE product flow: blank card in the reader -> verified encrypted build
// written onto it + a placeholder ticket the pairing flow replaces.

async function openInstall(edition: OnchainEdition, prefillTokenId = ""): Promise<void> {
  const volumes = await invoke<Volume[]>("list_removable_volumes");
  state.installing = { edition, volumes, status: "", tokenId: prefillTokenId };
  render();
}

async function installTo(volume: Volume): Promise<void> {
  const inst = state.installing;
  if (!inst?.edition.buildCid) return;
  const tokenId = (document.getElementById("install-token") as HTMLInputElement | null)?.value.trim() ?? "";
  if (!/^\d+$/.test(tokenId)) {
    inst.status = "Indiquez le n° de votre licence (affiché à l'achat : « token #N minté »)";
    return render();
  }
  // Guard: the licence must belong to THIS edition, or pairing would seal
  // the wrong game's content key (undecipherable build, cryptic error)
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
        inst.status = `⛔ Le token #${tokenId} est une licence de l'édition #${ed}${other ? ` (« ${other.title} »)` : ""}, pas de « ${inst.edition.title} » (éd. #${inst.edition.editionId}).`;
        return render();
      }
    } catch {
      inst.status = `⛔ Token #${tokenId} introuvable on-chain — achetez d'abord la licence sur la marketplace.`;
      return render();
    }
  }
  inst.status = `Téléchargement IPFS + vérification d'intégrité…`;
  render();
  try {
    const bytes = await fetchBuild(inst.edition.buildCid, inst.edition.buildSha256);
    inst.status = `Écriture sur ${volume.mount_point}…`;
    render();
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const meta = {
      title: inst.edition.title,
      studio: inst.edition.studio,
      edition: inst.edition.editionId,
      version: "0.1.0",
    };
    // Placeholder ticket: carries tokenId+contract so the pairing flow can
    // run; platformSignature "0x" marks it as awaiting its real ticket.
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
    state.installing = null;
    state.route = "home"; // the new cartridge appears there within 2s
  } catch (e) {
    inst.status = `Échec : ${String(e)}`;
  }
  await refresh();
}

function installView(inst: NonNullable<typeof state.installing>): string {
  return `
    <div class="modal-overlay">
      <div class="modal">
        <h2>💾 Installer « ${esc(inst.edition.title)} » sur une carte</h2>
        <p>Le build chiffré est téléchargé depuis IPFS, vérifié contre le hash publié, puis écrit sur le
           support. Il faudra ensuite appairer la machine (licence requise).</p>
        <p><label>N° de votre licence (tokenId, affiché à l'achat) :
          <input id="install-token" type="text" inputmode="numeric" placeholder="ex. 2"
            value="${esc(inst.tokenId)}" style="width:6rem" /></label></p>
        ${
          inst.volumes.length
            ? inst.volumes
                .map(
                  (v) => `<button class="btn install-target-btn" data-mount="${esc(v.mount_point)}">
                    ${esc(v.volume_label || "Volume")} — ${esc(v.mount_point)}
                    ${v.has_gamevault ? " (cartouche existante — sera remplacée)" : ""}</button>`,
                )
                .join("")
            : `<p class="hint">Aucun volume amovible détecté — insérez une carte SD ou une clé USB.</p>`
        }
        ${inst.status ? `<p class="hint">${esc(inst.status)}</p>` : ""}
        <button class="btn ghost" id="cancel-install">Annuler</button>
      </div>
    </div>`;
}

// ── Live market state (launcher = the marketplace UI; the browser
//    is only the signature surface, /trade) ─────────────────────

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

async function fetchMarketState(): Promise<void> {
  if (!chainClient || !DEPLOYMENTS.gameLicense || !DEPLOYMENTS.marketplace) return;
  for (const g of state.games) {
    if (!g.ticket) continue;
    const id = BigInt(g.ticket.tokenId);
    try {
      const [owner, listing] = await Promise.all([
        chainClient.readContract({
          address: DEPLOYMENTS.gameLicense,
          abi: LICENSE_ABI,
          functionName: "ownerOf",
          args: [id],
        }),
        chainClient.readContract({
          address: DEPLOYMENTS.marketplace,
          abi: MARKETPLACE_ABI,
          functionName: "listings",
          args: [id],
        }),
      ]);
      state.market[g.ticket.tokenId] = { owner, seller: listing[0], price: listing[1] };
    } catch {
      /* offline or token unknown — leave previous state */
    }
  }
}

/** Sweep 1..nextTokenId for licences owned by the library address. */
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
        const o = await chainClient.readContract({
          address: DEPLOYMENTS.gameLicense,
          abi: LICENSE_ABI,
          functionName: "ownerOf",
          args: [i],
        });
        if (o.toLowerCase() === addr.toLowerCase()) {
          const ed = await chainClient.readContract({
            address: DEPLOYMENTS.gameLicense,
            abi: LICENSE_ABI,
            functionName: "editionOf",
            args: [i],
          });
          owned.push({ tokenId: i.toString(), editionId: ed.toString() });
        }
      } catch {
        /* burned/nonexistent — skip */
      }
    }
    state.owned = owned;
  } catch {
    /* offline — keep previous */
  }
}

function tradeUrl(action: "list" | "unlist" | "buy", tokenId: string, priceEth?: string): string {
  const p = priceEth ? `&price=${encodeURIComponent(priceEth)}` : "";
  return `${MARKETPLACE_URL}/trade?action=${action}&token=${encodeURIComponent(tokenId)}${p}`;
}

/** Market block for a library card: sell / unlist / resold states. */
function marketControls(g: Game): string {
  if (!g.ticket || !DEPLOYMENTS.marketplace) return "";
  const m = state.market[g.ticket.tokenId];
  if (!m) return "";
  const t = g.ticket.tokenId;

  // Resold: chain owner no longer matches the ticket — the buyer must pair
  if (m.owner.toLowerCase() !== g.ticket.ownerAddress.toLowerCase()) {
    return `<p class="market resold">⛔ Revendue on-chain — le nouveau propriétaire (${short(m.owner)})
      doit appairer sa machine (bouton Appairer sur l'Accueil).</p>`;
  }
  if (!isOurs(g)) return "";

  // Listed by us
  if (m.seller.toLowerCase() !== ZERO_ADDR) {
    return `<p class="market">🏷 En vente — <b>${formatEth(m.price)} ETH</b>
      <button class="btn ghost unlist-btn" data-token="${esc(t)}">Retirer ↗</button></p>`;
  }
  // Not listed: sell flow (inline price input)
  if (state.selling === t) {
    return `<p class="market">
      <input id="sell-price" type="text" inputmode="decimal" placeholder="prix en ETH" />
      <button class="btn confirm-sell-btn" data-token="${esc(t)}">Mettre en vente ↗</button>
      <button class="btn ghost cancel-sell-btn">Annuler</button></p>`;
  }
  return `<p class="market"><button class="btn ghost sell-btn" data-token="${esc(t)}">💰 Vendre</button></p>`;
}

function formatEth(wei: bigint): string {
  const s = (Number(wei) / 1e18).toString();
  return s.length > 10 ? s.slice(0, 10) : s;
}

// ── Hybrid owner check (security-map launch step 5) ───────────
// Online (2s budget): live ownerOf() -> INSTANT revocation (the demo moment).
// Offline or contracts not deployed: fall back to sig + expiry, never block.

type OwnerCheck = "ok" | "revoked" | "offline";

const chainClient = DEPLOYMENTS.gameLicense
  ? createPublicClient({ transport: http(CHAIN.rpcUrl, { timeout: 2000, retryCount: 0 }) })
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
  if (!state.catalog.length) {
    return `<h2 class="section">Boutique</h2>
      <p class="waiting">${DEPLOYMENTS.gameRegistry ? "Lecture du catalogue on-chain…" : "Contrats non déployés — aucun catalogue."}</p>`;
  }
  return `
    <h2 class="section">Boutique — ${state.catalog.length} édition(s) on-chain</h2>
    <div class="game-grid">
      ${state.catalog
        .map((e) => {
          const owned = state.games.some(
            (g) => g.verdict === "authentic" && (g.meta.edition === e.editionId || g.meta.title === e.title),
          );
          const soldOut = e.minted >= e.supply;
          return `
        <article class="game-card">
          <div class="cover">${esc(e.title.charAt(0))}</div>
          <div class="body">
            <h3>${esc(e.title)}</h3>
            <span class="studio">${esc(e.studio)} · royalties ${e.royaltyBps / 100} % · ${e.minted}/${e.supply} mintés</span>
            ${BLURBS[e.editionId] ? `<span class="studio">${esc(BLURBS[e.editionId])}</span>` : ""}
            <span class="debug">éd. #${e.editionId} · jeu #${e.gameId} · studio #${e.studioId} · cid ${esc(e.buildCid.slice(0, 10))}…${esc(e.buildCid.slice(-4))}</span>
            <div class="row">
              <span class="price">${formatEth(e.priceWei)} ETH</span>
              ${
                owned
                  ? `<span class="badge ok">✔ possédé</span>`
                  : `<button class="btn buy-btn" ${soldOut ? "disabled" : ""}
                       title="${soldOut ? "Épuisé" : "Le paiement s'ouvre dans le navigateur — là où vit votre wallet"}">
                       Acheter ↗</button>`
              }
            </div>
            <div class="row"><button class="btn ghost install-btn" data-edition="${esc(e.editionId)}">
              💾 Installer sur une carte SD</button></div>
          </div>
        </article>`;
        })
        .join("")}
    </div>
    <p class="store-note">Catalogue lu directement sur Base Sepolia (GameRegistry ${esc(short(DEPLOYMENTS.gameRegistry || ""))}) —
       aucune donnée factice. Seul le paiement bascule vers le navigateur : c'est lui qui détient votre wallet.</p>`;
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
  if (state.installing) {
    document.getElementById("view")!.innerHTML = installView(state.installing);
    document.getElementById("cancel-install")?.addEventListener("click", () => {
      state.installing = null;
      render();
    });
    document.querySelectorAll<HTMLButtonElement>(".install-target-btn").forEach((b) =>
      b.addEventListener("click", () => {
        const v = state.installing?.volumes.find((x) => x.mount_point === b.dataset.mount);
        if (v) void installTo(v);
      }),
    );
    return;
  }
  document.getElementById("tabs")!.innerHTML = `
    <button class="tab ${state.route === "home" ? "active" : ""}" data-route="home">Accueil</button>
    <button class="tab ${state.route === "store" ? "active" : ""}" data-route="store">Boutique</button>
    <button class="tab ${state.route === "library" ? "active" : ""}" data-route="library">
      Bibliothèque ${state.session ? "" : `<span class="lock">🔒</span>`}
    </button>
    <button class="tab" id="refresh-btn" title="Rescanner cartouches + catalogue + marché maintenant">🔄</button>`;

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
  document.getElementById("refresh-btn")?.addEventListener("click", () => void forceRefresh());
  document.getElementById("watch-btn")?.addEventListener("click", () => {
    const addr = (document.getElementById("watch-addr") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      alert("Adresse invalide — format 0x + 40 caractères hexadécimaux");
      return;
    }
    localStorage.setItem("gv-watch", addr);
    void forceRefresh();
  });
  document.querySelectorAll<HTMLButtonElement>(".install-owned-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const e = state.catalog.find((x) => x.editionId === b.dataset.edition);
      if (e) void openInstall(e, b.dataset.token ?? "");
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
  document.querySelectorAll<HTMLButtonElement>(".dl-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const g = state.games.find((x) => x.cartridge.mount_point === b.dataset.mount);
      if (g) void downloadBuild(g);
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
  document.querySelectorAll<HTMLButtonElement>(".sell-btn").forEach((b) =>
    b.addEventListener("click", () => {
      state.selling = b.dataset.token ?? null;
      render();
      document.getElementById("sell-price")?.focus();
    }),
  );
  document.querySelector<HTMLButtonElement>(".cancel-sell-btn")?.addEventListener("click", () => {
    state.selling = null;
    render();
  });
  document.querySelectorAll<HTMLButtonElement>(".confirm-sell-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const price = (document.getElementById("sell-price") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!/^\d*\.?\d+$/.test(price)) {
        alert("Prix invalide — exemple : 0.00002");
        return;
      }
      state.selling = null;
      void openUrl(tradeUrl("list", b.dataset.token!, price));
      render();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>(".unlist-btn").forEach((b) =>
    b.addEventListener("click", () => void openUrl(tradeUrl("unlist", b.dataset.token!))),
  );
  document.querySelectorAll<HTMLButtonElement>(".install-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const e = state.catalog.find((x) => x.editionId === b.dataset.edition);
      if (e) void openInstall(e);
    }),
  );
}

// ── Scan loop ─────────────────────────────────────────────────

let scanCount = 0;

/** Manual refresh: cartridges + on-chain catalog + market state, now. */
async function forceRefresh(): Promise<void> {
  state.lastScan = "actualisation…";
  render();
  try {
    state.catalog = await fetchOnchainCatalog(chainClient ?? undefined);
  } catch {
    /* offline — keep previous catalog */
  }
  await refresh();
  await fetchMarketState();
  await fetchOwned();
  render();
}

async function refresh(): Promise<void> {
  if (state.playing) return; // don't re-render (and destroy the iframe) mid-game
  try {
    const found = await invoke<Cartridge[]>("scan_cartridges");
    state.games = found.map(judge);
    state.lastScan = `scan ${new Date().toLocaleTimeString()}`;
    // market state every 5th scan (~10s), catalog every 15th (~30s) —
    // the public RPC is not a websocket
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
