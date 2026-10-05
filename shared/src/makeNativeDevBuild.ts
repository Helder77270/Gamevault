// Swaps the dev cartridge's build for the NATIVE test exe, encrypted with
// the exact content key ticketd wraps into the dev ticket (token 1) — so
// the existing paired ticket keeps opening it. The previous build.enc is
// backed up alongside as build.enc.bak (swap back by renaming).
// Run: npm run make-native-dev-build -w shared

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { encryptBuild } from "./buildcrypto.ts";
import { devContentKeyFor } from "./devkeys.ts";
import { DEPLOYMENTS } from "./deployments.ts";
import { LICENSE_ABI, REGISTRY_ABI } from "./abi.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const exePath = join(root, "game/native-test/target/release/native-test.exe");
if (!existsSync(exePath)) {
  console.error("native-test.exe missing — run `cargo build --release` in game/native-test first");
  process.exit(1);
}

const gv = join(root, "launcher/dev-media/gamevault");
const ticket = JSON.parse(readFileSync(join(gv, "ticket.json"), "utf8"));
const tokenId: string = ticket.tokenId;

// Mirror ticketd's contentKeyFor(): on-chain edition -> CID -> stored key,
// else the deterministic dev key for that edition.
const unhex = (h: string): Uint8Array =>
  Uint8Array.from((h.replace(/^0x/, "").match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));

async function contentKeyFor(tid: string): Promise<Uint8Array> {
  let editionId = "2";
  if (DEPLOYMENTS.gameLicense) {
    const client = createPublicClient({ chain: baseSepolia, transport: http() });
    const ed = await client.readContract({
      address: DEPLOYMENTS.gameLicense as `0x${string}`,
      abi: LICENSE_ABI,
      functionName: "editionOf",
      args: [BigInt(tid)],
    });
    editionId = ed.toString();
    if (DEPLOYMENTS.gameRegistry) {
      const edition = await client.readContract({
        address: DEPLOYMENTS.gameRegistry as `0x${string}`,
        abi: REGISTRY_ABI,
        functionName: "editions",
        args: [BigInt(editionId)],
      });
      const keysPath = join(root, "ticketd/data/content-keys.json");
      if (existsSync(keysPath)) {
        const stored = JSON.parse(readFileSync(keysPath, "utf8"))[edition[4] as string];
        if (stored) {
          console.log(`clé: store ticketd (édition ${editionId}, CID on-chain)`);
          return unhex(stored);
        }
      }
    }
  }
  console.log(`clé: dev déterministe (édition ${editionId})`);
  return devContentKeyFor(editionId);
}

const key = await contentKeyFor(tokenId);
const prev = join(gv, "build.enc");
if (existsSync(prev) && !existsSync(prev + ".bak")) copyFileSync(prev, prev + ".bak");

const enc = encryptBuild(readFileSync(exePath), key);
writeFileSync(prev, enc);
writeFileSync(
  join(gv, "meta.json"),
  JSON.stringify(
    { title: "Native Runtime Test", studio: "GameVault Dev", edition: "2", version: "0.1.0" },
    null,
    2,
  ) + "\n",
);
console.log(`build.enc <- native-test.exe chiffré (${(enc.length / 1024).toFixed(0)} Ko) · ancien build sauvé en build.enc.bak`);
