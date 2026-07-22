// Deployed contract addresses — THE single place to paste them after P1.
// Empty string = not deployed yet; consumers degrade gracefully (ticketd
// skips ownerOf with a loud warning, launcher falls back to offline mode).
// Self-contained module (subpath export: @gamevault/shared/deployments).

export const WORLDCHAIN_SEPOLIA = {
  id: 4801,
  name: "World Chain Sepolia",
  rpcUrl: "https://worldchain-sepolia.g.alchemy.com/public",
} as const;

export const DEPLOYMENTS: {
  gameRegistry: `0x${string}` | "";
  gameLicense: `0x${string}` | "";
  marketplace: `0x${string}` | "";
} = {
  gameRegistry: "",
  gameLicense: "",
  marketplace: "",
};
