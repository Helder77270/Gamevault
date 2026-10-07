// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameRegistry} from "../src/GameRegistry.sol";
import {GameLicense} from "../src/GameLicense.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {FriendRegistry} from "../src/FriendRegistry.sol";

contract GameVaultTest is Test {
    GameRegistry registry;
    GameLicense license;
    Marketplace market;
    FriendRegistry friendsReg;

    address platform = makeAddr("platform");
    address studio = makeAddr("studio");
    address alice = makeAddr("alice"); // first buyer / seller
    address bob = makeAddr("bob"); // second buyer

    uint256 editionId;

    string constant CID = "QmT1xbCCRG3sc3Gju8AGrdXvfnUMuXftmBLjF1uw5vEF1U";
    bytes32 constant HASH = 0x701338ec186baa41df25c5be7983e009602a012d4ff7952fbe8bc910bff3e7cb;

    function setUp() public {
        registry = new GameRegistry();
        friendsReg = new FriendRegistry();
        license = new GameLicense(registry, friendsReg);
        registry.setLicense(address(license));
        market = new Marketplace(license, platform);

        vm.startPrank(studio);
        uint256 studioId = registry.registerStudio("GameVault Dev");
        uint256 gameId = registry.createGame(studioId, "GameVault Runner");
        editionId = registry.createEdition(gameId, 100, 0.01 ether, 1000, CID, HASH); // 10% royalty
        vm.stopPrank();

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    // ── Primary sale ─────────────────────────────────────────────

    function test_PrimaryBuy() public {
        vm.prank(alice);
        uint256 tokenId = license.buy{value: 0.01 ether}(editionId);

        assertEq(license.ownerOf(tokenId), alice);
        assertEq(license.editionOf(tokenId), editionId);
        assertEq(studio.balance, 0.01 ether); // 100% primary to studio
        (,,,,,, uint256 minted) = registry.editions(editionId);
        assertEq(minted, 1);

        (address receiver, uint256 amount) = license.royaltyInfo(tokenId, 1 ether);
        assertEq(receiver, studio);
        assertEq(amount, 0.1 ether); // 10%
    }

    function test_RevertPrimaryWrongPrice() public {
        vm.prank(alice);
        vm.expectRevert("GameLicense: wrong price");
        license.buy{value: 0.02 ether}(editionId);
    }

    function test_RevertSoldOut() public {
        vm.prank(studio);
        uint256 tiny = registry.createEdition(1, 1, 0.01 ether, 1000, CID, HASH);
        vm.prank(alice);
        license.buy{value: 0.01 ether}(tiny);
        vm.prank(bob);
        vm.expectRevert("GameRegistry: sold out");
        license.buy{value: 0.01 ether}(tiny);
    }

    function test_RevertRoyaltyTooHigh() public {
        vm.prank(studio);
        vm.expectRevert("GameRegistry: royalty too high");
        registry.createEdition(1, 10, 0.01 ether, 2001, CID, HASH);
    }

    // ── Resale: the demo flow ────────────────────────────────────

    function test_ResaleSplitsAndRevocation() public {
        vm.prank(alice);
        uint256 tokenId = license.buy{value: 0.01 ether}(editionId);

        vm.startPrank(alice);
        license.approve(address(market), tokenId);
        market.list(tokenId, 1 ether);
        vm.stopPrank();

        uint256 aliceBefore = alice.balance;
        uint256 studioBefore = studio.balance;

        vm.prank(bob);
        market.buy{value: 1 ether}(tokenId);

        // THE revocation: ownerOf changed — seller's launcher dies on next check
        assertEq(license.ownerOf(tokenId), bob);
        // 85% seller / 10% studio (via royaltyInfo) / 5% platform
        assertEq(alice.balance - aliceBefore, 0.85 ether);
        assertEq(studio.balance - studioBefore, 0.10 ether);
        assertEq(platform.balance, 0.05 ether);
        // listing consumed
        (address seller,) = market.listings(tokenId);
        assertEq(seller, address(0));
    }

    function test_RevertBuyUnlisted() public {
        vm.prank(alice);
        uint256 tokenId = license.buy{value: 0.01 ether}(editionId);
        vm.prank(bob);
        vm.expectRevert("Marketplace: not listed");
        market.buy{value: 1 ether}(tokenId);
    }

    function test_RevertListWithoutApproval() public {
        vm.prank(alice);
        uint256 tokenId = license.buy{value: 0.01 ether}(editionId);
        vm.prank(alice);
        vm.expectRevert("Marketplace: not approved");
        market.list(tokenId, 1 ether);
    }

    function test_StaleListingAfterDirectTransfer() public {
        vm.prank(alice);
        uint256 tokenId = license.buy{value: 0.01 ether}(editionId);
        vm.startPrank(alice);
        license.approve(address(market), tokenId);
        market.list(tokenId, 1 ether);
        // alice transfers directly, bypassing the market — listing is stale
        license.transferFrom(alice, bob, tokenId);
        vm.stopPrank();

        vm.deal(makeAddr("carol"), 2 ether);
        vm.prank(makeAddr("carol"));
        vm.expectRevert("Marketplace: stale listing");
        market.buy{value: 1 ether}(tokenId);
    }

    function test_Unlist() public {
        vm.prank(alice);
        uint256 tokenId = license.buy{value: 0.01 ether}(editionId);
        vm.startPrank(alice);
        license.approve(address(market), tokenId);
        market.list(tokenId, 1 ether);
        market.unlist(tokenId);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert("Marketplace: not listed");
        market.buy{value: 1 ether}(tokenId);
    }

    // ── Registry guards ──────────────────────────────────────────

    function test_RevertRecordMintNotLicense() public {
        vm.prank(alice);
        vm.expectRevert("GameRegistry: only license");
        registry.recordMint(editionId);
    }

    function test_RevertCreateGameNotStudioOwner() public {
        vm.prank(alice);
        vm.expectRevert("GameRegistry: not studio owner");
        registry.createGame(1, "Pirate Game");
    }
}
