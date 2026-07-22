// Regenerates the launcher's dev-media fixture with a properly signed
// ticket. Run: npm run make-dev-ticket -w shared

import { randomBytes } from "@noble/hashes/utils";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { wrapKey } from "./ecies.ts";
import { signTicket, hex, type Ticket } from "./ticket.ts";
import { DEV_PLATFORM_PRIV, DEV_DEVICE_PUB } from "./devkeys.ts";

const now = Math.floor(Date.now() / 1000);
const contentKey = randomBytes(32);

const ticket: Ticket = {
  tokenId: "1",
  contract: "0x0000000000000000000000000000000000000001",
  chainId: 4801,
  ownerAddress: "0x000000000000000000000000000000000000dEaD",
  devicePubKey: hex(DEV_DEVICE_PUB),
  wrappedContentKey: hex(wrapKey(contentKey, DEV_DEVICE_PUB)),
  issuedAt: now,
  expiresAt: now + 30 * 24 * 3600,
};

const signed = signTicket(ticket, DEV_PLATFORM_PRIV);
const out = join(dirname(fileURLToPath(import.meta.url)), "../../launcher/dev-media/gamevault/ticket.json");
writeFileSync(out, JSON.stringify(signed, null, 2) + "\n");
console.log(`Signed dev ticket written to ${out}`);
console.log(`Expires: ${new Date(ticket.expiresAt * 1000).toISOString()}`);
