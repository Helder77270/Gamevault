# web — Next.js 15 + React 19, wagmi 2 / RainbowKit / viem

Every page that needs a wallet signature. The launcher opens these pages;
the wallet never touches the launcher or the cartridge.

| Page | Purpose |
|---|---|
| `/` | on-chain catalogue, second-hand listings (stale ones filtered) |
| `/game/[editionId]` | store page + primary purchase (`GameLicense.buy`) |
| `/trade?action=list\|unlist\|buy&token=N` | resale actions opened by the launcher (waits for receipts) |
| `/pair` | target of the launcher's pairing QR: device slots, SIWE message, ticket request |
| `/studio` | register studio + game, signed build publish via ticketd, create edition |
| `/friends` | friends (signed, zero gas), lending (`lend` / `endLoan`) |
| `/profile` | pseudo, avatar, favorites, most played, devices, pending payouts |
| `/provenance/[tokenId]` | licence history from the subgraph (Goldsky) |

Env (all optional): `NEXT_PUBLIC_TICKETD_URL` (default http://localhost:8787),
`NEXT_PUBLIC_SUBGRAPH_URL` (default in `shared/src/deployments.ts`),
`NEXT_PUBLIC_WC_PROJECT_ID` (needed for the mobile WalletConnect QR).

```
npm run dev -w @gamevault/web     # http://localhost:3000
npm run build -w @gamevault/web
```
