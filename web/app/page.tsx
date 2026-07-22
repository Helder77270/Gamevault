"use client";

import { useAccount } from "wagmi";

// MOCK — replaced by on-chain reads (GameRegistry + subgraph) once the
// contracts land (P1). Structure mirrors the future Edition entity.
const EDITIONS = [
  {
    id: 1,
    title: "GameVault Runner",
    studio: "GameVault Dev",
    price: "0.01",
    royaltyPct: 10,
    minted: 3,
    supply: 100,
    available: true,
  },
  {
    id: 2,
    title: "Neon Depths",
    studio: "Studio Abysse",
    price: "0.025",
    royaltyPct: 12,
    minted: 0,
    supply: 250,
    available: false,
  },
  {
    id: 3,
    title: "Pixel Bastion",
    studio: "Forteresse Games",
    price: "0.015",
    royaltyPct: 8,
    minted: 0,
    supply: 500,
    available: false,
  },
];

export default function Marketplace() {
  const { isConnected } = useAccount();

  const buy = (title: string) => {
    alert(
      `Achat de « ${title} » — en attente du déploiement des contrats (P1).\n` +
        `Le flux réel : buy() sur Marketplace.sol → transfert du NFT → appairage → ticket.`,
    );
  };

  return (
    <>
      <section className="hero">
        <h1>Des jeux indés que vous possédez pour de vrai.</h1>
        <p>
          Chaque copie est une licence ERC-721 écrite sur une cartouche USB/SD : jouable hors ligne, prêtable,
          revendable — avec royalties automatiques aux studios via EIP-2981.
        </p>
        <p className="tagline">« Le support est le véhicule, la blockchain est le verrou. »</p>
      </section>

      <p className="notice">
        ⚠ Données de démonstration — les contrats World Chain Sepolia arrivent (P1). L&apos;achat déclenchera
        buy() sur Marketplace.sol : 85 % vendeur · 10 % studio (EIP-2981) · 5 % plateforme.
      </p>

      <h2 className="section">Éditions disponibles</h2>
      <div className="grid">
        {EDITIONS.map((e) => (
          <article className="card" key={e.id}>
            <div className="cover">{e.title.charAt(0)}</div>
            <div className="body">
              <h3>{e.title}</h3>
              <span className="studio">{e.studio}</span>
              <div className="meta">
                <span>
                  {e.minted}/{e.supply} mintés
                </span>
                <span>royalties {e.royaltyPct} %</span>
              </div>
              <div className="row">
                <span className="price">{e.price} ETH</span>
                <button
                  className="btn"
                  disabled={!e.available}
                  title={
                    !e.available
                      ? "Bientôt disponible"
                      : isConnected
                        ? "Acheter cette licence"
                        : "Achat possible après connexion du wallet"
                  }
                  onClick={() => buy(e.title)}
                >
                  Acheter
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
