# GameVault (working name) — ETHGlobal Lisbon 2026 Hackathon

## What this is
Tokenization platform for indie games. Every game copy is an ERC-721 license,
written onto a physical USB drive or SD "cartridge", playable OFFLINE (after
first pairing), lendable, and resellable with automatic royalties to studios.
Positioning: NOT DRM — ownership verification. "The physical media is the
vehicle, the blockchain is the lock."

## Hard constraints
- This is a 36-hour hackathon project (July 24–26). Bias toward WORKING over
  elegant. No premature abstraction, no test coverage beyond critical paths.
- Target chain: World Chain Sepolia (World ID is native there).
- Sponsor integrations are mandatory (prize tracks): World ID, 0G Storage,
  The Graph. Never mock these — integrate the real SDKs.
- The demo climax is: write an SD cartridge live, transfer the NFT to a
  judge's wallet, game launches on their machine and no longer on the
  seller's. Every architectural decision must protect this flow.

## Physical media: USB / SD (decided 2026-07-20 — no CD burning)
- We invested in USB drives and an SD card reader. CDs are OUT: CD-R is
  write-once, so ticket renewal had nowhere to write the refreshed ticket.
  On USB/SD the launcher rewrites `ticket.json` in place — renewal works.
- Media convention: a `/gamevault/` folder at the volume root containing
  `build.enc`, `ticket.json`, `meta.json`, and launcher binaries.
- Launcher media detection: scan mounted removable volumes for
  `/gamevault/ticket.json` (Rust `sysinfo`, no OS-specific device APIs).
- `station/` is now a simple copy flow: detect removable volume, write the
  `/gamevault/` payload. No xorriso, no IMAPI2.

## Monorepo layout
- `contracts/` — Solidity + Foundry
  - `GameRegistry.sol` — studios, games, editions (supply, price, royalty %)
  - `GameLicense.sol` — ERC-721 + EIP-2981. Stretch: ERC-4907 lending
  - `Marketplace.sol` — list/buy. Reads `royaltyInfo()` from EIP-2981 for the
    studio cut (10%) and adds a 5% platform fee on top → 85% to seller.
    EIP-2981 is load-bearing, not decorative.
- `ticketd/` — Ticket service (Node/TS). PROMOTED from stretch — everything
  downstream consumes it. `POST /ticket`: verify SIWE sig → recover pubkey →
  check `ownerOf(tokenId)` → wrap content key (ECIES) to that pubkey → sign
  ticket with platform key → return. Also handles renewal and re-wrap on
  resale.
- `launcher/` — Tauri v2 app (Rust shell, TypeScript logic, web UI)
  - Reads license ticket from the inserted media, verifies platform signature,
    challenges local wallet with a nonce, verifies signer == ticket owner,
    unwraps AES content key, decrypts build, loads the Phaser game in-webview
    via a custom protocol handler serving FROM MEMORY (never write decrypted
    build to disk).
  - Offline after first pairing: first launch pairs via QR → SIWE page and
    caches the owner's pubkey + signed session; subsequent launches are fully
    offline. Online only for pairing and ticket refresh.
- `game/` — Phaser 3 game (small 2D game), built as static bundle embedded in launcher
- `web/` — Next.js 14 + wagmi/viem: marketplace, studio onboarding, provenance
  pages, SIWE signing page (target of the launcher's QR code), admin media
  writing UI
- `station/` — Node script: assembles build + license ticket + launcher
  binaries into `/gamevault/` on a mounted USB/SD volume. Cross-platform file
  copy — detect removable volumes at runtime.
- `subgraph/` — The Graph, AssemblyScript. Entities: Studio, Game, Edition,
  License, Transfer, RoyaltyPayment
  - PRE-FLIGHT (before July 24): verify Subgraph Studio supports
    `worldchain-sepolia`. If not, ask sponsors on Discord day 0.
- `shared/` — TypeScript types + ticket signing/verification lib (used by
  web, launcher, station, ticketd)

## The offline ticket system (core differentiator — do not simplify away)
- Game build encrypted ONCE with a symmetric AES-256-GCM content key.
  Same encrypted blob for every copy.
- Content key is WRAPPED (ECIES) to the current owner's public key. On resale,
  re-wrap to buyer's key. Never re-encrypt the build. The wallet private key
  NEVER touches the media or the station.
- ECIES cannot wrap to an address — a secp256k1 pubkey is only learnable from
  a signature. Ticket issuance is therefore gated on a SIWE signature from the
  owner; the buyer's first SIWE signature after purchase triggers issuance.
- Ticket = { tokenId, contract, chainId, ownerAddress, wrappedContentKey,
  issuedAt, expiresAt } signed by the platform key. Platform public key is
  embedded in the launcher.
- Enforcement is HYBRID (decided 2026-07-20):
  - Network reachable (2s timeout): live `ownerOf(tokenId)` check → instant
    revocation. This is what makes the on-stage revocation moment work.
  - Offline: platform signature + expiry check (default 30 days). A seller
    keeping a copy gets a 30-day grace window, then the ticket dies and
    renewal fails on-chain. Frame this proactively as a feature (Steam-style
    offline window), not a hole.
- Launch flow: verify ticket sig → nonce challenge signed by local/paired
  wallet → signer must equal ticket owner → hybrid owner check → unwrap key →
  decrypt in memory → play.
- Known limitation, own it before judges do: a technical seller who unwrapped
  the content key pre-sale can keep a decrypted copy. True of every scheme
  without hardware secure elements. "Ownership verification, not DRM."

## Conventions
- TypeScript strict mode everywhere. Solidity ^0.8.24, Foundry defaults.
- viem (not ethers). No hand-rolled crypto: use @noble/curves, @noble/ciphers.
- Keep secrets in .env, never commit. Deployer key is a throwaway hackathon key.
- Commit style: `feat(scope): …` — scopes are the top-level dirs above.
- If a sponsor SDK fights you for >45 min, stop, stub the interface, flag it
  in TODO.md, move on. Ask before removing any sponsor integration.
- World ID on testnet: budget the 45-min rule; know the Worldcoin simulator
  path (https://simulator.worldcoin.org) in advance.

## Priority order (when in doubt, work top-down)
1. Contracts deployed + mint with World ID proof verification
2. Ticket service (ticketd): issue / re-wrap / renew — everything consumes it
3. Launcher: media detect → ticket verify → hybrid online/offline owner
   check → decrypt → Phaser launch
4. Marketplace resale → triggers re-wrap → revocation demo works end-to-end
   ← LOCK THE DEMO HERE; everything after is bonus
5. Subgraph + provenance page
6. Station copy flow + printed SD cartridge sleeves
7. Stretch only: ERC-4907 lending (launcher check becomes userOf-if-set-else-
   ownerOf), 0G-gated re-download
