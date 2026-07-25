"use client";

// Studio space: upload a build -> ticketd encrypts + pins it (the content
// key never touches the browser) -> the studio records the edition
// on-chain with THEIR wallet. The platform never signs studio txs.

import { useState } from "react";
import { decodeEventLog, parseEther } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { REGISTRY_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";
import { ConnectButton } from "../components/ConnectButton";

const REGISTRY = DEPLOYMENTS.gameRegistry as `0x${string}`;
const TICKETD_URL = process.env.NEXT_PUBLIC_TICKETD_URL ?? "http://localhost:8787";

export default function StudioPage() {
  const { isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [studioName, setStudioName] = useState("");
  const [studioId, setStudioId] = useState("");
  const [gameTitle, setGameTitle] = useState("");
  const [gameId, setGameId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [price, setPrice] = useState("0.00001");
  const [supply, setSupply] = useState("100");
  const [royalty, setRoyalty] = useState("10");
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
    if (!file) return setError("choisissez le fichier du build (HTML autonome)");
    try {
      const bytes = await file.arrayBuffer();
      // Guard: an edition is IMMUTABLE once on-chain — refuse anything that
      // isn't a self-contained HTML build (e.g. a raw .js source file)
      const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart().toLowerCase();
      if (!head.startsWith("<!doctype html") && !head.startsWith("<html")) {
        throw new Error(
          "ce fichier n'est pas un build HTML autonome. Attendu : game/dist/<jeu>.html " +
            "(généré par `npm run build -w game`, moteur inclus) — pas le fichier source .js.",
        );
      }
      setStatus("1/2 — chiffrement + épinglage IPFS (via la plateforme)…");
      const res = await fetch(`${TICKETD_URL}/publish?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      if (!res.ok) throw new Error(await res.text());
      const stored = (await res.json()) as { cid: string; sha256: string };

      setStatus("2/2 — enregistrement on-chain (votre signature)…");
      const tx = await writeContractAsync({
        address: REGISTRY,
        abi: REGISTRY_ABI,
        functionName: "createEdition",
        args: [
          BigInt(gameId),
          BigInt(supply),
          parseEther(price),
          BigInt(Math.round(Number(royalty) * 100)) as unknown as bigint,
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
          <h2 className="section">1 · Studio {studioId && `— #${studioId} ✔`}</h2>
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
                <input type="file" accept=".html" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </p>
              <p>
                Prix <input style={{ width: "7rem" }} value={price} onChange={(e) => setPrice(e.target.value)} /> ETH
                {"  ·  "}Exemplaires{" "}
                <input style={{ width: "5rem" }} value={supply} onChange={(e) => setSupply(e.target.value)} />
                {"  ·  "}Royalties{" "}
                <input style={{ width: "3.5rem" }} value={royalty} onChange={(e) => setRoyalty(e.target.value)} /> %
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
              Les acheteurs peuvent minter (buy({result.editionId})) puis installer le jeu sur carte SD depuis
              le launcher. Pour l&apos;afficher dans les catalogues (site + launcher), ajoutez l&apos;entrée
              dans <code>shared/src/catalog.ts</code> — jusqu&apos;à la bascule du catalogue on-chain.
            </div>
          )}
          {error && <p className="error-box">{error}</p>}
        </>
      )}
    </div>
  );
}
