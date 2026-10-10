"use client";

// Studio space: upload a build -> ticketd encrypts + pins it (the content
// key never touches the browser) -> the studio records the edition
// on-chain with THEIR wallet. The platform never signs studio txs.

import { useState } from "react";
import Link from "next/link";
import { decodeEventLog, parseEther } from "viem";
import { useAccount, usePublicClient, useSignMessage, useWriteContract } from "wagmi";
import { REGISTRY_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";
import { ConnectButton } from "../components/ConnectButton";

const REGISTRY = DEPLOYMENTS.gameRegistry as `0x${string}`;
const TICKETD_URL = process.env.NEXT_PUBLIC_TICKETD_URL ?? "http://localhost:8787";

/** Must match ticketd's publishMessage() byte for byte (canonical form). */
function publishMessage(f: { wallet: string; studioId: string; sha256: string; name: string; at: string; nonce: string }): string {
  return [
    "GameVault Publish",
    `wallet: ${f.wallet}`,
    `studio: ${f.studioId}`,
    `sha256: ${f.sha256}`,
    `name: ${f.name}`,
    `at: ${f.at}`,
    `nonce: ${f.nonce}`,
  ].join("\n");
}

const toBase64 = (s: string): string => btoa(String.fromCharCode(...Array.from(new TextEncoder().encode(s))));

export default function StudioPage() {
  const { isConnected, address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const publicClient = usePublicClient();

  const [studioName, setStudioName] = useState("");
  const [studioId, setStudioId] = useState("");
  const [gameTitle, setGameTitle] = useState("");
  const [gameId, setGameId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [price, setPrice] = useState("0.00001");
  const [supply, setSupply] = useState("100");
  const [royalty, setRoyalty] = useState("10");
  // Resale is the studio's choice, fixed for the edition's lifetime.
  const [resellable, setResellable] = useState(true);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ editionId: string; cid: string; hash: string } | null>(null);

  async function decoded(txHash: `0x${string}`, eventName: string): Promise<Record<string, unknown>> {
    const receipt = await publicClient!.waitForTransactionReceipt({ hash: txHash });
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: REGISTRY_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === eventName) return ev.args as Record<string, unknown>;
      } catch {
        /* not our event */
      }
    }
    throw new Error(`événement ${eventName} introuvable dans le reçu`);
  }

  const createStudio = async () => {
    setError("");
    try {
      setStatus("Création du studio…");
      const tx = await writeContractAsync({
        address: REGISTRY,
        abi: REGISTRY_ABI,
        functionName: "registerStudio",
        args: [studioName],
      });
      const args = await decoded(tx, "StudioRegistered");
      setStudioId(String(args.studioId));
      setStatus("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setStatus("");
    }
  };

  const createGame = async () => {
    setError("");
    try {
      setStatus("Création du jeu…");
      const tx = await writeContractAsync({
        address: REGISTRY,
        abi: REGISTRY_ABI,
        functionName: "createGame",
        args: [BigInt(studioId), gameTitle],
      });
      const args = await decoded(tx, "GameCreated");
      setGameId(String(args.gameId));
      setStatus("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setStatus("");
    }
  };

  const publishEdition = async () => {
    setError("");
    if (!file) return setError("choisissez le fichier du build (HTML autonome ou .exe natif)");
    try {
      const bytes = await file.arrayBuffer();
      // Guard: an edition is IMMUTABLE once on-chain — accept only the two
      // runtimes the launcher knows how to boot, sniffed from the bytes:
      // PE executable ("MZ" magic) -> native process, self-contained HTML
      // -> webview. Anything else (raw .js source…) is refused.
      const raw = new Uint8Array(bytes);
      const isExe = raw[0] === 0x4d && raw[1] === 0x5a; // "MZ"
      const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart().toLowerCase();
      const isHtml = head.startsWith("<!doctype html") || head.startsWith("<html");
      if (!isExe && !isHtml) {
        throw new Error(
          "ce fichier n'est ni un build HTML autonome ni un exécutable natif (.exe). " +
            "Attendu : game/dist/<jeu>.html (généré par `npm run build -w game`, moteur inclus) " +
            "ou un .exe mono-fichier — pas le fichier source .js.",
        );
      }
      if (!address) throw new Error("wallet non connecté");
      // The studio signs THIS exact file (sha256) for THIS studio — ticketd
      // will only release the game key to editions of that studio.
      setStatus("1/3 — signature de la publication (votre wallet)…");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const sha256 = `0x${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
      const name = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "build";
      const message = publishMessage({
        wallet: address,
        studioId,
        sha256,
        name,
        at: new Date().toISOString(),
        nonce: crypto.randomUUID(),
      });
      const signature = await signMessageAsync({ message });

      setStatus("2/3 — chiffrement + épinglage IPFS (via la plateforme)…");
      const res = await fetch(`${TICKETD_URL}/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-GameVault-Message": toBase64(message),
          "X-GameVault-Signature": signature,
        },
        body: bytes,
      });
      if (!res.ok) {
        const body = await res.text();
        let msg = body;
        try {
          msg = (JSON.parse(body) as { error?: string }).error ?? body;
        } catch {
          /* not JSON */
        }
        throw new Error(msg);
      }
      const stored = (await res.json()) as { cid: string; sha256: string };

      setStatus("3/3 — enregistrement on-chain (votre signature)…");
      const tx = await writeContractAsync({
        address: REGISTRY,
        abi: REGISTRY_ABI,
        functionName: "createEdition",
        args: [
          BigInt(gameId),
          BigInt(supply),
          parseEther(price),
          BigInt(resellable ? Math.round(Number(royalty) * 100) : 0) as unknown as bigint,
          resellable,
          stored.cid,
          stored.sha256 as `0x${string}`,
        ],
      });
      const args = await decoded(tx, "EditionCreated");
      setResult({ editionId: String(args.editionId), cid: stored.cid, hash: stored.sha256 });
      setStatus("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setStatus("");
    }
  };

  return (
    <div className="pane" style={{ maxWidth: "44rem" }}>
      <h1>Espace studio — publier un jeu</h1>
      <p>
        Votre build est chiffré et épinglé sur IPFS par la plateforme (la clé de contenu ne transite jamais
        par le navigateur), puis <em>vous</em> enregistrez l&apos;édition on-chain : le CID et son empreinte
        deviennent publics et vérifiables, les royalties sont gravées.
      </p>
      {!isConnected && <ConnectButton />}

      {isConnected && (
        <>
          <h2 className="section">
            1 · Studio {studioId && `— #${studioId} ✔`}
            {/^\d+$/.test(studioId) && (
              <>
                {" "}
                <Link href={`/studio/${studioId}`} style={{ fontSize: "0.8rem", color: "var(--cyan)" }}>page publique →</Link>
              </>
            )}
          </h2>
          {!studioId && (
            <p>
              <input placeholder="Nom du studio" value={studioName} onChange={(e) => setStudioName(e.target.value)} />
              <button className="btn" disabled={!studioName || !!status} onClick={() => void createStudio()}>
                Créer
              </button>
              {" ou "}
              <input
                placeholder="n° existant"
                style={{ width: "6rem" }}
                onChange={(e) => setStudioId(e.target.value.trim())}
              />
            </p>
          )}

          <h2 className="section">2 · Jeu {gameId && `— #${gameId} ✔`}</h2>
          {studioId && !gameId && (
            <p>
              <input placeholder="Titre du jeu" value={gameTitle} onChange={(e) => setGameTitle(e.target.value)} />
              <button className="btn" disabled={!gameTitle || !!status} onClick={() => void createGame()}>
                Créer
              </button>
              {" ou "}
              <input
                placeholder="n° existant"
                style={{ width: "6rem" }}
                onChange={(e) => setGameId(e.target.value.trim())}
              />
            </p>
          )}

          <h2 className="section">3 · Édition</h2>
          {gameId && !result && (
            <>
              <p>
                <input type="file" accept=".html,.exe" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </p>
              <p>
                Prix <input style={{ width: "7rem" }} value={price} onChange={(e) => setPrice(e.target.value)} /> ETH
                {"  ·  "}Exemplaires{" "}
                <input style={{ width: "5rem" }} value={supply} onChange={(e) => setSupply(e.target.value)} />
              </p>
              <p>
                <label>
                  <input type="checkbox" checked={resellable} onChange={(e) => setResellable(e.target.checked)} />{" "}
                  Autoriser la revente des copies
                </label>
                {resellable && (
                  <>
                    {"  ·  "}Redevance studio sur chaque revente{" "}
                    <input style={{ width: "3.5rem" }} value={royalty} onChange={(e) => setRoyalty(e.target.value)} /> %
                    {" "}(0 à 20, 0 = aucune)
                  </>
                )}
              </p>
              <p style={{ fontSize: "0.8rem", color: "var(--dim)" }}>
                {resellable
                  ? "Les joueurs pourront revendre leur copie sur le marché d'occasion ; vous touchez la redevance à chaque revente."
                  : "Les copies resteront chez leur premier acheteur : ni revente ni cadeau. Le prêt entre amis reste possible."}
                {" "}Ce choix est gravé avec l&apos;édition et ne pourra plus changer.
              </p>
              <button className="btn" disabled={!file || !!status} onClick={() => void publishEdition()}>
                {status || "Publier l'édition"}
              </button>
            </>
          )}
          {result && (
            <div className="ok-box">
              ✔ Édition <b>#{result.editionId}</b> publiée.
              <br />
              CID : <code>{result.cid}</code>
              <br />
              L&apos;édition apparaît déjà dans les catalogues du site et du launcher : ils sont lus directement
              sur la blockchain. Les acheteurs peuvent l&apos;acheter puis installer le jeu sur carte SD depuis le
              launcher. Résumé et genre affichés sont optionnels (<code>shared/src/registryCatalog.ts</code>).
            </div>
          )}
          {error && <p className="error-box">{error}</p>}
        </>
      )}
    </div>
  );
}
