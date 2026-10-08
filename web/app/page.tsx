"use client";

// Marketplace home — Steam-style shelves over on-chain data only:
// featured hero, category rows (new, by studio, almost gone, genres).
// Cards click through to /game/[editionId]; buying lives on the detail page.

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatEther } from "viem";
import { fetchOnchainCatalog, BLURBS, GENRES, hueOf, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";
import { fetchOccasions, type Occasion } from "./lib/occasions";
import { ticketdGet } from "./lib/ticketd";
import { Avatar, shortAddr } from "./components/Avatar";

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

type Names = Record<string, { name: string | null; hasAvatar: boolean }>;

/** Second-hand capsule: opens /occasions on this listing, where the seller,
 *  their other listings and the purchase live side by side. */
function OccCard({ o, e, names }: { o: Occasion; e: OnchainEdition | undefined; names: Names }) {
  const discount = e && e.priceWei > BigInt(0) ? Number(((e.priceWei - o.price) * BigInt(100)) / e.priceWei) : 0;
  const seller = names[o.seller];
  return (
    <Link href={`/occasions?sel=${o.tokenId}`} className="mcard">
      <div className="mart occ-art" style={e ? artStyle(e.editionId) : undefined}>
        <div className="occbadge">OCCASION</div>
        <div className="martnote">licence #{o.tokenId}</div>
      </div>
      <div className="mtitle">{e?.title ?? `Licence #${o.tokenId}`}</div>
      <div className="occ-seller">
        <Avatar addr={o.seller} name={seller?.name} hasAvatar={seller?.hasAvatar} size={20} />
        <span>{seller?.name ?? shortAddr(o.seller)}</span>
      </div>
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
  const [names, setNames] = useState<Names>({});
  const [q, setQ] = useState("");

  useEffect(() => {
    fetchOnchainCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]));
    fetchOccasions()
      .then(async (list) => {
        setOccasions(list);
        const sellers = [...new Set(list.map((o) => o.seller))];
        if (sellers.length) setNames(await ticketdGet<Names>(`/profiles/names?a=${sellers.join(",")}`).catch(() => ({})));
      })
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
              <span className="btn sunset">Voir · {formatEther(featured.priceWei)} ETH</span>
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
            <h2>
              <Link href="/occasions">Occasions · seconde main →</Link>
            </h2>
            <span className="count">
              {occasions.length} LICENCE{occasions.length > 1 ? "S" : ""} · ROYALTIES AUTO AU STUDIO
            </span>
          </div>
          <div className="hrow">
            {occasions.map((o) => (
              <OccCard key={o.tokenId} o={o} e={catalog.find((e) => e.editionId === o.editionId)} names={names} />
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
