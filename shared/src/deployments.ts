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

// FULL RESET 2026-10-07, block 47799215 — lending generation: GameLicense
// carries ERC-4907 (guarded lend/endLoan) wired to FriendRegistry.
// Previous set (2026-07-24: 0xa140…6665 / 0x202c…5Aba / 0x7a0B…15f2) is
// abandoned, its tokens and editions with it.
export const DEPLOYMENTS: {
  gameRegistry: `0x${string}` | "";
  gameLicense: `0x${string}` | "";
  marketplace: `0x${string}` | "";
  friendRegistry: `0x${string}` | "";
} = {
  gameRegistry: "0x2dEC2e14C5Fe4184173888f7E7D7B92bC0570354",
  gameLicense: "0x15f6039e4F2cd5a55C002e6bd04106B9eAf63966",
  marketplace: "0xc77d595A3fEf7d637E59768bcE9863e4cB693A13",
  friendRegistry: "0xDBE78e090ED0cf5E9EB1B1C1dFe8FE4187638eB8",
};

export const DEPLOY_BLOCK = 47799215;
