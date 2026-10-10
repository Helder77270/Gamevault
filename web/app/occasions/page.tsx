"use client";

// Second-hand market — every valid listing, with its SELLER: pseudo,
// profile, completed sales, their other listings. Browse by game, by seller
// or by price, and bounce from a game to a person to their other games.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";
import { formatEther } from "viem";
import { fetchOnchainCatalog, hueOf, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { Avatar, shortAddr } from "../components/Avatar";
import { fetchOccasions, type Occasion } from "../lib/occasions";
import { ticketdGet } from "../lib/ticketd";
import { subgraph } from "../lib/subgraph";

type Names = Record<string, { name: string | null; hasAvatar: boolean }>;
type Seller = {
  addr: string;
  name: string | null;
  hasAvatar: boolean;
  bio: string;
  memberSince: number | null;
  sales: number;
  friend: boolean;
};
type Mode = "game" | "seller" | "price";

const art = (editionId: string): React.CSSProperties => ({
  background: `linear-gradient(140deg, oklch(0.58 0.12 ${hueOf(editionId)}), oklch(0.3 0.08 ${hueOf(editionId) + 40}))`,
});

function OccasionsInner() {
  const params = useSearchParams();
  const { address: me } = useAccount();
  const [list, setList] = useState<Occasion[] | null>(null);
  const [catalog, setCatalog] = useState<OnchainEdition[]>([]);
  const [names, setNames] = useState<Names>({});
  const [mode, setMode] = useState<Mode>("game");
  const [sel, setSel] = useState<string | null>(params.get("sel"));
  const [seller, setSeller] = useState<Seller | null>(null);

  useEffect(() => {
    fetchOnchainCatalog().then(setCatalog).catch(() => {});
    fetchOccasions()
      .then(async (l) => {
        setList(l);
        setSel((cur) => (cur && l.some((o) => o.tokenId === cur) ? cur : l[0]?.tokenId ?? null));
        const sellers = [...new Set(l.map((o) => o.seller))];
        if (sellers.length) setNames(await ticketdGet<Names>(`/profiles/names?a=${sellers.join(",")}`).catch(() => ({})));
      })
      .catch(() => setList([]));
  }, []);

  const selected = list?.find((o) => o.tokenId === sel) ?? null;

  const loadSeller = useCallback(
    async (addr: string) => {
      setSeller(null);
      const [p, sales, friends] = await Promise.all([
        ticketdGet<{ name: string | null; hasAvatar: boolean; bio: string; memberSince: number | null }>(`/profile/${addr}`, me).catch(() => null),
        subgraph<{ royaltyPayments: { id: string }[] }>(`query($a: Bytes!) { royaltyPayments(where: { seller: $a }, first: 1000) { id } }`, { a: addr })
          .then((d) => d.royaltyPayments.length)
          .catch(() => 0),
        me ? ticketdGet<{ friends: { addr: string }[] }>(`/friends/${me}`, me).catch(() => null) : Promise.resolve(null),
      ]);
      setSeller({
        addr,
        name: p?.name ?? null,
        hasAvatar: p?.hasAvatar ?? false,
        bio: p?.bio ?? "",
        memberSince: p?.memberSince ?? null,
        sales,
        friend: Boolean(friends?.friends.some((f) => f.addr === addr)),
      });
    },
    [me],
  );

  useEffect(() => {
    if (selected) void loadSeller(selected.seller);
  }, [selected, loadSeller]);

  const titleOf = (id: string) => catalog.find((e) => e.editionId === id)?.title ?? `Édition #${id}`;
  const newPrice = (id: string) => catalog.find((e) => e.editionId === id)?.priceWei ?? BigInt(0);
  const sellerName = (a: string) => names[a]?.name ?? shortAddr(a);

  const groups = useMemo(() => {
    const l = [...(list ?? [])];
    if (mode === "price") return [{ key: "", items: l.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0)) }];
    const keyOf = (o: Occasion) => (mode === "game" ? o.editionId : o.seller);
    const map = new Map<string, Occasion[]>();
    for (const o of l) map.set(keyOf(o), [...(map.get(keyOf(o)) ?? []), o]);
    return [...map.entries()].map(([key, items]) => ({ key, items }));
  }, [list, mode]);

  const others = selected ? (list ?? []).filter((o) => o.seller === selected.seller && o.tokenId !== selected.tokenId) : [];

  return (
    <div>
      <div className="cat-head">
        <h2>Occasions · seconde main</h2>
        <span className="count">
          {list ? `${list.length} ANNONCE${list.length > 1 ? "S" : ""} VALIDE${list.length > 1 ? "S" : ""}` : "LECTURE ON-CHAIN…"} · ROYALTIES AU STUDIO À CHAQUE REVENTE
        </span>
      </div>
      <div className="oc-tabs">
        {(
          [
            ["game", "Par jeu"],
            ["seller", "Par vendeur"],
            ["price", "Prix ↑"],
          ] as [Mode, string][]
        ).map(([m, label]) => (
          <button key={m} className={`oc-tab${mode === m ? " on" : ""}`} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>

      {list && list.length === 0 && <p className="notice">Aucune licence en revente pour l&apos;instant.</p>}

      <div className="oc">
        <div className="oc-list">
          {groups.map((g) => (
            <div key={g.key || "all"}>
              {g.key && <div className="oc-group">{mode === "game" ? titleOf(g.key) : sellerName(g.key)} · {g.items.length}</div>}
              <div className="oc-grid">
                {g.items.map((o) => {
                  const np = newPrice(o.editionId);
                  const discount = np > BigInt(0) ? Number(((np - o.price) * BigInt(100)) / np) : 0;
                  return (
                    <button key={o.tokenId} className={`oc-card${o.tokenId === sel ? " on" : ""}`} onClick={() => setSel(o.tokenId)}>
                      <div className="art" style={art(o.editionId)}>
                        <span className="occbadge">OCCASION{discount > 0 ? ` · -${discount}%` : ""}</span>
                      </div>
                      <div className="body">
                        <div style={{ fontWeight: 600 }}>
                          {titleOf(o.editionId)} · licence #{o.tokenId}
                        </div>
                        <div className="occ-seller" style={{ padding: 0 }}>
                          <Avatar addr={o.seller} name={names[o.seller]?.name} hasAvatar={names[o.seller]?.hasAvatar} size={20} />
                          <span>{sellerName(o.seller)}</span>
                          <span className="addr">({shortAddr(o.seller)})</span>
                        </div>
                        <div className="price" style={{ marginTop: "0.4rem" }}>{formatEther(o.price)} ETH</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {selected && (
          <div className="oc-side">
            <div className="pf-box" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ height: "5rem", background: "linear-gradient(120deg, oklch(0.5 0.12 70), oklch(0.26 0.07 30) 60%, oklch(0.18 0.05 260))" }} />
              <div style={{ padding: "0 1.1rem 1.1rem", marginTop: "-2rem" }}>
                <Avatar addr={selected.seller} name={seller?.name} hasAvatar={seller?.hasAvatar} size={64} ring />
                <div style={{ fontSize: "1.25rem", fontWeight: 700, marginTop: "0.5rem" }}>
                  {seller?.name ?? sellerName(selected.seller)} <span className="addr">({shortAddr(selected.seller)})</span>
                </div>
                <div className="pf-meta">
                  {seller?.memberSince ? `membre depuis ${new Date(seller.memberSince).toLocaleDateString("fr-FR", { month: "short", year: "numeric" })} · ` : ""}
                  {seller ? `${seller.sales} vente${seller.sales > 1 ? "s" : ""} conclue${seller.sales > 1 ? "s" : ""}` : "…"}
                  {seller?.friend ? " · votre ami" : ""}
                </div>
                {seller?.bio && <p className="pf-bio" style={{ fontSize: "0.86rem", marginTop: "0.6rem" }}>{seller.bio}</p>}

                {others.length > 0 && (
                  <>
                    <div className="pf-label violet" style={{ marginTop: "1rem" }}>Ses autres annonces · {others.length}</div>
                    {others.map((o) => (
                      <button key={o.tokenId} className="pf-row" onClick={() => setSel(o.tokenId)} style={{ background: "none", border: 0, color: "inherit", width: "100%", textAlign: "left", cursor: "pointer", font: "inherit" }}>
                        <div className="art" style={art(o.editionId)} />
                        <div style={{ minWidth: 0 }}>
                          <div className="t">{titleOf(o.editionId)} · #{o.tokenId}</div>
                          <div className="s">{formatEther(o.price)} ETH</div>
                        </div>
                      </button>
                    ))}
                  </>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "1.1rem" }}>
                  <Link className="btn sunset" href={`/trade?action=buy&token=${selected.tokenId}`} style={{ textAlign: "center" }}>
                    Acheter la licence #{selected.tokenId} · {formatEther(selected.price)} ETH
                  </Link>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <Link className="btn ghost" href={`/u/${selected.seller}`} style={{ flex: 1, textAlign: "center" }}>Voir le profil</Link>
                    {seller?.friend && (
                      <Link className="btn ghost" href={`/chat?with=${selected.seller}`} style={{ flex: 1, textAlign: "center" }}>Message</Link>
                    )}
                  </div>
                  <Link className="addr" href={`/provenance/${selected.tokenId}`} style={{ color: "var(--cyan)", textAlign: "center" }}>
                    HISTORIQUE DE LA LICENCE ↗
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function OccasionsPage() {
  return (
    <Suspense>
      <OccasionsInner />
    </Suspense>
  );
}
