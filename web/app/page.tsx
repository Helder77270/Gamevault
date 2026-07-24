"use client";

// Marketplace — the catalog IS the chain (GameRegistry enumeration), and
// the buy button mints for real (GameLicense.buy). No mock data.

import { useEffect, useState } from "react";
import { decodeEventLog, formatEther } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { fetchOnchainCatalog, BLURBS, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { LICENSE_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";

const LICENSE = DEPLOYMENTS.gameLicense as `0x${string}`;

export default function Marketplace() {
  const { isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [catalog, setCatalog] = useState<OnchainEdition[] | null>(null);
  const [buying, setBuying] = useState("");
  const [minted, setMinted] = useState<Record<string, string>>({}); // editionId -> tokenId
  const [error, setError] = useState("");

  const loadCatalog = () => {
    fetchOnchainCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  };
  useEffect(loadCatalog, []);

  const buy = async (e: OnchainEdition) => {
    setError("");
    setBuying(e.editionId);
    try {
      const tx = await writeContractAsync({
        address: LICENSE,
        abi: LICENSE_ABI,
        functionName: "buy",
        args: [BigInt(e.editionId)],
        value: e.priceWei,
      });
      const receipt = await publicClient!.waitForTransactionReceipt({ hash: tx });
      for (const log of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: LICENSE_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === "LicenseMinted") {
            setMinted((m) => ({ ...m, [e.editionId]: String((ev.args as { tokenId: bigint }).tokenId) }));
          }
        } catch {
          /* not our event */
        }
      }
      loadCatalog(); // refresh minted counters
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
    setBuying("");
  };

  return (
    <>
      <section className="hero">
        <h1>Des jeux indés que vous possédez pour de vrai.</h1>
        <p>
          Chaque copie est une licence ERC-721 installable sur une cartouche USB/SD : jouable hors ligne,
          prêtable, revendable — avec royalties automatiques aux studios via EIP-2981.
        </p>
        <p className="tagline">« Le support est le véhicule, la blockchain est le verrou. »</p>
      </section>

      <h2 className="section">
        Éditions on-chain{catalog ? ` (${catalog.length})` : ""} — GameRegistry{" "}
        <code>{DEPLOYMENTS.gameRegistry?.slice(0, 10)}…</code>
      </h2>
      {error && <p className="error-box">{error}</p>}
      {!catalog && <p>Lecture du registre…</p>}
      {catalog?.length === 0 && <p>Aucune édition publiée — passez par l&apos;espace Studio.</p>}

      <div className="grid">
        {catalog?.map((e) => {
          const soldOut = e.minted >= e.supply;
          return (
            <article className="card" key={e.editionId}>
              <div className="cover">{e.title.charAt(0)}</div>
              <div className="body">
                <h3>{e.title}</h3>
                <span className="studio">{e.studio}</span>
                {BLURBS[e.editionId] && <span className="studio">{BLURBS[e.editionId]}</span>}
                <div className="meta">
                  <span>
                    {e.minted}/{e.supply} mintés
                  </span>
                  <span>royalties {e.royaltyBps / 100} %</span>
                </div>
                <div className="meta">
                  <span>éd. #{e.editionId} · jeu #{e.gameId}</span>
                  <span title={e.buildCid}>
                    cid {e.buildCid.slice(0, 8)}…{e.buildCid.slice(-4)}
                  </span>
                </div>
                <div className="row">
                  <span className="price">{formatEther(e.priceWei)} ETH</span>
                  {minted[e.editionId] ? (
                    <span className="studio">✔ token #{minted[e.editionId]} minté — appairez via le launcher</span>
                  ) : (
                    <button
                      className="btn"
                      disabled={!isConnected || soldOut || buying === e.editionId}
                      title={!isConnected ? "Connectez votre wallet" : soldOut ? "Épuisé" : "Mint la licence"}
                      onClick={() => void buy(e)}
                    >
                      {buying === e.editionId ? "Transaction…" : "Acheter"}
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
