"use client";

// Marketplace home — Steam-style shelves over on-chain data only:
// featured hero, category rows (new, by studio, almost gone, genres).
// Cards click through to /game/[editionId]; buying lives on the detail page.

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatEther } from "viem";
import { fetchOnchainCatalog, BLURBS, GENRES, hueOf, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";

const artStyle = (editionId: string): React.CSSProperties => ({
  background: `linear-gradient(160deg, oklch(0.62 0.13 ${hueOf(editionId)}) 0%, oklch(0.34 0.1 ${hueOf(editionId) + 30}) 65%, oklch(0.22 0.06 265) 100%)`,
});

function Card({ e }: { e: OnchainEdition }) {
  const soldOut = e.minted >= e.supply;
  return (
    <Link href={`/game/${e.editionId}`} className="mcard">
      <div className="mart" style={artStyle(e.editionId)}>
        <div className="martnote">
          éd. #{e.editionId} · {GENRES[e.editionId] ?? "INDIE"}
        </div>
        {soldOut && <div className="soldout">SOLD OUT</div>}
      </div>
      <div className="mtitle">{e.title}</div>
      <div className="mmeta">
        <span>{e.studio.toUpperCase()}</span>
        <span className="mprice">{formatEther(e.priceWei)} ETH</span>
      </div>
    </Link>
  );
}

function Row({ title, list }: { title: string; list: OnchainEdition[] }) {
  if (!list.length) return null;
  return (
    <>
      <div className="cat-head">
        <h2>{title}</h2>
        <span className="count">{list.length} TITRE{list.length > 1 ? "S" : ""}</span>
      </div>
      <div className="hrow">
        {list.map((e) => (
          <Card key={e.editionId} e={e} />
        ))}
      </div>
    </>
  );
}

export default function Marketplace() {
  const [catalog, setCatalog] = useState<OnchainEdition[] | null>(null);

  useEffect(() => {
    fetchOnchainCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);

  if (!catalog) return <p className="notice">LECTURE DU REGISTRE ON-CHAIN…</p>;
  if (!catalog.length)
    return <p className="notice">Aucune édition publiée — passez par l&apos;espace Studio.</p>;

  // Featured: the newest edition that still has supply
  const featured = [...catalog].reverse().find((e) => e.minted < e.supply) ?? catalog[catalog.length - 1];
  const newest = [...catalog].reverse();
  const almostGone = catalog.filter((e) => e.supply > 0 && e.minted / e.supply >= 0.5 && e.minted < e.supply);
  const studios = Array.from(new Set(catalog.map((e) => e.studio)));
  const genres = Array.from(new Set(catalog.map((e) => GENRES[e.editionId]).filter(Boolean))) as string[];

  return (
    <>
      <Link href={`/game/${featured.editionId}`} style={{ display: "block" }}>
        <div className="mk-hero" style={artStyle(featured.editionId)}>
          <div className="sheen"></div>
          <div className="mk-hero-body">
            <div>
              <div className="kicker">À LA UNE · {GENRES[featured.editionId] ?? "INDIE"} · ÉD. #{featured.editionId}</div>
              <h1>{featured.title}</h1>
              <div className="blurb">
                {BLURBS[featured.editionId] ??
                  `Par ${featured.studio} — licence ERC-721 sur cartouche : jouable hors ligne, revendable, royalties ${featured.royaltyBps / 100}% au studio.`}
              </div>
            </div>
            <div className="cta-zone">
              <span className="btn">Voir · {formatEther(featured.priceWei)} ETH</span>
              <span className="addr">
                {featured.minted}/{featured.supply} mintés
              </span>
            </div>
          </div>
        </div>
      </Link>

      <Row title="Nouveautés" list={newest} />
      {genres.map((g) => (
        <Row key={g} title={`Genre · ${g}`} list={catalog.filter((e) => GENRES[e.editionId] === g)} />
      ))}
      <Row title="Bientôt épuisés" list={almostGone} />
      {studios.map((s) => (
        <Row key={s} title={`Studio · ${s}`} list={catalog.filter((e) => e.studio === s)} />
      ))}

      <p className="addr" style={{ marginTop: "2rem" }}>
        Catalogue lu sur Base Sepolia · GameRegistry {DEPLOYMENTS.gameRegistry?.slice(0, 10)}… · aucune donnée
        factice
      </p>
    </>
  );
}
