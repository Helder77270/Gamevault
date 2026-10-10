// Heavy test game (P8 #6) — a ~480 MiB build to exercise the download
// manager for real: 120 chunks of 4 MiB, pause/resume, parallel workers,
// speed limit, repair of damaged chunks, IPFS fallback.
//
// The build stays PLAYABLE: it is the native test game (game/native-test)
// with ~480 MiB of incompressible filler appended after the executable
// (Windows ignores data past the PE image). The filler is a deterministic
// AES-CTR keystream: generated locally, never downloaded from anywhere.
//
// Then, like a studio publish: encrypt once (AES-256-GCM, same layout as
// shared/buildcrypto.ts), pin to IPFS (Pinata), keep the content key
// (encrypted at rest) + a local copy for ticketd /build, register the
// edition on-chain, buy one licence and send it to the player's wallet.
//
// Read-only by default. `--apply` does it (testnet ETH from
// DEV_WALLET_PRIVKEY). Resumable: progress is kept in data/bigbuild.json.
//
//   npm run bigbuild -w @gamevault/ticketd -- [--apply] [--to 0x…] [--mib 480]

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeEventLog, formatEther, http, parseEther, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { LICENSE_ABI, REGISTRY_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";
import { getContentKey, putContentKey } from "./db.ts";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const APPLY = argv.includes("--apply");
const TO = opt("to", "0xbDdE8af0AfE38Eb897F87177d3B10efCd5673f02").toLowerCase(); // Helder's wallet
const MIB = Number(opt("mib", "480")); // stays under the 512 MiB IPFS refill cap of ticketd
const TITLE = "Stress Test 500";
const PRICE = parseEther("0.000001");
if (!/^0x[0-9a-f]{40}$/.test(TO) || !Number.isInteger(MIB) || MIB < 8 || MIB > 500) {
  console.error("❌ --to : adresse 0x… ; --mib : 8 à 500");
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "../data");
const STATE_FILE = join(DATA, "bigbuild.json");
const EXE = join(HERE, "../../game/native-test/target/release/native-test.exe");
const BUILDS_DIR = join(DATA, "builds");

type Progress = { cid?: string; sha256?: string; size?: number; gameId?: string; editionId?: string; tokenId?: string; sentTo?: string };
const progress: Progress = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(progress, null, 2));

const REGISTRY = DEPLOYMENTS.gameRegistry as `0x${string}`;
const LICENSE = DEPLOYMENTS.gameLicense as `0x${string}`;
const TRANSFER_ABI = [
  { name: "transferFrom", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [] },
] as const satisfies Abi;

const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL || undefined) });
const devKey = process.env.DEV_WALLET_PRIVKEY;
const dev = devKey ? privateKeyToAccount((devKey.startsWith("0x") ? devKey : `0x${devKey}`) as `0x${string}`) : null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

type Call = { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint };
async function send(label: string, params: Call) {
  if (!dev) throw new Error("DEV_WALLET_PRIVKEY absent");
  const wallet = createWalletClient({ account: dev, chain: baseSepolia, transport: http(process.env.RPC_URL || undefined) });
  for (let attempt = 1; ; attempt++) {
    try {
      const { request: req } = await pub.simulateContract({ ...params, account: dev } as never);
      const hash = await wallet.writeContract(req as never);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${label} : transaction annulée`);
      console.log(`   ✔ ${label} · ${hash}`);
      await sleep(4000); // the load-balanced RPC catches up before the next read
      return receipt;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(4000);
    }
  }
}

/** The player-facing build: native game + deterministic filler. */
function makePlain(): Buffer {
  const exe = readFileSync(EXE);
  if (exe[0] !== 0x4d || exe[1] !== 0x5a) throw new Error("native-test.exe n'est pas un exécutable PE");
  const total = MIB * 1024 * 1024;
  if (total <= exe.length) throw new Error("taille demandée plus petite que l'exécutable");
  const key = createHash("sha256").update("gamevault-bigbuild-v1").digest();
  const filler = createCipheriv("aes-256-ctr", key, Buffer.alloc(16)).update(Buffer.alloc(total - exe.length));
  return Buffer.concat([exe, filler]);
}

/** Same layout as shared/buildcrypto.ts: [12B nonce][ciphertext + 16B tag]. */
function encrypt(plain: Buffer, contentKey: Buffer): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", contentKey, nonce);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]);
}

/** Pinata upload as a raw multipart stream (no client timeout: it is big). */
function pin(bytes: Buffer, name: string, jwt: string): Promise<string> {
  const boundary = `----gamevault${randomBytes(8).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="pinataMetadata"\r\n\r\n${JSON.stringify({ name })}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: "POST",
        host: "api.pinata.cloud",
        path: "/pinning/pinFileToIPFS",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": head.length + bytes.length + tail.length },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`Pinata ${res.statusCode}: ${body.slice(0, 300)}`));
          resolve((JSON.parse(body) as { IpfsHash: string }).IpfsHash);
        });
      },
    );
    req.on("error", reject);
    let sent = 0;
    const total = bytes.length;
    const ticker = setInterval(() => process.stdout.write(`\r   ↑ Pinata ${mb(sent)} / ${mb(total)}   `), 2000);
    req.write(head);
    const step = 4 * 1024 * 1024;
    const pump = (off: number): void => {
      while (off < total) {
        const end = Math.min(off + step, total);
        sent = end;
        const ok = req.write(bytes.subarray(off, end));
        off = end;
        if (!ok) {
          req.once("drain", () => pump(off));
          return;
        }
      }
      clearInterval(ticker);
      process.stdout.write(`\r   ↑ Pinata ${mb(total)} envoyés, attente de la réponse…\n`);
      req.end(tail);
    };
    pump(0);
  });
}

