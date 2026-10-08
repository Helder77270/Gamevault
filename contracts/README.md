# contracts — Solidity 0.8.24 + Foundry, Base Sepolia

- `GameRegistry.sol` — studios, games, editions (supply, price, royaltyBps ≤ 20 %, `resellable` = the studio's choice to allow resale, fixed at creation; no resale forces a 0 royalty, **buildCid + buildHash** = IPFS location + integrity commitment of the encrypted build).
- `GameLicense.sol` — ERC-721 + ERC-2981. `buy(editionId)` = primary sale, 92 % to the studio and 8 % to the platform (`PRIMARY_FEE_BPS`; Steam 30 %, Epic 12 %, itch.io 10 % by default), royalty set per token. Copies of a non-resellable edition cannot be transferred (`isResellable(tokenId)`), but can still be lent. Lending (ERC-4907 views, guarded `lend`/`endLoan`: EIP-712 friendship attestation, 3-day friendship, 14 days max, 24 h cooldown; a transfer kills the loan). `transferCount` per token. Owner = admin (Ownable2Step), rotatable attestation signer.
- `Marketplace.sol` — list/unlist/buy. Studio cut READ from `royaltyInfo()` + flat 5 % platform fee (85/10/5 on a 10 % edition). Refuses to list a copy whose edition has resale disabled. Stale listings rejected (`transferCount`). Payments pushed with a 30k gas stipend, credited to `pendingWithdrawals` + `withdraw()` if a receiver refuses.
- `interfaces/IGameVaultEvents.sol` — the event spec shared with the subgraph. Never change one without the other.

## Setup (fresh clone)
```
forge install foundry-rs/forge-std --no-git   # lib/ is gitignored (CI clones v1.16.2)
forge build && forge test                      # 40 tests: GameVault, Lending, Payments
```
OpenZeppelin resolves from the repo-root node_modules (see foundry.toml remappings) — run `npm ci` at the root first.

## Deploy (env from contracts/.env, gitignored)
- `PRIVATE_KEY` pays gas only and must hold no role.
- `ADMIN_ADDRESS` = GameLicense owner + platform fee receiver.
- `ATTEST_SIGNER` = address of ticketd's `ATTEST_SIGNER_PRIVKEY`.

```
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
```
Then paste the addresses into `shared/src/deployments.ts` (single source of
truth for web, launcher and ticketd) and `subgraph/subgraph.yaml` (+ startBlock).

To replace only the Marketplace (nothing references it on-chain):
```
GAME_LICENSE=0x… forge script script/DeployMarketplace.s.sol --rpc-url base_sepolia --broadcast
```
