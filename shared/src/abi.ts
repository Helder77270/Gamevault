// Minimal ABIs for the marketplace flows — shared by web/ (writes) and
// launcher/ (reads). Self-contained (subpath: @gamevault/shared/abi).

export const LICENSE_ABI = [
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "isApprovedForAll",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getApproved",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "buy",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "editionId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "transferCount",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "editionOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "nextTokenId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  // ── Lending (ERC-4907 + guarded writes) ────────────────────
  {
    name: "userOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "userExpires",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "lend",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "to", type: "address" },
      { name: "expires", type: "uint64" },
      { name: "since", type: "uint64" },
      { name: "deadline", type: "uint64" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "endLoan",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "lastLoanEnd",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "uint64" }],
  },
  {
    name: "LicenseMinted",
    type: "event",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "editionId", type: "uint256", indexed: true },
      { name: "to", type: "address", indexed: true },
    ],
  },
  {
    name: "UpdateUser",
    type: "event",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "expires", type: "uint64", indexed: false },
    ],
  },
] as const;


export const REGISTRY_ABI = [
  {
    name: "registerStudio",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "name", type: "string" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "createGame",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "studioId", type: "uint256" },
      { name: "title", type: "string" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "createEdition",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId", type: "uint256" },
      { name: "supply", type: "uint256" },
      { name: "price", type: "uint256" },
      { name: "royaltyBps", type: "uint96" },
      { name: "buildCid", type: "string" },
      { name: "buildHash", type: "bytes32" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "editions",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "editionId", type: "uint256" }],
    outputs: [
      { name: "gameId", type: "uint256" },
      { name: "supply", type: "uint256" },
      { name: "price", type: "uint256" },
      { name: "royaltyBps", type: "uint96" },
      { name: "buildCid", type: "string" },
      { name: "buildHash", type: "bytes32" },
      { name: "minted", type: "uint256" },
    ],
  },
  {
    name: "editionCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "games",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "gameId", type: "uint256" }],
    outputs: [
      { name: "studioId", type: "uint256" },
      { name: "title", type: "string" },
    ],
  },
  {
    name: "studios",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "studioId", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "name", type: "string" },
    ],
  },
  {
    name: "StudioRegistered",
    type: "event",
    inputs: [
      { name: "studioId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "name", type: "string", indexed: false },
    ],
  },
  {
    name: "GameCreated",
    type: "event",
    inputs: [
      { name: "gameId", type: "uint256", indexed: true },
      { name: "studioId", type: "uint256", indexed: true },
      { name: "title", type: "string", indexed: false },
    ],
  },
  {
    name: "EditionCreated",
    type: "event",
    inputs: [
      { name: "editionId", type: "uint256", indexed: true },
      { name: "gameId", type: "uint256", indexed: true },
      { name: "supply", type: "uint256", indexed: false },
      { name: "price", type: "uint256", indexed: false },
      { name: "royaltyBps", type: "uint96", indexed: false },
      { name: "buildCid", type: "string", indexed: false },
      { name: "buildHash", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const MARKETPLACE_ABI = [
  {
    name: "listings",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "seller", type: "address" },
      { name: "price", type: "uint256" },
      { name: "transferNonce", type: "uint256" },
    ],
  },
  {
    name: "list",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "price", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "unlist",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "buy",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  // Pull fallback (audit K4): shares a receiver refused, claimable later.
  {
    name: "pendingWithdrawals",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "payee", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;
