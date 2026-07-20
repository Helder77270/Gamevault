# TODO — GameVault, ETHGlobal Lisbon (July 24–26, 2026)

## Pre-flight (BEFORE July 24 — do this week)
- [ ] Verify Subgraph Studio supports `worldchain-sepolia` as a network.
      If not → ask The Graph sponsors on Discord day 0; plan B is pitching
      the indexing story on a supported network.
- [ ] Walk the World ID testnet flow once end-to-end with the simulator
      (https://simulator.worldcoin.org) so mint verification isn't a
      day-1 surprise.
- [ ] Throwaway deployer key funded with World Chain Sepolia ETH.
- [ ] Test SD card reader + USB drives on both dev machines (mount, write
      speed, volume labels).
- [ ] Print SD cartridge sleeves (demo theater — replaces the CD tray moment).

## P1 — Contracts + World ID mint
- [ ] GameRegistry.sol: studios, games, editions (supply, price, royalty %)
- [ ] GameLicense.sol: ERC-721 + EIP-2981 royaltyInfo
- [ ] Mint gated by World ID proof verification (native router on World Chain)
- [ ] Deploy to World Chain Sepolia, addresses into shared/

## P2 — Ticket service (ticketd) — promoted from stretch, demo depends on it
- [ ] POST /ticket: verify SIWE sig → recover secp256k1 pubkey from sig →
      ownerOf(tokenId) check → ECIES-wrap content key to pubkey →
      platform-sign ticket → return
- [ ] Renewal path (same endpoint, existing ticket + fresh SIWE)
- [ ] Re-wrap on resale (buyer's first SIWE post-purchase triggers issuance)
- [ ] shared/: ticket types + sign/verify lib (@noble/curves, @noble/ciphers)

## P3 — Launcher (Tauri v2)
- [ ] Removable-volume scan for /gamevault/ticket.json (sysinfo)
- [ ] Ticket platform-signature verify (platform pubkey embedded)
- [ ] First-launch pairing: QR → web SIWE page → cache owner pubkey + session
- [ ] Nonce challenge against paired wallet; signer == ticket owner
- [ ] Hybrid owner check: ownerOf() with 2s timeout when online; sig + expiry
      offline
- [ ] AES-256-GCM decrypt IN MEMORY; custom protocol handler serves Phaser
      bundle from memory — never write plaintext to disk
- [ ] Rewrite refreshed ticket.json to media on renewal

## P4 — Marketplace resale ← DEMO LOCKS HERE
- [ ] Marketplace.sol: list/buy; read royaltyInfo() for studio 10%, add 5%
      platform fee, 85% to seller
- [ ] web/: marketplace UI, buy flow → buyer SIWE → ticketd issues new ticket
- [ ] End-to-end rehearsal: transfer to second wallet → new machine launches,
      seller machine revoked (online check)

## P5 — Subgraph + provenance
- [ ] Entities: Studio, Game, Edition, License, Transfer, RoyaltyPayment
- [ ] web/ provenance page per token

## P6 — Station + demo theater
- [ ] station/: detect removable volume, write /gamevault/ payload
      (build.enc, ticket.json, meta.json, launcher binaries)
- [ ] Live "write the cartridge" moment scripted into the demo

## Stretch (only after P4 rehearsal passes)
- [ ] ERC-4907 lending (launcher: userOf if set, else ownerOf)
- [ ] 0G Storage: encrypted build upload + gated re-download
- [ ] Key re-wrap UX polish

## Blocked / flagged
(record sponsor-SDK stubs here per the 45-min rule)
