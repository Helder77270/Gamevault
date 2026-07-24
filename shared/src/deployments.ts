// Chain + deployed contract addresses — THE single place to update.
// Decided 2026-07-23: Base Sepolia (simpler tooling than World Chain for
// now; The Graph works there; World ID via IDKit cloud verification).
// Empty address = not deployed yet; consumers degrade gracefully (ticketd
// skips ownerOf with a loud warning, launcher falls back to offline mode).
// Self-contained module (subpath export: @gamevault/shared/deployments).

export const CHAIN = {
  id: 84532,
  name: "Base Sepolia",
  rpcUrl: "https://sepolia.base.org",
} as const;

// Deployed 2026-07-24, block 44563428 (contracts/broadcast has the receipts)
export const DEPLOYMENTS: {
  gameRegistry: `0x${string}` | "";
  gameLicense: `0x${string}` | "";
  marketplace: `0x${string}` | "";
} = {
  gameRegistry: "0xa1401b1bbf85202F88E59F54701F541f41656665",
  gameLicense: "0x202cF87C36B29469F8A1fe383aBA9C72C0465Aba",
  marketplace: "0x7a0BE706772186eE84fB69f630b23E5af2e515f2",
};

export const DEPLOY_BLOCK = 44563428;
