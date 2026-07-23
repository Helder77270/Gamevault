// Studio publish flow, step 1: pin the ENCRYPTED build to IPFS and print
// the CID + hash to record on-chain (GameRegistry, once P1 lands; until
// then, paste into shared/src/catalog.ts).
//
//   PINATA_JWT=<jwt> npm run publish -w station
//
// Get a free JWT: https://app.pinata.cloud -> API Keys -> New Key.
// We pin build.enc (public, encrypted bytes) — NEVER the plaintext build,
// and NEVER any key.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { putBuild } from "@gamevault/shared/storage";

const BUILD = join(dirname(fileURLToPath(import.meta.url)), "../../launcher/dev-media/gamevault/build.enc");

const jwt = process.env.PINATA_JWT;
if (!jwt) {
  console.error("❌ PINATA_JWT manquant.");
  console.error("   Compte gratuit : https://app.pinata.cloud → API Keys → New Key (admin) → copier le JWT");
  console.error("   Puis :  PINATA_JWT=<jwt> npm run publish -w station");
  process.exit(1);
}
if (!existsSync(BUILD)) {
  console.error(`❌ ${BUILD} introuvable — npm run build -w game && npm run make-dev-ticket -w shared`);
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(BUILD));
console.log(`Pinning build.enc (${(bytes.length / 1024 / 1024).toFixed(2)} Mo) vers IPFS…`);

const stored = await putBuild(bytes, "gamevault-runner-build.enc", jwt);

console.log(`\n✔ Épinglé.`);
console.log(`  CID      : ${stored.cid}`);
console.log(`  sha256   : ${stored.sha256}`);
console.log(`  Gateway  : https://gateway.pinata.cloud/ipfs/${stored.cid}`);
console.log(`\nÀ enregistrer :`);
console.log(`  - aujourd'hui : buildCid/buildSha256 de l'édition dans shared/src/catalog.ts`);
console.log(`  - après P1    : GameRegistry.createEdition(..., buildCid, buildHash)`);
