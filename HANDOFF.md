# HANDOFF — session context for teammates (and their Claude)

> Read CLAUDE.md first (project brief + conventions). This file adds what a
> new developer can NOT deduce from the code: decisions with their WHY,
> current state, and traps already paid for. Written 2026-07-22, two days
> before the hackathon (July 24–26, ETHGlobal Lisbon).

## State: what works TODAY (all verified by running it)

The full pairing + play loop works end-to-end locally, with real crypto:

1. Launcher (Tauri v2) detects USB/SD cartridges (`/gamevault/ticket.json`
   on removable volumes; `GAMEVAULT_DEV_MEDIA_DIR` env simulates one in dev).
2. Ticket platform-signature verified in TS (`shared/`), verdicts in UI:
   authentic / tampered / expired / **autre appareil** (sealed to another
   device — this state IS the resale mechanism).
3. Real pairing: launcher generates its device keypair in the **Windows
   Credential Manager** (first launch), shows a QR to `web/`'s `/pair` page,
   owner signs a SIWE message that EMBEDS the device pubkey (RainbowKit,
   worldchain-sepolia), `ticketd` verifies + seals the content key to that
   device (ECIES) + signs the ticket, launcher polls `GET /pending/:nonce`,
   re-verifies everything, writes `ticket.json` back onto the cartridge.
4. Play: Rust unwraps the content key with the keystore device key, decrypts
   `build.enc` (a real Phaser 3 game) IN MEMORY, serves it to the webview via
   the custom `game://` protocol. Plaintext never touches disk or JS.
5. Steam-like UI: Accueil / Boutique (native catalog from
   `shared/catalog.ts`) / Bibliothèque (session-gated).

Selftests (run them after any crypto change):
- `npm run selftest -w shared` — 6/6: sign/verify, wrap/unwrap, tamper, expiry
- `npm run selftest -w ticketd` — 6/6: issuance + 3 attack refusals

## What does NOT exist yet (priority order)

1. **`contracts/` — EMPTY. This is the critical path now** (Helder owns it):
   GameRegistry, GameLicense (ERC-721 + EIP-2981), World ID-gated mint,
   Marketplace (reads `royaltyInfo()`, adds 5% platform fee, 85% to seller).
   Deploy to World Chain Sepolia (chainId 4801).
2. Wiring the chain in: set `GAMELICENSE_ADDRESS` in `ticketd/.env`
   (activates the currently-SKIPPED `ownerOf()` check — it's an env var, not
   code) + implement the launcher's hybrid online check (2s timeout
   `ownerOf()` when network reachable → instant revocation; offline →
   sig+expiry). This closes milestone M4 = the demo.
3. `station/` (copy flow to real USB/SD), `subgraph/` (see Substreams note
   below), 0G Storage, printed SD sleeves.
4. Replace `shared/catalog.ts` mock with on-chain reads (single file —
   web and launcher both consume it).

## Architecture in 60 seconds (full detail: CLAUDE.md + the shared diagrams)

