# TODO — GameVault (post-hackathon reframe, 2026-07-23)

No deadline pressure anymore — sponsor-track items dropped, The Graph kept
on merit, storage decided (IPFS behind shared/storage.ts). Work top-down.

## P1 — Contracts on Base Sepolia (critical path — Helder)
- [ ] GameRegistry.sol: studios, games, editions (supply, price, royalty %,
      **buildCid, buildHash**)
- [ ] GameLicense.sol: ERC-721 + EIP-2981 royaltyInfo, simple mint (no
      World ID)
- [ ] Marketplace.sol: list/buy, reads royaltyInfo() (10% studio) + 5%
      platform fee, 85% seller
- [ ] Deploy → paste the 3 addresses into shared/src/deployments.ts
      (this single edit arms ticketd ownerOf() AND launcher live revocation)
- [ ] Fund throwaway deployer with Base Sepolia ETH (faucet)

## P2 — Studio publish flow (build → IPFS → chain)
- [x] shared/storage.ts: putBuild (Pinata pin) / fetchBuild (gateway +
      sha256 integrity check) — 0G/other swap = this one file (2026-07-23)
- [x] station: `npm run publish -w station` — pins build.enc, prints
      CID + hash to paste on-chain (2026-07-23; needs PINATA_JWT in env)
- [ ] After P1: register CID+hash in GameRegistry at edition creation
- [ ] web/ admin page for studios (upload → encrypt → pin → register)

## P3 — Launcher verified re-download
- [ ] Cartridge with ticket but no/corrupt build.enc → "Télécharger le
      build" → fetchBuild(cid, expectedHash) → write to cartridge
      (needs P1 for the on-chain CID; catalog.ts carries it meanwhile)

## P4 — Resale end-to-end on real contracts (reference demo)
- [ ] Buy flow against Marketplace.sol in web/
- [ ] Full rehearsal: transfer → new machine pairs → old machine revoked
      live (launcher hybrid check goes green the moment P1 lands)

## P5 — Subgraph (Base Sepolia) + provenance
- [ ] Entities: Studio, Game, Edition, License, Transfer, RoyaltyPayment
- [ ] web/ provenance page per token (owner chain, royalties paid)
- [ ] Launcher full library via subgraph (games owned, cartridge or not)
- [ ] Replace shared/catalog.ts mock with registry+subgraph reads

## P6 — UX
- [ ] WalletConnect purchase in-launcher (approve on phone)
- [ ] Ship launcher binaries onto cartridges (npm run tauri build)

## Done so far (see HANDOFF.md for detail)
Full local loop works: cartridge detect → platform-sig verify → REAL
pairing (OS keystore device key, QR → SIWE → ticketd) → in-memory decrypt
→ Phaser game. Hybrid owner check + renewal + station writer ready and
waiting on P1 addresses. Selftests: shared 6/6, ticketd 6/6.

## Later ideas
ERC-4907 lending · 0G storage swap · World ID gating (if a real need
returns) · printed SD sleeves · embedded provenance viewer in launcher
