// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GameVault event spec — the contract between Solidity and the subgraph.
/// @notice The implementations MUST emit exactly these events (the subgraph
///         ABIs in subgraph/abis/ are generated from this file — any drift
///         breaks indexing silently). ERC-721 Transfer is emitted by
///         GameLicense via OpenZeppelin as usual.
interface IGameVaultEvents {
    // ── GameRegistry ─────────────────────────────────────────────
    event StudioRegistered(uint256 indexed studioId, address indexed owner, string name);
    event GameCreated(uint256 indexed gameId, uint256 indexed studioId, string title);
    event EditionCreated(
        uint256 indexed editionId,
        uint256 indexed gameId,
        uint256 supply,
        uint256 price,
        uint96 royaltyBps,
        bool resellable,
        string buildCid,
        bytes32 buildHash
    );

    // ── GameLicense (in addition to ERC-721 Transfer) ────────────
    event LicenseMinted(uint256 indexed tokenId, uint256 indexed editionId, address indexed to);

    // ── Marketplace ──────────────────────────────────────────────
    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event Unlisted(uint256 indexed tokenId);
    event Sale(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        uint256 price,
        uint256 royaltyAmount,
        uint256 platformFee
    );
    /// A sale share the receiver refused (or out of stipend) — kept in the
    /// Marketplace until the payee calls withdraw() (audit K4).
    event PaymentCredited(address indexed payee, uint256 amount);
    event Withdrawn(address indexed payee, uint256 amount);
}
