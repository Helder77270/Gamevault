// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameRegistry} from "../src/GameRegistry.sol";
import {GameLicense} from "../src/GameLicense.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {FriendRegistry} from "../src/FriendRegistry.sol";

/// The cartridge-loan rules, end to end: mutual friendship >= 3 days,
/// bounded duration, one borrower, 24 h cooldown, resale kills the loan.
contract LendingTest is Test {
    GameRegistry registry;
    GameLicense license;
    Marketplace market;
    FriendRegistry friendsReg;

    address platform = makeAddr("platform");
    address studio = makeAddr("studio");
    address alice = makeAddr("alice"); // owner / lender
    address bob = makeAddr("bob"); // friend / borrower
    address carol = makeAddr("carol"); // stranger

    uint256 editionId;
    uint256 tokenId;

    function setUp() public {
        registry = new GameRegistry();
        friendsReg = new FriendRegistry();
        license = new GameLicense(registry, friendsReg);
        registry.setLicense(address(license));
        market = new Marketplace(license, platform);

        vm.startPrank(studio);
        uint256 studioId = registry.registerStudio("GameVault Dev");
        uint256 gameId = registry.createGame(studioId, "Runner");
        editionId = registry.createEdition(gameId, 100, 0.01 ether, 1000, "cid", bytes32(uint256(1)));
        vm.stopPrank();

        vm.deal(alice, 1 ether);
        vm.deal(carol, 1 ether);
        vm.prank(alice);
        tokenId = license.buy{value: 0.01 ether}(editionId);
    }

    function _befriend(address a, address b) internal {
        vm.prank(a);
        friendsReg.request(b);
        vm.prank(b);
        friendsReg.accept(a);
    }

    function _lendAfter3Days() internal {
        _befriend(alice, bob);
        vm.warp(block.timestamp + 3 days);
        vm.prank(alice);
        license.lend(tokenId, bob, uint64(block.timestamp + 7 days));
    }

    // ── Friendship gating ────────────────────────────────────────

    function test_RevertLendToStranger() public {
        vm.prank(alice);
        vm.expectRevert("GameLicense: not friends");
        license.lend(tokenId, carol, uint64(block.timestamp + 1 days));
    }

    function test_RevertLendBefore3Days() public {
        _befriend(alice, bob);
        vm.warp(block.timestamp + 3 days - 1);
        vm.prank(alice);
        vm.expectRevert("GameLicense: friends < 3 days");
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days));
    }

    function test_RevertLendAfterUnfriend() public {
        _befriend(alice, bob);
        vm.warp(block.timestamp + 3 days);
        vm.prank(bob);
        friendsReg.remove(alice);
        vm.prank(alice);
        vm.expectRevert("GameLicense: not friends");
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days));
    }

    // ── The loan itself ──────────────────────────────────────────

    function test_LendHappyPath() public {
        _lendAfter3Days();
        assertEq(license.userOf(tokenId), bob);
        assertEq(license.ownerOf(tokenId), alice); // ownership untouched
    }

    function test_RevertDoubleLend() public {
        _lendAfter3Days();
        _befriend(alice, carol);
        vm.warp(block.timestamp + 3 days); // carol friendship matured, loan still live
        vm.prank(alice);
        vm.expectRevert("GameLicense: loan active");
        license.lend(tokenId, carol, uint64(block.timestamp + 1 days));
    }

    function test_RevertLendTooLong() public {
        _befriend(alice, bob);
        vm.warp(block.timestamp + 3 days);
        vm.prank(alice);
        vm.expectRevert("GameLicense: bad duration");
        license.lend(tokenId, bob, uint64(block.timestamp + 14 days + 1));
    }

    function test_RevertLendByNonOwner() public {
        _befriend(bob, carol);
        vm.warp(block.timestamp + 3 days);
        vm.prank(bob);
        vm.expectRevert("GameLicense: not owner");
        license.lend(tokenId, carol, uint64(block.timestamp + 1 days));
    }

    function test_NaturalExpiry() public {
        _lendAfter3Days();
        vm.warp(block.timestamp + 7 days + 1);
        assertEq(license.userOf(tokenId), address(0));
    }

    // ── Cooldown ─────────────────────────────────────────────────

    function test_CooldownAfterEndLoan() public {
        _lendAfter3Days();
        vm.prank(alice);
        license.endLoan(tokenId);
        assertEq(license.userOf(tokenId), address(0));

        vm.prank(alice);
        vm.expectRevert("GameLicense: cooldown");
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days));

        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days));
        assertEq(license.userOf(tokenId), bob);
    }

    function test_CooldownAfterNaturalExpiry() public {
        _lendAfter3Days();
        vm.warp(block.timestamp + 7 days + 2 hours); // expired 2 h ago
        vm.prank(alice);
        vm.expectRevert("GameLicense: cooldown");
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days));

        vm.warp(block.timestamp + 22 hours); // 24 h past the expiry
        vm.prank(alice);
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days));
        assertEq(license.userOf(tokenId), bob);
    }

    function test_BorrowerCanReturnEarly() public {
        _lendAfter3Days();
        vm.prank(bob);
        license.endLoan(tokenId);
        assertEq(license.userOf(tokenId), address(0));
    }

    function test_RevertEndLoanByStranger() public {
        _lendAfter3Days();
        vm.prank(carol);
        vm.expectRevert("GameLicense: not a party");
        license.endLoan(tokenId);
    }

    // ── Resale kills the loan ────────────────────────────────────

    function test_TransferClearsLoan() public {
        _lendAfter3Days();
        vm.prank(alice);
        license.transferFrom(alice, carol, tokenId);
        assertEq(license.userOf(tokenId), address(0));
        assertEq(license.ownerOf(tokenId), carol);

        // and the new owner inherits the cooldown (no instant relend abuse)
        _befriend(carol, bob);
        vm.warp(block.timestamp + 3 days); // > cooldown anyway after 3 days
        vm.prank(carol);
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days));
        assertEq(license.userOf(tokenId), bob);
    }

    function test_MarketplaceSaleClearsLoan() public {
        _lendAfter3Days();
        vm.startPrank(alice);
        license.approve(address(market), tokenId);
        market.list(tokenId, 0.02 ether);
        vm.stopPrank();
        vm.prank(carol);
        market.buy{value: 0.02 ether}(tokenId);
        assertEq(license.userOf(tokenId), address(0));
        assertEq(license.ownerOf(tokenId), carol);
    }

    // ── ERC-4907 surface ─────────────────────────────────────────

    function test_Supports4907Interface() public view {
        assertTrue(license.supportsInterface(0xad092b5c));
    }

    // ── FriendRegistry edges ─────────────────────────────────────

    function test_FriendListEnumeration() public {
        _befriend(alice, bob);
        _befriend(alice, carol);
        assertEq(friendsReg.friendCount(alice), 2);
        vm.prank(alice);
        friendsReg.remove(bob);
        assertEq(friendsReg.friendCount(alice), 1);
        assertEq(friendsReg.friendsOf(alice)[0], carol);
        assertEq(friendsReg.friendCount(bob), 0);
    }

    function test_RevertAcceptWithoutRequest() public {
        vm.prank(bob);
        vm.expectRevert("FriendRegistry: no request");
        friendsReg.accept(alice);
    }
}
