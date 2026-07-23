// Regenerates the launcher's dev-media fixture with a properly signed
// ticket. Run: npm run make-dev-ticket -w shared

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { wrapKey } from "./ecies.ts";
import { encryptBuild } from "./buildcrypto.ts";
import { signTicket, hex, type Ticket } from "./ticket.ts";
import { DEV_PLATFORM_PRIV, DEV_DEVICE_PUB, DEV_CONTENT_KEY } from "./devkeys.ts";
import { CHAIN } from "./deployments.ts";

const now = Math.floor(Date.now() / 1000);
const contentKey = DEV_CONTENT_KEY; // deterministic — ticketd wraps the same key

const ticket: Ticket = {
  tokenId: "1",
  contract: "0x0000000000000000000000000000000000000001",
  chainId: CHAIN.id,
  ownerAddress: "0x000000000000000000000000000000000000dEaD",
  devicePubKey: hex(DEV_DEVICE_PUB),
  wrappedContentKey: hex(wrapKey(contentKey, DEV_DEVICE_PUB)),
  issuedAt: now,
  expiresAt: now + 30 * 24 * 3600,
};

const signed = signTicket(ticket, DEV_PLATFORM_PRIV);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const gv = join(root, "launcher/dev-media/gamevault");
writeFileSync(join(gv, "ticket.json"), JSON.stringify(signed, null, 2) + "\n");
console.log(`Signed dev ticket written (expires ${new Date(ticket.expiresAt * 1000).toISOString()})`);

// Encrypt the game build with the SAME content key the ticket wraps —
// ticket and build.enc must always be regenerated together.
const bundle = join(root, "game/dist/index.html");
if (existsSync(bundle)) {
  const enc = encryptBuild(readFileSync(bundle), contentKey);
  writeFileSync(join(gv, "build.enc"), enc);
  console.log(`build.enc written (${(enc.length / 1024 / 1024).toFixed(2)} MB)`);
} else {
  console.warn("game/dist/index.html missing — run `npm run build -w game` first; build.enc NOT written");
}