async function main(): Promise<void> {
  console.log(`\n▶ Jeu de test lourd « ${TITLE} » (${MIB} MiB) → licence pour ${TO}`);
  console.log(`  dev wallet : ${dev?.address ?? "ABSENT"}`);
  if (dev) console.log(`  solde      : ${formatEther(await pub.getBalance({ address: dev.address }))} ETH (Base Sepolia)`);
  const [studioOwner, studioName] = await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "studios", args: [1n] });
  console.log(`  studio #1  : ${studioName} (${studioOwner})`);
  console.log(`  progression: ${JSON.stringify(progress)}`);
  if (!APPLY) {
    console.log("\n(lecture seule — ajouter --apply pour publier)\n");
    return;
  }
  if (!dev || studioOwner.toLowerCase() !== dev.address.toLowerCase()) throw new Error("le dev wallet doit posséder le studio #1");

  // 1. build -> encrypt -> pin -> key + local copy
  if (!progress.cid) {
    const jwt = process.env.PINATA_JWT;
    if (!jwt) throw new Error("PINATA_JWT absent");
    console.log("1. génération du build jouable…");
    const plain = makePlain();
    const contentKey = randomBytes(32);
    console.log(`   ${mb(plain.length)} en clair → chiffrement AES-256-GCM…`);
    const enc = encrypt(plain, contentKey);
    const sha256 = `0x${createHash("sha256").update(enc).digest("hex")}`;
    console.log(`   build.enc ${mb(enc.length)} · sha256 ${sha256.slice(0, 18)}…`);
    console.log("2. épinglage IPFS (Pinata)…");
    const cid = await pin(enc, "stress-test-500.enc", jwt);
    console.log(`   CID ${cid}`);
    putContentKey(cid, contentKey, dev.address.toLowerCase(), "1");
    mkdirSync(BUILDS_DIR, { recursive: true });
    writeFileSync(join(BUILDS_DIR, cid), enc);
    Object.assign(progress, { cid, sha256, size: enc.length });
    save();
  } else {
    console.log(`1-2. déjà fait : CID ${progress.cid}`);
    if (!getContentKey(progress.cid)) throw new Error("clé de contenu absente pour ce CID");
  }

  // 3. on-chain: game + edition
  if (!progress.gameId) {
    console.log("3. création du jeu…");
    const r = await send("createGame", { address: REGISTRY, abi: REGISTRY_ABI as Abi, functionName: "createGame", args: [1n, TITLE] });
    for (const log of r.logs) {
      try {
        const ev = decodeEventLog({ abi: REGISTRY_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "GameCreated") progress.gameId = String((ev.args as { gameId: bigint }).gameId);
      } catch {}
    }
    if (!progress.gameId) throw new Error("GameCreated introuvable");
    save();
  }
  if (!progress.editionId) {
    console.log("4. création de l'édition…");
    const r = await send("createEdition", {
      address: REGISTRY,
      abi: REGISTRY_ABI as Abi,
      functionName: "createEdition",
      args: [BigInt(progress.gameId), 100n, PRICE, 1000n, true, progress.cid!, progress.sha256 as `0x${string}`],
    });
    for (const log of r.logs) {
      try {
        const ev = decodeEventLog({ abi: REGISTRY_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "EditionCreated") progress.editionId = String((ev.args as { editionId: bigint }).editionId);
      } catch {}
    }
    if (!progress.editionId) throw new Error("EditionCreated introuvable");
    save();
  }

  // 4. one licence, to the player
  if (!progress.tokenId) {
    console.log("5. achat d'une licence…");
    const r = await send("buy", { address: LICENSE, abi: LICENSE_ABI as Abi, functionName: "buy", args: [BigInt(progress.editionId)], value: PRICE });
    for (const log of r.logs) {
      try {
        const ev = decodeEventLog({ abi: LICENSE_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "LicenseMinted") progress.tokenId = String((ev.args as { tokenId: bigint }).tokenId);
      } catch {}
    }
    if (!progress.tokenId) throw new Error("LicenseMinted introuvable");
    save();
  }
  if (progress.sentTo !== TO) {
    console.log(`6. envoi de la licence #${progress.tokenId} à ${TO}…`);
    await send("transferFrom", { address: LICENSE, abi: TRANSFER_ABI, functionName: "transferFrom", args: [dev.address, TO as `0x${string}`, BigInt(progress.tokenId)] });
    progress.sentTo = TO;
    save();
  }
  console.log(`\n✅ Édition #${progress.editionId} « ${TITLE} » · licence #${progress.tokenId} chez ${TO}`);
  console.log(`   build ${progress.cid} · ${mb(progress.size ?? 0)} · ${Math.ceil((progress.size ?? 0) / (4 * 1024 * 1024))} morceaux de 4 MiB\n`);
}

main().catch((e) => {
  console.error(`\n❌ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
