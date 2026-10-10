// Demo reset (v1) — puts the reference demo back in a KNOWN state, as many
// times as needed. A blockchain can't be rewound: licences sold during a
// run stay sold. So the script does not take anything back; it PREPARES:
//
//   1. the seller (wallet A) holds an unlent, unlisted licence of the demo
//      edition — otherwise the dev wallet buys one and transfers it to A;
//   2. the second-hand market shows at least one listing (dev wallet);
//   3. off-chain: A and B are friends since 4 days (lending works at once),
//      the dev studio has its profile and public page;
//   4. prints the step-by-step demo script.
//
// Read-only by default. `--apply` sends the transactions (testnet ETH from
// DEV_WALLET_PRIVKEY) and writes the local DB — only with GAMEVAULT_DEV=1.
//
//   npm run demo -w @gamevault/ticketd -- [--apply] [--seller 0x…] [--buyer 0x…] [--edition 2] [--price 0.000008]

import { createPublicClient, createWalletClient, decodeEventLog, formatEther, http, parseEther, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { LICENSE_ABI, MARKETPLACE_ABI, REGISTRY_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS, SUBGRAPH_URL } from "@gamevault/shared/deployments";
import { friends, initDb, profiles, studioPages } from "./db.ts";
import { closeStore } from "./sql.ts";

// ── Options ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const APPLY = argv.includes("--apply");
const SELLER = opt("seller", "0xbDdE8af0AfE38Eb897F87177d3B10efCd5673f02").toLowerCase(); // wallet A
const BUYER = opt("buyer", "").toLowerCase(); // wallet B (optional)
const EDITION = opt("edition", "2"); // 2 = GameVault Runner (web game)
const LIST_PRICE = opt("price", "0.000008");
const ADDR = /^0x[0-9a-f]{40}$/;
if (!ADDR.test(SELLER) || (BUYER && !ADDR.test(BUYER)) || !/^\d{1,6}$/.test(EDITION)) {
  console.error("❌ --seller / --buyer : adresse 0x… ; --edition : numéro");
  process.exit(1);
}
const TICKETD = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

const LICENSE = DEPLOYMENTS.gameLicense as `0x${string}`;
const MARKET = DEPLOYMENTS.marketplace as `0x${string}`;
const REGISTRY = DEPLOYMENTS.gameRegistry as `0x${string}`;
const TRANSFER_ABI = [
  {
    name: "transferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    outputs: [],
  },
] as const satisfies Abi;

const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL || undefined) });
const devKey = process.env.DEV_WALLET_PRIVKEY;
const dev = devKey ? privateKeyToAccount((devKey.startsWith("0x") ? devKey : `0x${devKey}`) as `0x${string}`) : null;
const devAddr = dev?.address.toLowerCase() ?? "";

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const who = (a: string): string => (a === SELLER ? "A (vendeur)" : a === BUYER ? "B (acheteur)" : a === devAddr ? "dev" : short(a));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The public RPC is load-balanced: a node may not have seen the previous
 *  transaction yet. Retry the simulation a few times before giving up. */
type Call = { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint };

