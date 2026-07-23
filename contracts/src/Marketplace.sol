// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IGameVaultEvents} from "./interfaces/IGameVaultEvents.sol";
import {GameLicense} from "./GameLicense.sol";

/// @title Marketplace — resale with automatic royalty split.
/// @notice The studio cut is READ from EIP-2981 royaltyInfo() (whatever the
///         edition set, capped at 20% by the registry); the platform adds a
///         flat 5%; the seller gets the rest. On a 10% edition:
///         85% seller / 10% studio / 5% platform.
contract Marketplace is ReentrancyGuard, IGameVaultEvents {
    uint256 public constant PLATFORM_FEE_BPS = 500; // 5%

    GameLicense public immutable license;
    address public immutable platform;

    struct Listing {
        address seller;
        uint256 price;
    }

    mapping(uint256 tokenId => Listing) public listings;

    constructor(GameLicense licenseContract, address platformAddress) {
        license = licenseContract;
        platform = platformAddress;
    }

    function list(uint256 tokenId, uint256 price) external {
        require(license.ownerOf(tokenId) == msg.sender, "Marketplace: not owner");
        require(price > 0, "Marketplace: zero price");
        require(
            license.getApproved(tokenId) == address(this) || license.isApprovedForAll(msg.sender, address(this)),
            "Marketplace: not approved"
        );
        listings[tokenId] = Listing(msg.sender, price);
        emit Listed(tokenId, msg.sender, price);
    }

    function unlist(uint256 tokenId) external {
        require(listings[tokenId].seller == msg.sender, "Marketplace: not seller");
        delete listings[tokenId];
        emit Unlisted(tokenId);
    }

    /// @notice The revocation moment: transferFrom changes ownerOf(), which
    ///         instantly invalidates the seller's launcher on its next
    ///         online check.
    function buy(uint256 tokenId) external payable nonReentrant {
        Listing memory l = listings[tokenId];
        require(l.seller != address(0), "Marketplace: not listed");
        require(msg.value == l.price, "Marketplace: wrong price");
        require(license.ownerOf(tokenId) == l.seller, "Marketplace: stale listing");
        delete listings[tokenId];

        (address royaltyReceiver, uint256 royaltyAmount) = license.royaltyInfo(tokenId, l.price);
        uint256 platformFee = (l.price * PLATFORM_FEE_BPS) / 10_000;
        require(royaltyAmount + platformFee <= l.price, "Marketplace: splits exceed price");

        license.transferFrom(l.seller, msg.sender, tokenId);

        if (royaltyAmount > 0) Address.sendValue(payable(royaltyReceiver), royaltyAmount);
        Address.sendValue(payable(platform), platformFee);
        Address.sendValue(payable(l.seller), l.price - royaltyAmount - platformFee);

        emit Sale(tokenId, l.seller, msg.sender, l.price, royaltyAmount, platformFee);
    }
}