Four keys, strict separation of powers:
- **Wallet key** (owner's phone/extension): SIGNS only (SIWE, txs). Never
  touches launcher, media, or station.
- **Device key** (per machine, OS keystore): DECRYPTS. Born at first launch,
  never leaves the keystore. Why it exists: wallets have NO secp256k1
  decryption API — a key wrapped to the wallet could never be unwrapped.
- **Platform key** (ticketd .env): signs tickets → offline verifiability.
  Its pubkey is embedded in the launcher binary.
- **Content key** (AES-256-GCM, per edition): encrypts the build ONCE. Only
  travels inside an ECIES envelope (`wrappedContentKey`).

Ticket = platform-signed `{ tokenId, contract, chainId, ownerAddress,
devicePubKey, wrappedContentKey, issuedAt, expiresAt }`. NFT = on-chain
title deed; ticket = offline boarding pass derived from it. Renewal, resale
re-wrap and first issuance are ALL the same ticketd endpoint (a fresh SIWE
from the current owner).

Enforcement is HYBRID: live `ownerOf()` when online (demo revocation
moment); platform sig + 30-day expiry offline (Steam-style window — pitch it
as a feature, preempt the judges).

Known accepted limits (own them on stage): a technical seller who extracted
the content key pre-sale keeps a decrypted copy ("ownership verification,
not DRM"); platform key is a central signer (hackathon: throwaway in .env).

## Traps already paid for — do not rediscover these

**Environment (Windows):**
- The VS installer registry is BROKEN on Helder's machine (vswhere finds
  nothing) but MSVC 2019 Build Tools + SDK 19041 are installed and work.
  Everything Rust must go through `vcvars64.bat` — use `launcher/dev.cmd`,
  never raw `cargo`/`npm run tauri dev`. If a fresh machine shows
  `link.exe not found`, same fix.
- **Never build or run from WSL.** The launcher targets Windows (`.exe`,
  removable-volume scan, keystore); node_modules native bindings are
  per-OS. A WSL prompt (`/mnt/c/...`) = stop.
- npm workspaces: `-w <name>` works ONLY from the repo root. Inside a
  package dir, run scripts without `-w`. ("No workspaces found" = you're in
  the wrong directory.)
- Node versions differ per shell (23.x PowerShell, 22.12 via npm scripts).
  All direct-run TS uses `node --experimental-strip-types`.
- PowerShell 5.1 mangles embedded double quotes in `git commit -m` — no `"`
  inside commit messages.
- When closing the Tauri window, npm reports vite killed with error
  4294967295 — cosmetic, ignore.

**Code (cross-language crypto parity — the #1 subtle-bug source):**
- TS and Rust MUST match byte-for-byte. Two places where this already bit:
  ECIES KDF hashes the **compressed** shared point (33B, noble's
  `getSharedSecret(_, _, true)`) — Rust mirrors this in
  `crypto.rs::aes_key_from_ecdh` (NOT k256's `diffie_hellman`, which
  returns x-only). Envelope layout `[33B ephPub][12B nonce][ct+16B tag]`;
  build.enc `[12B nonce][ct+tag]`.
- Signatures cover CANONICAL bytes: tickets via `canonicalPayload()`
  (fixed field order, lowercased hex), pairing messages via
  `buildPairingMessage()`/`parsePairingMessage()` (parse then rebuild and
  byte-compare). NEVER hand-build these strings.
- Dev keys are deterministic (sha256 of fixed strings, `shared/devkeys.ts`)
  so all machines agree on fixtures. `make-dev-ticket` regenerates
  `ticket.json` + `build.enc` together — they share the content key, never
  regenerate one without the other.
- shared/ is imported as TS SOURCE: launcher via vite aliases (subpath
  entries BEFORE the bare one in vite.config.ts + tsconfig paths), web via
  `transpilePackages` + package.json `exports` subpaths, node via
  strip-types. New shared module → add it in all three places.
- wagmi is v2 (RainbowKit peer requirement — do NOT upgrade to v3). The
  Next build ignores optional `@x402/*` / RN-storage deps via IgnorePlugin
  (see web/next.config.mjs) — coinbase connector baggage.

## Pre-flight findings (done)

- ❌ **The Graph: subgraphs are NO LONGER supported on WorldChain** (screenshot
  2026-07-22 in Subgraph Studio). Official path = standalone **Substreams**.
  Decision pending: build Substreams (bigger lift) vs pitch The Graph track
  differently. Ask in #substreams on their Discord day 0. The demo does NOT
  depend on this (bloc 5, post-lock).
- World ID on testnet: use https://simulator.worldcoin.org; 45-min rule
  applies (stub + flag in TODO.md if it fights back).
- Hardware: USB drives + SD reader in hand, tested.

## Run everything (3 terminals)

```
# 1 — launcher (from launcher/):
.\dev.cmd
# 2 — web (from repo ROOT):
npm run dev -w web        # localhost:3000
# 3 — ticketd (from repo ROOT):
npm run dev -w ticketd    # localhost:8787
```

First-time setup on a fresh clone: `npm install` at root, then
`npm run build -w game && npm run make-dev-ticket -w shared` (build.enc and
game/dist are gitignored, regenerable). Rust toolchain: rustup (stable-msvc)
+ VS Build Tools C++ workload.

Dev fixture: `launcher/dev-media/` simulates an inserted cartridge. Its
ticket is sealed to the DEV device key, so a fresh launcher shows "autre
appareil" → use the pair button to seal it to your machine (that's the
resale flow, not a bug). WalletConnect mobile QR needs
`NEXT_PUBLIC_WC_PROJECT_ID` in `web/.env.local` (free at
cloud.walletconnect.com); extension wallets work without it.

## Team diagrams (share from the artifact page menu — they're private)

- Process flows EN: https://claude.ai/code/artifact/8ec062ab-abf6-456b-9dc9-72c7769c89ab
- Process flows FR: https://claude.ai/code/artifact/0406edc5-56ec-43f2-8c74-48bf6d8d1133
- Security map FR (keys, scenarios, golden rules): https://claude.ai/code/artifact/885c8016-318b-4a80-85b7-df57e89f3646

## Decision log (chronological, with WHY)

| Date | Decision | Why |
|---|---|---|
| 07-20 | CDs OUT, USB/SD only | CD-R write-once → renewed tickets had nowhere to go; station/ collapses to a file copy |
| 07-20 | ticketd promoted stretch→P2 | The demo climax (resale→revocation) IS re-wrap; everything consumes it |
| 07-20 | Hybrid enforcement (online ownerOf / offline expiry) | Pure-offline meant the seller's copy survives the entire demo |
| 07-20 | Offline-after-first-pairing (not "100% offline") | The nonce/SIWE transport needs one online moment; honest pitch |
| 07-22 | Content key wrapped to DEVICE key, not wallet | Wallets can't ECIES-decrypt; SIWE message embeds device pubkey to block substitution |
| 07-22 | Marketplace = separate website; launcher gets native read-only store | Wallet lives in the browser; browsing is data, only payment/signature needs the wallet |
| 07-22 | RainbowKit + wagmi v2 | Raw injected connector = extension roulette; EIP-6963 modal + WalletConnect QR |
| 07-22 | Subgraph → Substreams question opened | Studio dropped WorldChain subgraph support (see pre-flight) |
