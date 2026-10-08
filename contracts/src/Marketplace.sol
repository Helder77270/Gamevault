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
///
///         PAYMENTS (audit K4): push with a pull fallback. Each share is sent
///         directly with a bounded gas stipend — wallets (EOA, Safe) are paid
///         in the same transaction as before. If a receiver reverts or burns
///         the stipend, its share is CREDITED instead and claimed later with
///         withdraw(): no receiver can block a sale. Before this, a studio
///         whose royalty address refused ETH froze the resale of every copy
///         of its games, held by other people.
contract Marketplace is ReentrancyGuard, IGameVaultEvents {
    uint256 public constant PLATFORM_FEE_BPS = 500; // 5%
    /// Enough for an EOA or a Safe proxy's receive(), too little for a
    /// receiver to do anything expensive inside our buy().
    uint256 public constant PAYMENT_GAS_STIPEND = 30_000;

    GameLicense public immutable license;
    address public immutable platform;

    /// Shares that could not be pushed — claimable with withdraw().
    mapping(address payee => uint256) public pendingWithdrawals;

    struct Listing {
        address seller;
        uint256 price;
        /// license.transferCount at listing time — if the token left and
        /// came back, the old listing (old price) is dead (audit K3).
        uint256 transferNonce;
    }

    mapping(uint256 tokenId => Listing) public listings;

    constructor(GameLicense licenseContract, address platformAddress) {
        license = licenseContract;
        platform = platformAddress;
    }

    function list(uint256 tokenId, uint256 price) external {
        require(license.ownerOf(tokenId) == msg.sender, "Marketplace: not owner");
        require(price > 0, "Marketplace: zero price");
        require(license.isResellable(tokenId), "Marketplace: resale disabled by the studio");
        require(
            license.getApproved(tokenId) == address(this) || license.isApprovedForAll(msg.sender, address(this)),
            "Marketplace: not approved"
        );
        listings[tokenId] = Listing(msg.sender, price, license.transferCount(tokenId));
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
        require(license.transferCount(tokenId) == l.transferNonce, "Marketplace: stale listing");
        delete listings[tokenId];

        (address royaltyReceiver, uint256 royaltyAmount) = license.royaltyInfo(tokenId, l.price);
        uint256 platformFee = (l.price * PLATFORM_FEE_BPS) / 10_000;
        require(royaltyAmount + platformFee <= l.price, "Marketplace: splits exceed price");

        license.transferFrom(l.seller, msg.sender, tokenId);

        _pay(royaltyReceiver, royaltyAmount);
        _pay(platform, platformFee);
        _pay(l.seller, l.price - royaltyAmount - platformFee);

        emit Sale(tokenId, l.seller, msg.sender, l.price, royaltyAmount, platformFee);
    }

    /// @notice Claim the shares that could not be pushed during a sale.
    ///         Full gas here: it is the payee's own transaction.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Marketplace: nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        Address.sendValue(payable(msg.sender), amount);
    }

    /// Push `amount` to `to` with a bounded stipend; credit it on failure.
    /// Only called from buy() (nonReentrant), after all state changes.
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount, gas: PAYMENT_GAS_STIPEND}("");
        if (!ok) {
            pendingWithdrawals[to] += amount;
            emit PaymentCredited(to, amount);
        }
    }
}
