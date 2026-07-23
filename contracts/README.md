# contracts — Solidity + Foundry (0.8.24), Base Sepolia

- `GameRegistry.sol` — studios, games, editions (supply, price, royaltyBps ≤ 20%, **buildCid + buildHash** = IPFS location + integrity commitment of the encrypted build)
- `GameLicense.sol` — ERC-721 + EIP-2981. `buy(editionId)` = primary sale, 100% to the studio, royalty set per-token from the edition. `ownerOf()` is what ticketd and the launcher check.
- `Marketplace.sol` — list/unlist/buy. Studio cut READ from `royaltyInfo()` + flat 5% platform fee → 85/10/5 on a 10% edition. `buy()` = the revocation moment.
- `interfaces/IGameVaultEvents.sol` — the event spec shared with the subgraph. Never change one without the other.

## Setup (fresh clone)
```
forge install foundry-rs/forge-std --no-git   # vendored lib/ is gitignored
forge build && forge test                      # 11 tests
```
OpenZeppelin resolves from the repo-root node_modules (see foundry.toml remappings) — run `npm install` at the root first.

## Deploy (throwaway key, funded with Base Sepolia ETH)
```
$env:PRIVATE_KEY = "0x..."
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
```
Then paste the three printed addresses into `shared/src/deployments.ts` (arms ticketd ownerOf + launcher live revocation) and `subgraph/subgraph.yaml` (+ startBlock, then deploy the subgraph).
