// Executable proof of the crypto core. Run: npm run selftest -w shared
// Simulates the full key story with zero network and zero blockchain:
// publication -> pairing -> wrap -> unwrap -> tamper attempts.

import { secp256k1 } from "@noble/curves/secp256k1";
import { randomBytes } from "@noble/hashes/utils";
import { wrapKey, unwrapKey } from "./ecies.ts";
import { signTicket, verifyTicket, isExpired, hex, unhex, type Ticket } from "./ticket.ts";
import { CHAIN } from "./deployments.ts";
import { encryptBuild, decryptBuild } from "./buildcrypto.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
}

// --- Publication: platform key + AES content key are born (ticketd side)
const platformPriv = secp256k1.utils.randomPrivateKey();
const platformPub = secp256k1.getPublicKey(platformPriv, true); // embedded in launcher
const contentKey = randomBytes(32); // encrypts the game build, once

// --- Pairing: the device keypair is born (launcher side, OS keystore)
const devicePriv = secp256k1.utils.randomPrivateKey();
const devicePub = secp256k1.getPublicKey(devicePriv, true); // travels in the QR

// --- ticketd wraps the content key to the device and signs the ticket
const envelope = wrapKey(contentKey, devicePub);
const now = Math.floor(Date.now() / 1000);
const ticket: Ticket = {
  tokenId: "1",
  contract: "0x1111111111111111111111111111111111111111",
  chainId: CHAIN.id,
  ownerAddress: "0x2222222222222222222222222222222222222222",
  devicePubKey: hex(devicePub),
  wrappedContentKey: hex(envelope),
  issuedAt: now,
  expiresAt: now + 30 * 24 * 3600,
};
const signed = signTicket(ticket, platformPriv);

// --- Launch: verify, unwrap, compare
check("ticket signature verifies with the embedded platform pubkey", verifyTicket(signed, platformPub));
check("ticket is not expired (30-day window)", !isExpired(signed));

const recovered = unwrapKey(unhex(signed.wrappedContentKey), devicePriv);
check("device key opens the envelope -> content key recovered", hex(recovered) === hex(contentKey));

// --- Attacks
const strangerPriv = secp256k1.utils.randomPrivateKey();
let strangerFailed = false;
try {
  unwrapKey(unhex(signed.wrappedContentKey), strangerPriv);
} catch {
  strangerFailed = true; // GCM tag mismatch -> throws
}
check("another machine's key CANNOT open the envelope", strangerFailed);

const forged = { ...signed, ownerAddress: "0x3333333333333333333333333333333333333333" };
check("tampered ticket (owner swapped) fails verification", !verifyTicket(forged, platformPub));

const expired = signTicket({ ...ticket, expiresAt: now - 1 }, platformPriv);
check("expired ticket detected", isExpired(expired));

// --- Build encryption (the launcher's Rust core mirrors decryptBuild)
const build = new TextEncoder().encode("<!doctype html><title>game</title>");
const sealed = encryptBuild(build, contentKey);
check("build round-trips with its content key", hex(decryptBuild(sealed, contentKey)) === hex(build));
let wrongKeyFailed = false;
try {
  decryptBuild(sealed, randomBytes(32));
} catch {
  wrongKeyFailed = true;
}
check("build does NOT open with another key", wrongKeyFailed);

console.log(failures === 0 ? "\nAll checks passed — crypto core is sound." : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
