"use client";

// Marketplace home — Steam-style shelves over on-chain data only:
// featured hero, category rows (new, by studio, almost gone, genres).
// Cards click through to /game/[editionId]; buying lives on the detail page.

import { useEffect, useState } from "react";
import Link from "next/link";
import { createPublicClient, formatEther, http } from "viem";
import { baseSepolia } from "viem/chains";
import { fetchOnchainCatalog, BLURBS, GENRES, hueOf, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";
import { LICENSE_ABI, MARKETPLACE_ABI } from "@gamevault/shared/abi";

// Second-hand listings — THE thing Steam doesn't have. Read straight from
// the Marketplace contract: every token whose listing has a seller.
type Occasion = { tokenId: string; editionId: string; price: bigint; seller: string };

const ZERO = "0x0000000000000000000000000000000000000000";

async function fetchOccasions(): Promise<Occasion[]> {
  if (!DEPLOYMENTS.gameLicense || !DEPLOYMENTS.marketplace) return [];
  const c = createPublicClient({ chain: baseSepolia, transport: http() });
  const license = DEPLOYMENTS.gameLicense as `0x${string}`;
  const market = DEPLOYMENTS.marketplace as `0x${string}`;
  const next = await c.readContract({ address: license, abi: LICENSE_ABI, functionName: "nextTokenId" });
  const found: Occasion[] = [];
  for (let i = BigInt(1); i <= next; i++) {
    try {
      const [seller, price] = await c.readContract({ address: market, abi: MARKETPLACE_ABI, functionName: "listings", args: [i] });
      if (seller.toLowerCase() === ZERO) continue;
      const ed = await c.readContract({ address: license, abi: LICENSE_ABI, functionName: "editionOf", args: [i] });
      found.push({ tokenId: i.toString(), editionId: ed.toString(), price, seller });
    } catch {
      /* burned / unknown token */
    }
  }
  return found;
}

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

function OccCard({ o, e }: { o: Occasion; e: OnchainEdition | undefined }) {
  const discount = e && e.priceWei > BigInt(0) ? Number(((e.priceWei - o.price) * BigInt(100)) / e.priceWei) : 0;
  return (
    <Link href={`/trade?action=buy&token=${o.tokenId}`} className="mcard">
      <div className="mart occ-art" style={e ? artStyle(e.editionId) : undefined}>
        <div className="occbadge">OCCASION</div>
        <div className="martnote">licence #{o.tokenId} · revente par {o.seller.slice(0, 6)}…{o.seller.slice(-4)}</div>
      </div>
      <div className="mtitle">{e?.title ?? `Licence #${o.tokenId}`}</div>
      <div className="mmeta">
        <span>{discount > 0 ? `-${discount}% VS NEUF` : "SECONDE MAIN"}</span>
        <span className="mprice occ-price">{formatEther(o.price)} ETH</span>
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

const norm = (s: string): string =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export default function Marketplace() {
  const [catalog, setCatalog] = useState<OnchainEdition[] | null>(null);
  const [occasions, setOccasions] = useState<Occasion[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetchOnchainCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]));
    fetchOccasions()
      .then(setOccasions)
      .catch(() => setOccasions([]));
  }, []);

  if (!catalog) return <p className="notice">LECTURE DU REGISTRE ON-CHAIN…</p>;
  if (!catalog.length)
    return <p className="notice">Aucune édition publiée — passez par l&apos;espace Studio.</p>;

  const query = q.trim();
  const results = query
    ? catalog.filter((e) => {
        const hay = norm(`${e.title} ${e.studio} ${GENRES[e.editionId] ?? ""}`);
        return hay.includes(norm(query)) || e.editionId === query.replace(/^#/, "");
      })
    : [];

  const searchBar = (
    <div className="mk-search">
      <span className="mk-search-icon">⌕</span>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setQ("")}
        placeholder="RECHERCHER · TITRE / STUDIO / GENRE / #ÉD"
      />
      {query && (
        <>
          <span className="count">{results.length} TITRE{results.length > 1 ? "S" : ""}</span>
          <button onClick={() => setQ("")} title="Effacer">✕</button>
        </>
      )}
    </div>
  );

  if (query) {
    return (
      <>
        {searchBar}
        <div className="cat-head">
          <h2>Résultats · « {query} »</h2>
        </div>
        {results.length ? (
          <div className="hrow gridwrap">
            {results.map((e) => (
              <Card key={e.editionId} e={e} />
            ))}
          </div>
        ) : (
          <p className="notice">Aucun résultat pour « {query} » — essayez un titre, un studio ou un genre.</p>
        )}
      </>
    );
  }

  // Featured: the newest edition that still has supply
  const featured = [...catalog].reverse().find((e) => e.minted < e.supply) ?? catalog[catalog.length - 1];
  const newest = [...catalog].reverse();
  const almostGone = catalog.filter((e) => e.supply > 0 && e.minted / e.supply >= 0.5 && e.minted < e.supply);
  const studios = Array.from(new Set(catalog.map((e) => e.studio)));
  const genres = Array.from(new Set(catalog.map((e) => GENRES[e.editionId]).filter(Boolean))) as string[];

  return (
    <>
      {searchBar}
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
                {featured.minted}/{featured.supply} mintés · royalties {featured.royaltyBps / 100}%
              </span>
              <span className="mintbar" aria-hidden="true">
                <span style={{ width: `${featured.supply > 0 ? Math.max(2, Math.round((featured.minted / featured.supply) * 100)) : 0}%` }}></span>
              </span>
            </div>
          </div>
        </div>
      </Link>

      <Row title="Nouveautés" list={newest} />
      {occasions.length > 0 && (
        <>
          <div className="cat-head">
            <h2>Occasions · seconde main</h2>
            <span className="count">
              {occasions.length} LICENCE{occasions.length > 1 ? "S" : ""} · ROYALTIES AUTO AU STUDIO
            </span>
          </div>
          <div className="hrow">
            {occasions.map((o) => (
              <OccCard key={o.tokenId} o={o} e={catalog.find((e) => e.editionId === o.editionId)} />
            ))}
          </div>
        </>
      )}
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