async function send(label: string, params: Call): Promise<`0x${string}`> {
  if (!dev) throw new Error("DEV_WALLET_PRIVKEY absent");
  const wallet = createWalletClient({ account: dev, chain: baseSepolia, transport: http(process.env.RPC_URL || undefined) });
  for (let attempt = 1; ; attempt++) {
    try {
      const { request } = await pub.simulateContract({ ...params, account: dev } as never);
      const hash = await wallet.writeContract(request as never);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${label} : transaction annulée`);
      console.log(`   ✔ ${label} · ${hash.slice(0, 14)}…`);
      await sleep(4000); // let the load-balanced RPC catch up before the next read
      return hash;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(4000);
    }
  }
}

// ── 1. Read the state ──────────────────────────────────────────────────
type Tok = { id: bigint; owner: string; edition: string; borrower: string; listed: boolean };

async function scan(): Promise<Tok[]> {
  const next = await pub.readContract({ address: LICENSE, abi: LICENSE_ABI, functionName: "nextTokenId" });
  const out: Tok[] = [];
  for (let i = 1n; i <= next; i++) {
    const [owner, ed, user, listing] = await Promise.all([
      pub.readContract({ address: LICENSE, abi: LICENSE_ABI, functionName: "ownerOf", args: [i] }),
      pub.readContract({ address: LICENSE, abi: LICENSE_ABI, functionName: "editionOf", args: [i] }),
      pub.readContract({ address: LICENSE, abi: LICENSE_ABI, functionName: "userOf", args: [i] }),
      pub.readContract({ address: MARKET, abi: MARKETPLACE_ABI, functionName: "listings", args: [i] }),
    ]);
    out.push({
      id: i,
      owner: owner.toLowerCase(),
      edition: ed.toString(),
      borrower: user === "0x0000000000000000000000000000000000000000" ? "" : user.toLowerCase(),
      listed: listing[0].toLowerCase() === owner.toLowerCase(),
    });
  }
  return out;
}

async function health(): Promise<void> {
  const t = await fetch(`${TICKETD}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  const block = await pub.getBlockNumber().catch(() => 0n);
  const sg = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ _meta { block { number } hasIndexingErrors } }" }),
    signal: AbortSignal.timeout(8000),
  })
    .then((r) => r.json() as Promise<{ data?: { _meta: { block: { number: number }; hasIndexingErrors: boolean } } }>)
    .catch(() => null);
  const lag = sg?.data ? Number(block) - sg.data._meta.block.number : null;
  console.log(`   ticketd   ${t ? "✔ en ligne" : "✖ hors ligne (lancez dev.cmd)"}`);
  console.log(`   RPC       ${block ? `✔ bloc ${block}` : "✖ injoignable"}`);
  console.log(`   subgraph  ${lag === null ? "✖ injoignable" : `✔ ${lag} bloc(s) de retard${sg?.data?._meta.hasIndexingErrors ? " · ERREURS D'INDEXATION" : ""}`}`);
  if (dev) {
    const bal = await pub.getBalance({ address: dev.address });
    console.log(`   dev       ${short(devAddr)} · ${formatEther(bal)} ETH (paie le gaz et les licences de démo)`);
  } else {
    console.log("   dev       ✖ DEV_WALLET_PRIVKEY absent — lecture seule");
  }
}

// ── Main ───────────────────────────────────────────────────────────────
console.log(`\nGameVault · remise à zéro de la démo ${APPLY ? "(--apply)" : "(lecture seule)"}`);
console.log(`   A = ${SELLER}${BUYER ? `\n   B = ${BUYER}` : ""}\n   édition de démo #${EDITION}\n`);
if (!LICENSE || !MARKET || !REGISTRY) throw new Error("contrats non déployés (shared/src/deployments.ts)");
if (APPLY && process.env.GAMEVAULT_DEV !== "1") {
  console.error("❌ --apply écrit la base locale : réservé au mode dev (GAMEVAULT_DEV=1, chargé depuis ticketd/.env.dev)");
  process.exit(1);
}

console.log("Santé");
await health();

const [, , price] = await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "editions", args: [BigInt(EDITION)] });
await initDb();
let tokens = await scan();
console.log("\nLicences");
for (const t of tokens) {
  console.log(`   #${t.id} · éd. ${t.edition} · ${who(t.owner)}${t.borrower ? ` · prêtée à ${who(t.borrower)}` : ""}${t.listed ? " · EN VENTE" : ""}`);
}

const plan: string[] = [];
const sellerReady = () => tokens.find((t) => t.owner === SELLER && t.edition === EDITION && !t.borrower && !t.listed);
const devListing = () => tokens.find((t) => t.owner === devAddr && t.listed);
if (!sellerReady()) plan.push(`acheter une licence de l'édition #${EDITION} (${formatEther(price)} ETH) et la transférer à A`);
if (!devListing()) plan.push(`mettre une licence du wallet dev en vente à ${LIST_PRICE} ETH (marché d'occasion)`);
if (BUYER && !(await friends.since(SELLER, BUYER))) plan.push("créer l'amitié A ↔ B, antidatée de 4 jours (prêt possible tout de suite)");
if (dev && !(await profiles.get(devAddr))?.name) plan.push("donner un profil au wallet dev (« GameVault Dev »)");
if (!(await studioPages.get("1"))?.description) plan.push("rédiger la page publique du studio #1");

console.log("\nPlan");
if (plan.length === 0) console.log("   rien à faire — la démo est prête");
plan.forEach((p) => console.log(`   • ${p}`));

