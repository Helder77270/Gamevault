# TODO — GameVault, ETHGlobal Lisbon (July 24–26, 2026)

## Pre-flight (BEFORE July 24 — do this week)
- [x] Verify Subgraph Studio supports `worldchain-sepolia` — RESULT 2026-07-22:
      ❌ "Subgraphs no longer supported on WorldChain". Official path is
      standalone SUBSTREAMS. → P5 becomes Substreams, scope TBD; confirm
      approach in #substreams on The Graph Discord day 0. Demo does NOT
      depend on this (bloc 5, post-lock).
- [ ] Walk the World ID testnet flow once end-to-end with the simulator
      (https://simulator.worldcoin.org) so mint verification isn't a
      day-1 surprise.
- [ ] Throwaway deployer key funded with World Chain Sepolia ETH.
- [ ] Test SD card reader + USB drives on both dev machines (mount, write
      speed, volume labels).
- [ ] Print SD cartridge sleeves (demo theater — replaces the CD tray moment).

## P1 — Contracts + World ID mint — TARGET: BASE SEPOLIA (switched 07-23)
- [ ] GameRegistry.sol: studios, games, editions (supply, price, royalty %)
- [ ] GameLicense.sol: ERC-721 + EIP-2981 royaltyInfo
- [ ] Mint gated by World ID: IDKit widget + CLOUD proof verification (no
      native router on Base — pre-flight: check for a bridged router;
      45-min rule)
- [ ] Deploy to Base Sepolia (84532), paste addresses into
      shared/src/deployments.ts ← this single edit arms ticketd ownerOf()
      AND launcher live revocation
- [ ] Fund throwaway deployer with Base Sepolia ETH (faucet)

## P2 — Ticket service (ticketd) — promoted from stretch, demo depends on it
- [x] POST /ticket: verify SIWE sig (message embeds device pubkey) →
      ownerOf(tokenId) check → ECIES-wrap content key to device pubkey →
      platform-sign ticket → return (2026-07-22; selftest 6/6 incl. attacks)
      ⚠ ownerOf() SKIPPED until GAMELICENSE_ADDRESS set (P1)
- [x] Renewal path = same endpoint with fresh SIWE (2026-07-22)
- [x] Re-wrap on resale = buyer pairs their device post-purchase, same
      endpoint (2026-07-22)
- [x] shared/: ticket types + sign/verify + ECIES + build crypto, selftest
      passes (2026-07-22)

## P3 — Launcher (Tauri v2)
- [x] Removable-volume scan for /gamevault/ticket.json (sysinfo) + dev-media
      override (2026-07-22)
- [x] Ticket platform-signature verify, dev platform pubkey embedded
      (2026-07-22)
- [x] AES-256-GCM decrypt IN MEMORY (Rust), custom protocol game:// serves
      Phaser bundle from RAM, stop_game purges it (2026-07-22) — M3 ✔
- [x] Steam-like UI: Accueil/Bibliothèque, session-gated library
      (2026-07-22 — session still SIMULATED)
- [x] REAL pairing: device keypair in OS keystore (Credential Manager) +
      in-launcher QR → web SIWE → ticket fetched by nonce, re-verified,
      written to cartridge (2026-07-22)
- [x] Hybrid owner check: pre-play live ownerOf() (2s budget) when
      shared/deployments.ts is filled; offline/undeployed → sig + expiry
      (2026-07-22) ⚠ inert until P1 addresses are pasted
- [x] Renewal: expired+ours tickets get a Renouveler button reusing the
      pairing flow; refreshed ticket rewritten to media (2026-07-22)

## P4 — Marketplace resale ← DEMO LOCKS HERE
- [ ] Marketplace.sol: list/buy; read royaltyInfo() for studio 10%, add 5%
      platform fee, 85% to seller
- [ ] web/: marketplace UI, buy flow → buyer SIWE → ticketd issues new ticket
- [ ] End-to-end rehearsal: transfer to second wallet → new machine launches,
      seller machine revoked (online check)

## P5 — Subgraph + provenance — OPTIONAL BONUS (Base Sepolia IS supported
##      by Subgraph Studio, unlike WorldChain; do only after M4 rehearses)
- [ ] Entities: Studio, Game, Edition, License, Transfer, RoyaltyPayment
- [ ] web/ provenance page per token

## P6 — Station + demo theater
- [x] station/: list removable volumes + write /gamevault/ payload with
      sanity checks (2026-07-22) — `npm run write -w station -- E:`
- [ ] Live "write the cartridge" moment scripted into the demo
- [ ] Ship launcher binaries onto the cartridge too (needs a release build:
      npm run tauri build)

## Stretch (only after P4 rehearsal passes)
- [ ] ERC-4907 lending (launcher: userOf if set, else ownerOf)
- [ ] 0G Storage: encrypted build upload + gated re-download
- [ ] Key re-wrap UX polish

## Blocked / flagged
(record sponsor-SDK stubs here per the 45-min rule)
