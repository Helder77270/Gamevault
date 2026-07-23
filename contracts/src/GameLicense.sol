// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IGameVaultEvents} from "./interfaces/IGameVaultEvents.sol";
import {GameRegistry} from "./GameRegistry.sol";

/// @title GameLicense — one token = one game copy.
/// @notice ownerOf() is what ticketd checks before sealing a ticket and what
///         the launcher checks live for instant revocation. EIP-2981 royalty
///         is set per-token at mint from the edition's royaltyBps — the
///         Marketplace READS it (load-bearing, not decorative).
contract GameLicense is ERC721, ERC2981, ReentrancyGuard, IGameVaultEvents {
    GameRegistry public immutable registry;
    uint256 public nextTokenId;
    mapping(uint256 tokenId => uint256) public editionOf;

    constructor(GameRegistry registryContract) ERC721("GameVault License", "GVL") {
        registry = registryContract;
    }

    /// @notice Primary sale: pay the edition price, receive the license.
    ///         100% of the primary price goes to the studio.
    function buy(uint256 editionId) external payable nonReentrant returns (uint256 tokenId) {
        (address studioOwner, uint96 royaltyBps, uint256 price) = registry.recordMint(editionId);
        require(msg.value == price, "GameLicense: wrong price");

        tokenId = ++nextTokenId;
        editionOf[tokenId] = editionId;
        _safeMint(msg.sender, tokenId);
        _setTokenRoyalty(tokenId, studioOwner, royaltyBps);
        emit LicenseMinted(tokenId, editionId, msg.sender);

        Address.sendValue(payable(studioOwner), msg.value);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
