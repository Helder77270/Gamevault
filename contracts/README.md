# contracts — Solidity + Foundry (^0.8.24)

- `GameRegistry.sol` — studios, games, editions (supply, price, royalty %)
- `GameLicense.sol` — ERC-721 + EIP-2981. Mint gated by World ID proof (native router on World Chain Sepolia). Stretch: ERC-4907.
- `Marketplace.sol` — list/buy. Reads `royaltyInfo()` for the studio 10%, adds 5% platform fee, 85% to seller. EIP-2981 is load-bearing.

Deploy target: World Chain Sepolia. Addresses go into `shared/`.
