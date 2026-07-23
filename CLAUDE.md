# GameVault (working name) — ETHGlobal Lisbon 2026 Hackathon

## What this is
Tokenization platform for indie games. Every game copy is an ERC-721 license,
written onto a physical USB drive or SD "cartridge", playable OFFLINE (after
first pairing), lendable, and resellable with automatic royalties to studios.
Positioning: NOT DRM — ownership verification. "The physical media is the
vehicle, the blockchain is the lock."

## Hard constraints
- REFRAMED 2026-07-23: no longer attending ETHGlobal Lisbon — the 36h
  deadline and sponsor-track obligations (World ID, 0G, The Graph prizes)
  are DROPPED. Keep the hackathon quality bar anyway: bias toward WORKING
  over elegant, no premature abstraction.
- Target chain: BASE SEPOLIA, chainId 84532 (decided 2026-07-23 — simpler
  tooling than World Chain). Single source of truth:
  shared/src/deployments.ts (CHAIN + contract addresses).
- World ID: dropped for now (was a prize-track requirement). Mint is
  simple; identity gating can return later if a real need appears.
- The Graph: REINTEGRATED on its merits (supported on Base Sepolia) — the
  subgraph feeds the provenance pages, the full on-chain library, and the
  marketplace catalog. Real infra, not a checkbox.
- Storage (decided 2026-07-23): build.enc is PUBLIC bytes — encrypted
  once, useless without a ticket — so it lives on IPFS via a pinning
  service (Pinata). The edition's on-chain record carries buildCid +
  buildHash so any launcher can verify integrity. The storage backend sits
  behind shared/src/storage.ts (putBuild/fetchBuild) — swapping to 0G or
  another network later is a one-file change. Cartridges remain the
  PRIMARY distribution; IPFS is recovery/re-download + station source.
- The reference demo remains: write an SD cartridge live, transfer the NFT
  to another wallet, game launches on their machine and no longer on the
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
  downstream consumes it. `POST /ticket`: verify SIWE sig (message embeds the
  device pubkey) → check `ownerOf(tokenId)` == signer → wrap content key
  (ECIES) to the DEVICE pubkey → sign ticket with platform key → return.
  Also handles renewal and re-wrap on resale.
- `launcher/` — Tauri v2 app (Rust shell, TypeScript logic, web UI)
  - Reads license ticket from the inserted media, verifies platform signature,
    challenges local wallet with a nonce, verifies signer == ticket owner,
    unwraps AES content key, decrypts build, loads the Phaser game in-webview
    via a custom protocol handler serving FROM MEMORY (never write decrypted
    build to disk).
  - Offline after first pairing: first launch generates a DEVICE keypair
    (Rust side, OS keystore), shows a QR embedding the device pubkey → owner
    signs SIWE on the web page (message binds device pubkey) → launcher
    caches the signed pairing session; subsequent launches are fully offline.
    Online only for pairing and ticket refresh.
  - Plaintext stays in Rust: decrypt in Rust memory, serve via the custom
    protocol handler. The TS/webview side never holds the decrypted bundle
    or the content key.
- `game/` — Phaser 3 game (small 2D game), built as static bundle embedded in launcher
- `web/` — Next.js 14 + wagmi/viem: marketplace, studio onboarding, provenance
  pages, SIWE signing page (target of the launcher's QR code), admin media
  writing UI
- `station/` — Node script: assembles build + license ticket + launcher
  binaries into `/gamevault/` on a mounted USB/SD volume. Cross-platform file
  copy — detect removable volumes at runtime.
- `subgraph/` — The Graph, AssemblyScript. Entities: Studio, Game, Edition,
  License, Transfer, RoyaltyPayment. OPTIONAL BONUS on Base Sepolia
  (supported there; was NOT supported on WorldChain — one reason we moved).
- `shared/` — TypeScript types + ticket signing/verification lib (used by
  web, launcher, station, ticketd)

## The offline ticket system (core differentiator — do not simplify away)
- Game build encrypted ONCE with a symmetric AES-256-GCM content key.
  Same encrypted blob for every copy.
- Content key is WRAPPED (ECIES) — but NOT to the wallet pubkey: wallets
  expose no secp256k1 decryption API, so a key wrapped to the wallet could
  never be unwrapped. Instead it is wrapped to a DEVICE keypair (decided
  2026-07-22) generated by the launcher at first pairing and stored in the
  OS keystore. The wallet private key NEVER touches the media, the station,
  or the launcher.
- The owner's SIWE signature authorizes the device: the SIWE message embeds
  the device pubkey, so an attacker cannot substitute their own device.
  Ownership is proven by the wallet signature; decryption uses the device
  key. On resale, the buyer pairs their own device → ticketd wraps to it.
  Never re-encrypt the build.
- Ticket = { tokenId, contract, chainId, ownerAddress, devicePubKey,
  wrappedContentKey, issuedAt, expiresAt } signed by the platform key.
  Platform public key is embedded in the launcher.
- Enforcement is HYBRID (decided 2026-07-20):
  - Network reachable (2s timeout): live `ownerOf(tokenId)` check → instant
    revocation. This is what makes the on-stage revocation moment work.
  - Offline: platform signature + expiry check (default 30 days). A seller
    keeping a copy gets a 30-day grace window, then the ticket dies and
    renewal fails on-chain. Frame this proactively as a feature (Steam-style
    offline window), not a hole.
- Launch flow: verify ticket platform sig → verify cached pairing session
  (SIWE by ticket owner, binding this device's pubkey) → nonce self-check
  with the device key (proves keystore possession, anti-clone) → hybrid
  owner check → ECIES-unwrap content key with device privkey → decrypt in
  memory (Rust) → play.
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

## Priority order (when in doubt, work top-down) — updated 2026-07-23
1. Contracts on Base Sepolia: GameRegistry (editions carry buildCid +
   buildHash), GameLicense (ERC-721 + EIP-2981), Marketplace. Simple mint
   (no World ID). Paste addresses into shared/src/deployments.ts.
2. Studio publish flow: encrypt build → pin to IPFS → register CID+hash
   on-chain (station/publish + web admin later)
3. Launcher verified re-download: fetch CID → check hash against registry
   → rewrite build.enc on cartridge
4. Resale end-to-end on real contracts → live revocation (the reference
   demo) — everything upstream already works locally
5. Subgraph on Base + provenance page + full on-chain library in launcher
6. WalletConnect purchase in-launcher (Steam-Guard-style approval)
7. Later ideas: ERC-4907 lending, 0G storage swap, World ID gating,
   printed SD sleeves
