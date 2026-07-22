import { invoke } from "@tauri-apps/api/core";

interface Cartridge {
  mount_point: string;
  volume_label: string;
  ticket_json: string;
  meta_json: string | null;
  has_build: boolean;
}

// Mirrors shared/ Ticket type — will be imported from shared/ once the lib lands.
interface Ticket {
  tokenId: string;
  contract: string;
  chainId: number;
  ownerAddress: string;
  devicePubKey: string;
  wrappedContentKey: string;
  issuedAt: number;
  expiresAt: number;
}

const $ = (id: string) => document.getElementById(id)!;

function short(hex: string, n = 10): string {
  return hex.length <= 2 * n ? hex : `${hex.slice(0, n)}…${hex.slice(-4)}`;
}

function renderCartridge(c: Cartridge): string {
  let ticketRows: string;
  try {
    const t = JSON.parse(c.ticket_json) as Ticket;
    const expired = Date.now() > t.expiresAt * 1000;
    ticketRows = `
      <dl>
        <dt>Jeu (tokenId)</dt><dd>${t.tokenId} · <code>${short(t.contract)}</code></dd>
        <dt>Propriétaire</dt><dd><code>${short(t.ownerAddress)}</code></dd>
        <dt>Appareil autorisé</dt><dd><code>${short(t.devicePubKey)}</code></dd>
        <dt>Expire</dt><dd class="${expired ? "bad" : "ok"}">${new Date(t.expiresAt * 1000).toLocaleString()}</dd>
        <dt>Build chiffré</dt><dd class="${c.has_build ? "ok" : "bad"}">${c.has_build ? "présent" : "build.enc manquant"}</dd>
      </dl>
      <p class="pending">Signature plateforme : non vérifiée — prochaine étape (lib shared/)</p>`;
  } catch {
    ticketRows = `<p class="bad">ticket.json illisible (JSON invalide)</p>`;
  }
  return `
    <article class="cartridge">
      <h2>💾 ${c.volume_label || "Cartouche"} <span class="mount">${c.mount_point}</span></h2>
      ${ticketRows}
    </article>`;
}

async function refresh(): Promise<void> {
  const zone = $("cartridges");
  try {
    const found = await invoke<Cartridge[]>("scan_cartridges");
    zone.innerHTML = found.length
      ? found.map(renderCartridge).join("")
      : `<p class="waiting">En attente d'une cartouche… insérez une clé USB ou une carte SD GameVault.</p>`;
    $("status").textContent = `Dernier scan : ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    zone.innerHTML = `<p class="bad">Erreur de scan : ${String(e)}</p>`;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  void refresh();
  setInterval(() => void refresh(), 2000);
});
