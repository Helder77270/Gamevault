// Catalog data shared by web/ and launcher/ — ONE source of truth.
// MOCK for now: swapped for GameRegistry reads (+ subgraph) once contracts
// land (P1). The shape mirrors the future Edition entity.
// Self-contained module (subpath export: @gamevault/shared/catalog).

export interface Edition {
  id: number;
  title: string;
  studio: string;
  /** price in ETH, display string to avoid float drift */
  price: string;
  royaltyPct: number;
  minted: number;
  supply: number;
  available: boolean;
  blurb: string;
}

export const MOCK_EDITIONS: Edition[] = [
  {
    id: 1,
    title: "GameVault Runner",
    studio: "GameVault Dev",
    price: "0.01",
    royaltyPct: 10,
    minted: 3,
    supply: 100,
    available: true,
    blurb: "Ramassez 10 pièces, évitez les rouges. L'édition de développement.",
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
    blurb: "Plongée rogue-lite dans une fosse néon. Bientôt.",
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
    blurb: "Tower defense au pixel près. Bientôt.",
  },
];
