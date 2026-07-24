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
  /** IPFS CID of build.enc (from `npm run publish -w station`); on-chain after P1 */
  buildCid?: string;
  /** 0x-hex sha256 of build.enc — integrity check for re-downloads */
  buildSha256?: string;
  /** On-chain edition id in GameRegistry (content-key derivation + pairing) */
  editionId?: string;
}

export const MOCK_EDITIONS: Edition[] = [
  {
    id: 1,
    title: "GameVault Runner",
    studio: "GameVault Dev",
    price: "0.00001",
    royaltyPct: 10,
    minted: 3,
    supply: 100,
    available: true,
    blurb: "Ramassez 10 pièces, évitez les rouges. L'édition de développement.",
    buildCid: "QmT1xbCCRG3sc3Gju8AGrdXvfnUMuXftmBLjF1uw5vEF1U",
    buildSha256: "0x701338ec186baa41df25c5be7983e009602a012d4ff7952fbe8bc910bff3e7cb",
    editionId: "2",
  },
  {
    id: 4,
    title: "GameVault Snake",
    studio: "GameVault Dev",
    price: "0.00001",
    royaltyPct: 10,
    minted: 0,
    supply: 100,
    available: true,
    blurb: "Le classique, 15 pommes pour gagner. Deuxième jeu du catalogue.",
    buildCid: "QmT7MtaYwCSweKmVL9ETMncXcEmHe5UB4twUNNLMWcAr8w",
    buildSha256: "0x9c4c641b96401f45f888ee3690fcb6089335dc6e156812b9924080172943414f",
    editionId: "3",
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