if (!APPLY) {
  if (plan.length) console.log("\nRelancez avec --apply pour exécuter ce plan.");
} else if (plan.length) {
  console.log("\nExécution");
  if (!sellerReady()) {
    const hash = await send(`achat licence éd. #${EDITION}`, {
      address: LICENSE,
      abi: LICENSE_ABI,
      functionName: "buy",
      args: [BigInt(EDITION)],
      value: price,
    });
    const receipt = await pub.getTransactionReceipt({ hash });
    let minted: bigint | null = null;
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: LICENSE_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "LicenseMinted") minted = (ev.args as { tokenId: bigint }).tokenId;
      } catch {
        /* other event */
      }
    }
    if (minted === null) throw new Error("licence mintée introuvable dans le reçu");
    await send(`transfert #${minted} → A`, { address: LICENSE, abi: TRANSFER_ABI, functionName: "transferFrom", args: [dev!.address, SELLER as `0x${string}`, minted] });
  }
  tokens = await scan();
  if (!devListing()) {
    let tok = tokens.find((t) => t.owner === devAddr && !t.borrower);
    if (!tok) {
      const hash = await send(`achat licence éd. #${EDITION} (pour le marché)`, { address: LICENSE, abi: LICENSE_ABI, functionName: "buy", args: [BigInt(EDITION)], value: price });
      const receipt = await pub.getTransactionReceipt({ hash });
      for (const log of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: LICENSE_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === "LicenseMinted") tok = { id: (ev.args as { tokenId: bigint }).tokenId, owner: devAddr, edition: EDITION, borrower: "", listed: false };
        } catch {
          /* other event */
        }
      }
    }
    if (tok) {
      await send(`autorisation Marketplace #${tok.id}`, { address: LICENSE, abi: LICENSE_ABI, functionName: "approve", args: [MARKET, tok.id] });
      await send(`mise en vente #${tok.id} à ${LIST_PRICE} ETH`, { address: MARKET, abi: MARKETPLACE_ABI, functionName: "list", args: [tok.id, parseEther(LIST_PRICE)] });
    }
  }
  if (BUYER && !(await friends.since(SELLER, BUYER))) {
    await friends.deleteRequest(SELLER, BUYER);
    await friends.deleteRequest(BUYER, SELLER);
    await friends.set(SELLER, BUYER, Math.floor(Date.now() / 1000) - 4 * 86400);
    console.log("   ✔ amitié A ↔ B (depuis 4 jours)");
  }
  if (dev && !(await profiles.get(devAddr))?.name) {
    await profiles.upsert(devAddr, {
      name: "GameVault Dev",
      avatarType: null,
      favorites: [EDITION],
      bio: "Le wallet du studio de démonstration. Revend des licences pour tester le marché d'occasion.",
      updatedAt: Date.now(),
    });
    console.log("   ✔ profil « GameVault Dev »");
  }
  if (!(await studioPages.get("1"))?.description) {
    await studioPages.put(
      "1",
      {
        description: "Nous faisons des jeux qu'on possède vraiment : achetés une fois, écrits sur une carte, prêtables à un ami et revendables. Chaque revente nous reverse 10 % automatiquement.",
        links: [{ label: "Code source", url: "https://github.com/Helder77270/Gamevault" }],
        team: [{ name: "Helder", role: "Fondateur · dev", wallet: SELLER }],
      },
      devAddr || SELLER,
    );
    console.log("   ✔ page du studio #1");
  }
  tokens = await scan();
}

// ── The demo script ────────────────────────────────────────────────────
const ready = sellerReady();
console.log("\nDémo de référence");
console.log(`   0. dev.cmd lancé · launcher sur la machine de A · carte SD insérée${ready ? "" : "  (⚠ A n'a pas encore de licence prête — relancez avec --apply)"}`);
console.log(`   1. Launcher (A) : fiche du jeu → WRITE TO CARD${ready ? ` avec la licence #${ready.id}` : ""} → PAIR (QR → /pair, signature A)`);
console.log("   2. PLAY : le jeu tourne (contrôle de propriété toutes les 20 s)");
console.log(`   3. Navigateur (A) : /trade ou SELL dans le launcher → mise en vente${BUYER ? " ; B l'achète sur /occasions" : " ; un second wallet l'achète sur /occasions"}`);
console.log("   4. Machine de A : la partie se coupe dans les 20 s — ERR 0x52 · RESOLD MID-SESSION");
console.log("   5. Machine de B : insérer la carte → PAIR avec B → PLAY ; /provenance montre la chaîne des propriétaires");
console.log("   6. Social : profils /u/…, chat AMIS dans le launcher, prêt A → B depuis /friends\n");
await closeStore();
process.exit(0);
