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

// LENDING v2 2026-10-07, block 47800110 — FriendRegistry enumerates the
// incoming inbox on-chain (public RPCs cap eth_getLogs) + decline();
// GameLicense guard durations are constructor-set (this deploy: 3 d
// friendship, 14 d max loan, 24 h cooldown). Earlier sets (07-24 and the
// same-day v1 0x2dEC…0354) are abandoned, tokens and editions with them.
export const DEPLOYMENTS: {
  gameRegistry: `0x${string}` | "";
  gameLicense: `0x${string}` | "";
  marketplace: `0x${string}` | "";
  friendRegistry: `0x${string}` | "";
} = {
  gameRegistry: "0x4030a2b4f974DdCAA629f00BB0DF83f28089B5fd",
  gameLicense: "0x436a2CCB3c9244993526a5207643F7d2e9316Bb6",
  marketplace: "0xBfDa7132Cc6Ab3A0f139d687bf95A3e277F4F2ee",
  friendRegistry: "0x59d57b193007f79Fa60379137a97f09C012Ebd57",
};

export const DEPLOY_BLOCK = 47800110;
