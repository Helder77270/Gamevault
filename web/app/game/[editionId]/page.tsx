"use client";

// Game detail page — Steam-style store page over on-chain data: hero art,
// buy box (real GameLicense.buy tx), stats, provenance-grade identifiers,
// and the physical-flow explainer. AURA-64 design language.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { decodeEventLog, formatEther } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { fetchOnchainCatalog, BLURBS, GENRES, hueOf, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { LICENSE_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS, CHAIN } from "@gamevault/shared/deployments";
import { fetchOccasions, type Occasion } from "../../lib/occasions";
import { WishButton, bestDeal } from "../../components/Wishlist";

const LICENSE = DEPLOYMENTS.gameLicense as `0x${string}`;
const BASESCAN = "https://sepolia.basescan.org";

export default function GamePage() {
  const { editionId } = useParams<{ editionId: string }>();
  const { isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [catalog, setCatalog] = useState<OnchainEdition[] | null>(null);
  const [buying, setBuying] = useState(false);
  const [mintedToken, setMintedToken] = useState("");
  const [error, setError] = useState("");
  const [occasions, setOccasions] = useState<Occasion[]>([]);
  useEffect(() => {
    fetchOccasions()
      .then(setOccasions)
      .catch(() => setOccasions([]));
  }, []);

  const load = () => {
    fetchOnchainCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  };
  useEffect(load, []);

  const e = catalog?.find((x) => x.editionId === editionId);

  const buy = async () => {
    if (!e) return;
    setError("");
    setBuying(true);
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
          if (ev.eventName === "LicenseMinted")
            setMintedToken(String((ev.args as { tokenId: bigint }).tokenId));
        } catch {
          /* not our event */
        }
      }
      load();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
    setBuying(false);
  };

  if (!catalog) return <p className="notice">LECTURE DU REGISTRE…</p>;
  if (!e)
    return (
      <div className="pane">
        <h1>Édition #{editionId} inconnue</h1>
        <p>
          Elle n&apos;existe pas (encore) dans le GameRegistry. <Link href="/" className="backlink">← RETOUR AU MARKETPLACE</Link>
        </p>
      </div>
    );

  const soldOut = e.minted >= e.supply;
  const deal = bestDeal(e, occasions);
  const hue = hueOf(e.editionId);

  return (
    <>
      <p style={{ marginBottom: "1rem" }}>
        <Link href="/" className="backlink">← MARKETPLACE</Link>
      </p>
      <div className="gd">
        <div className="gd-left">
          <div
            className="gd-art"
            style={{
              background: `linear-gradient(160deg, oklch(0.62 0.13 ${hue}) 0%, oklch(0.34 0.1 ${hue + 30}) 65%, oklch(0.22 0.06 265) 100%)`,
            }}
          >
            <div className="sheen"></div>
            <div className="artnote">box art — éd. #{e.editionId}</div>
          </div>
          <div className="kicker" style={{ marginTop: "1.2rem" }}>
            {e.studio.toUpperCase()} · {GENRES[e.editionId] ?? "INDIE"} · {e.resellable ? `ROYALTIES ${e.royaltyBps / 100}%` : "SANS REVENTE"}
          </div>
          <h1>{e.title}</h1>
          <div style={{ display: "flex", gap: "0.5rem", margin: "0.4rem 0 0.8rem" }}>
            <span className="tag">ÉD. #{e.editionId}</span>
            <span className="tag">JEU #{e.gameId}</span>
            <span className="tag">STUDIO #{e.studioId}</span>
            <span className="tag">CHAIN {CHAIN.id}</span>
          </div>
          <p className="blurb">
            {BLURBS[e.editionId] ??
              "Une licence ERC-721 sur cartouche physique : jouable hors ligne après appairage, prêtable, revendable — royalties automatiques au studio à chaque revente (EIP-2981)."}
          </p>
          <div className="howto">
            <div className="k">DU MINT À LA CARTOUCHE</div>
            <ol>
              <li>Achetez la licence — un NFT est minté vers votre wallet (notez son n° de token).</li>
              <li>Ouvrez le launcher AURA-64 → Game Shelf → ce titre → WRITE TO CARD.</li>
              <li>Le build chiffré arrive d&apos;IPFS, vérifié contre le hash gravé on-chain.</li>
              <li>Appairez la machine (signature du wallet) — puis jouez, même hors ligne.</li>
            </ol>
          </div>
        </div>

        <div className="gd-right">
          <div className="buybox">
            <div className="brow">
              <div>
                <div className="bprice">{formatEther(e.priceWei)} ETH</div>
                <div className="bsub">
                  {e.minted}/{e.supply} MINTÉS · {soldOut ? "ÉPUISÉ" : `${e.supply - e.minted} RESTANTS`}
                </div>
              </div>
              {mintedToken ? (
                <span className="ok-box" style={{ margin: 0 }}>✔ token #{mintedToken}</span>
              ) : (
                <button className="btn sunset" disabled={!isConnected || soldOut || buying} onClick={() => void buy()}
                  title={!isConnected ? "Connectez votre wallet" : soldOut ? "Épuisé" : "Mint la licence"}>
                  {buying ? "Transaction…" : "Acheter"}
                </button>
              )}
            </div>
            {mintedToken && (
              <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--sub)" }}>
                Licence mintée ! Ouvrez le launcher → Game Shelf → « {e.title} » → WRITE TO CARD avec le token #
                {mintedToken}. Son historique on-chain :{" "}
                <Link href={`/provenance/${mintedToken}`}>provenance de la licence #{mintedToken}</Link>.
              </p>
            )}
            {deal && (
              <Link href={`/occasions?sel=${deal.tokenId}`} className="wish-deal">
                Une occasion à {formatEther(deal.price)} ETH (licence #{deal.tokenId}) — moins chère que le neuf ↗
              </Link>
            )}
            <div>
              <WishButton edition={e} deal={deal} />
            </div>
            {error && <p className="error-box">{error}</p>}
            {!isConnected && !mintedToken && (
              <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--dim)" }}>
                Connectez votre wallet (bouton en haut à droite) pour acheter.
              </p>
            )}
          </div>

          <div className="statgrid">
            <div className="stat"><div className="k">PRIX PRIMAIRE</div><div className="v">{formatEther(e.priceWei)} ETH → 92 % studio · 8 % plateforme</div></div>
            <div className="stat"><div className="k">REVENTE</div><div className="v">{e.resellable ? `autorisée · ${e.royaltyBps / 100} % studio · 5 % plateforme` : "désactivée par le studio"}</div></div>
            <div className="stat"><div className="k">BUILD CID (IPFS)</div><div className="v">{e.buildCid.slice(0, 14)}…{e.buildCid.slice(-6)}</div></div>
            <div className="stat"><div className="k">BUILD HASH</div><div className="v">{e.buildSha256.slice(0, 14)}…{e.buildSha256.slice(-6)}</div></div>
            <div className="stat">
              <div className="k">CONTRAT LICENCE</div>
              <div className="v"><a href={`${BASESCAN}/address/${DEPLOYMENTS.gameLicense}`} target="_blank" rel="noreferrer" style={{ color: "var(--cyan)" }}>{DEPLOYMENTS.gameLicense?.slice(0, 14)}… ↗</a></div>
            </div>
            <div className="stat">
              <div className="k">REGISTRE</div>
              <div className="v"><a href={`${BASESCAN}/address/${DEPLOYMENTS.gameRegistry}`} target="_blank" rel="noreferrer" style={{ color: "var(--cyan)" }}>{DEPLOYMENTS.gameRegistry?.slice(0, 14)}… ↗</a></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
