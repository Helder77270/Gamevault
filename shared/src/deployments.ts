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

// LENDING v3 2026-10-07, block 47800634 — friendship is OFF-CHAIN (ticketd
// DB, wallet signatures, zero gas); lend() verifies a platform-signed
// friendship attestation on-chain and keeps the guards (this deploy: 3 d
// friendship, 14 d max loan, 24 h cooldown — constructor-set). Earlier
// sets of the day (v1 0x2dEC…0354, v2 0x4030…B5fd) are abandoned.
export const DEPLOYMENTS: {
  gameRegistry: `0x${string}` | "";
  gameLicense: `0x${string}` | "";
  marketplace: `0x${string}` | "";
} = {
  gameRegistry: "0x9FC8d14a00205a3996b196042415A8C7660e7241",
  gameLicense: "0x645a5b9cD9469FbB239b9c6Ae197d75144A54102",
  marketplace: "0x6D9990C611A4b5d330aEe44A7AB784E0F2bE5355",
};

export const DEPLOY_BLOCK = 47800634;
