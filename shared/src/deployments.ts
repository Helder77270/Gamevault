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

// KEYS SEPARATED 2026-10-07, block 47811332 (audit K1). Roles:
//   GameLicense.owner / Marketplace fee receiver : admin 0x46B2…A322
//   GameLicense.attestationSigner (rotatable)     : 0x6fB3…1387
//   ticket signer : off-chain only, pubkey embedded in the launcher
// The previous all-in-one platform key (0xAD5B…631b, leaked) holds no role
// anymore. Also in this set: EIP-712 attestations bound to a tokenId,
// no false ERC-4907 claim, resurrected Marketplace listings rejected.
// Earlier sets of the day (v1 0x2dEC…, v2 0x4030…, v3 0x9FC8…) abandoned.
export const DEPLOYMENTS: {
  gameRegistry: `0x${string}` | "";
  gameLicense: `0x${string}` | "";
  marketplace: `0x${string}` | "";
} = {
  gameRegistry: "0x7546b4D2f62052468957FD9381cf4Ac433776aba",
  gameLicense: "0xcB73916fA8AF03894B85e6e05aa8a8169f046Bd9",
  marketplace: "0x89dFfcfdAd3f0EA66554821CAcB9D004E0af8a40",
};

export const DEPLOY_BLOCK = 47811332;
