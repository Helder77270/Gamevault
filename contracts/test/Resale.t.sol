// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameRegistry} from "../src/GameRegistry.sol";
import {GameLicense} from "../src/GameLicense.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// Resale and royalties are the studio's choice, per edition, fixed at
/// creation: a studio can sell copies that never change hands, or allow
/// resale with any royalty from 0 to 20 %.
contract ResaleTest is Test {
    GameRegistry registry;
    GameLicense license;
    Marketplace market;

    address platform = makeAddr("platform");
    address studio = makeAddr("studio");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 gameId;

    function setUp() public {
        registry = new GameRegistry();
        license = new GameLicense(registry, platform, makeAddr("attestSigner"), platform, 3 days, 14 days, 1 days);
        registry.setLicense(address(license));
        market = new Marketplace(license, platform);

        vm.startPrank(studio);
        uint256 studioId = registry.registerStudio("GameVault Dev");
        gameId = registry.createGame(studioId, "GameVault Runner");
        vm.stopPrank();

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function _edition(uint96 royaltyBps, bool resellable) internal returns (uint256) {
        vm.prank(studio);
        return registry.createEdition(gameId, 100, 0.01 ether, royaltyBps, resellable, "cid", bytes32(uint256(7)));
    }

    function _aliceBuys(uint256 editionId) internal returns (uint256 tokenId) {
        vm.prank(alice);
        tokenId = license.buy{value: 0.01 ether}(editionId);
    }

    // ── Resale off ───────────────────────────────────────────────

    function test_LockedEditionSellsNormally() public {
        uint256 tokenId = _aliceBuys(_edition(0, false));
        assertEq(license.ownerOf(tokenId), alice);
        assertFalse(license.isResellable(tokenId));
        assertEq(studio.balance, 0.0092 ether); // the primary sale is unchanged
    }

    function test_RevertTransferOfLockedCopy() public {
        uint256 tokenId = _aliceBuys(_edition(0, false));
        vm.prank(alice);
        vm.expectRevert("GameLicense: resale disabled by the studio");
        license.transferFrom(alice, bob, tokenId);

        vm.prank(alice);
        vm.expectRevert("GameLicense: resale disabled by the studio");
        license.safeTransferFrom(alice, bob, tokenId);
    }

    function test_RevertListingLockedCopy() public {
        uint256 tokenId = _aliceBuys(_edition(0, false));
        vm.startPrank(alice);
        license.approve(address(market), tokenId);
        vm.expectRevert("Marketplace: resale disabled by the studio");
        market.list(tokenId, 1 ether);
        vm.stopPrank();
    }

    function test_RevertRoyaltyWithoutResale() public {
        vm.prank(studio);
        vm.expectRevert("GameRegistry: royalty needs resale");
        registry.createEdition(gameId, 100, 0.01 ether, 1000, false, "cid", bytes32(uint256(7)));
    }

    // ── Resale on, royalty optional ──────────────────────────────

    function test_ResaleWithoutRoyalty() public {
        uint256 tokenId = _aliceBuys(_edition(0, true));
        vm.startPrank(alice);
        license.approve(address(market), tokenId);
        market.list(tokenId, 1 ether);
        vm.stopPrank();

        uint256 aliceBefore = alice.balance;
        uint256 studioBefore = studio.balance;
        uint256 platformBefore = platform.balance;
        vm.prank(bob);
        market.buy{value: 1 ether}(tokenId);

        assertEq(license.ownerOf(tokenId), bob);
        assertEq(studio.balance - studioBefore, 0); // the studio chose no royalty
        assertEq(platform.balance - platformBefore, 0.05 ether);
        assertEq(alice.balance - aliceBefore, 0.95 ether);
    }

    function test_EditionRecordsTheChoice() public {
        uint256 open = _edition(1000, true);
        uint256 locked = _edition(0, false);
        assertTrue(registry.isResellable(open));
        assertFalse(registry.isResellable(locked));
    }
}
