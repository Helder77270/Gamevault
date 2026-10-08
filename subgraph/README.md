# subgraph — The Graph format, hosted on Goldsky (Base Sepolia)

Indexes the three contracts (addresses + start blocks in `subgraph.yaml`,
mirroring `shared/src/deployments.ts`).

Entities: Studio, Game, Edition, License (owner, listing, current borrower),
Transfer, RoyaltyPayment, Loan (one per ERC-4907 `UpdateUser`), PendingPayout
(Marketplace pull-payment credits).

Consumer: `web/app/provenance/[tokenId]` via `SUBGRAPH_URL`
(`shared/src/deployments.ts`, overridable with `NEXT_PUBLIC_SUBGRAPH_URL`).

## Deploy

Hosting: Goldsky (The Graph Studio account blocked; Alchemy Subgraphs shut down
on 2025-12-08). The public query URL uses the `prod` tag, so it does not change
between versions.

1. `subgraph/.env` (gitignored) holds `GOLDSKY_DEPLOY_KEY=<Goldsky API key>`.
2. From `subgraph/`, in Git Bash:

```bash
npm run build -w @gamevault/subgraph
set -a && . ./.env && set +a
npx -y @goldskycom/cli@13.17.0 subgraph deploy gamevault/<version> --path build --tag prod --token "$GOLDSKY_DEPLOY_KEY"
```

Bump `<version>` on every deploy (0.2.0 = 2026-10-08, 0.3.0 = v1.1 contracts, 2026-10-08). When contract addresses
change, update `subgraph.yaml` (address + startBlock) and regenerate the ABIs
from `contracts/out/*.sol/*.json` first.
