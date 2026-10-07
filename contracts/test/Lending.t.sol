// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameRegistry} from "../src/GameRegistry.sol";
import {GameLicense} from "../src/GameLicense.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// The cartridge-loan rules with OFF-CHAIN friendship: the platform attests
/// "owner and borrower friends since T"; the contract enforces age, bounded
/// duration, one borrower, cooldown, and resale-kills-loan.
contract LendingTest is Test {
    GameRegistry registry;
    GameLicense license;
    Marketplace market;

    uint256 platformPk = 0xA11CE;
    address platform;
    address studio = makeAddr("studio");
    address alice = makeAddr("alice"); // owner / lender
    address bob = makeAddr("bob"); // friend / borrower
    address carol = makeAddr("carol"); // stranger / buyer

    uint256 editionId;
    uint256 tokenId;

    function setUp() public {
        vm.warp(1_750_000_000); // real-world-ish clock — "since 3 days ago" must not underflow
        platform = vm.addr(platformPk);
        registry = new GameRegistry();
        license = new GameLicense(registry, platform, 3 days, 14 days, 1 days);
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

    /// Platform attestation for (owner, to) friends since `since`.
    function _attest(address owner_, address to, uint64 since) internal view returns (uint64 deadline, bytes memory sig) {
        deadline = uint64(block.timestamp + 10 minutes);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(license.attestationDigest(owner_, to, since, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(platformPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _lend(address owner_, address to, uint64 since, uint64 expires) internal {
        (uint64 deadline, bytes memory sig) = _attest(owner_, to, since);
        vm.prank(owner_);
        license.lend(tokenId, to, expires, since, deadline, sig);
    }

    /// Friendship born 3 days ago — eligible now.
    function _maturedSince() internal view returns (uint64) {
        return uint64(block.timestamp - 3 days);
    }

    // ── Attestation gating ───────────────────────────────────────

    function test_RevertLendWithoutValidSig() public {
        uint64 since = _maturedSince();
        uint64 deadline = uint64(block.timestamp + 10 minutes);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(license.attestationDigest(alice, bob, since, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest); // not the platform
        vm.prank(alice);
        vm.expectRevert("GameLicense: bad attestation");
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days), since, deadline, abi.encodePacked(r, s, v));
    }

    function test_RevertExpiredAttestation() public {
        uint64 since = _maturedSince();
        (uint64 deadline, bytes memory sig) = _attest(alice, bob, since);
        vm.warp(block.timestamp + 11 minutes);
        vm.prank(alice);
        vm.expectRevert("GameLicense: attestation expired");
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days), since, deadline, sig);
    }

    function test_RevertAttestationForAnotherPair() public {
        // attestation says (alice, bob) — carol cannot borrow with it
        uint64 since = _maturedSince();
        (uint64 deadline, bytes memory sig) = _attest(alice, bob, since);
        vm.prank(alice);
        vm.expectRevert("GameLicense: bad attestation");
        license.lend(tokenId, carol, uint64(block.timestamp + 1 days), since, deadline, sig);
    }

    function test_RevertTamperedSince() public {
        // signed for a young friendship, submitted with a matured one
        uint64 realSince = uint64(block.timestamp - 1 days);
        (uint64 deadline, bytes memory sig) = _attest(alice, bob, realSince);
        vm.prank(alice);
        vm.expectRevert("GameLicense: bad attestation");
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days), _maturedSince(), deadline, sig);
    }

    function test_RevertFriendshipTooYoung() public {
        uint64 since = uint64(block.timestamp - 3 days + 60); // 1 min short
        (uint64 deadline, bytes memory sig) = _attest(alice, bob, since);
        vm.prank(alice);
        vm.expectRevert("GameLicense: friendship too young");
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days), since, deadline, sig);
    }

    // ── The loan itself ──────────────────────────────────────────

    function test_LendHappyPath() public {
        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 7 days));
        assertEq(license.userOf(tokenId), bob);
        assertEq(license.ownerOf(tokenId), alice); // ownership untouched
    }

    function test_RevertDoubleLend() public {
        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 7 days));
        (uint64 deadline, bytes memory sig) = _attest(alice, carol, _maturedSince());
        vm.prank(alice);
        vm.expectRevert("GameLicense: loan active");
        license.lend(tokenId, carol, uint64(block.timestamp + 1 days), _maturedSince(), deadline, sig);
    }

    function test_RevertLendTooLong() public {
        uint64 since = _maturedSince();
        (uint64 deadline, bytes memory sig) = _attest(alice, bob, since);
        vm.prank(alice);
        vm.expectRevert("GameLicense: bad duration");
        license.lend(tokenId, bob, uint64(block.timestamp + 14 days + 1), since, deadline, sig);
    }

    function test_RevertLendByNonOwner() public {
        uint64 since = _maturedSince();
        (uint64 deadline, bytes memory sig) = _attest(bob, carol, since);
        vm.prank(bob);
        vm.expectRevert("GameLicense: not owner");
        license.lend(tokenId, carol, uint64(block.timestamp + 1 days), since, deadline, sig);
    }

    function test_NaturalExpiry() public {
        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 7 days));
        vm.warp(block.timestamp + 7 days + 1);
        assertEq(license.userOf(tokenId), address(0));
    }

    // ── Cooldown ─────────────────────────────────────────────────

    function test_CooldownAfterEndLoan() public {
        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 7 days));
        vm.prank(alice);
        license.endLoan(tokenId);
        assertEq(license.userOf(tokenId), address(0));

        (uint64 deadline, bytes memory sig) = _attest(alice, bob, _maturedSince());
        vm.prank(alice);
        vm.expectRevert("GameLicense: cooldown");
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days), _maturedSince(), deadline, sig);

        vm.warp(block.timestamp + 1 days);
        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 1 days));
        assertEq(license.userOf(tokenId), bob);
    }

    function test_CooldownAfterNaturalExpiry() public {
        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 7 days));
        vm.warp(block.timestamp + 7 days + 2 hours); // expired 2 h ago
        (uint64 deadline, bytes memory sig) = _attest(alice, bob, _maturedSince());
        vm.prank(alice);
        vm.expectRevert("GameLicense: cooldown");
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days), _maturedSince(), deadline, sig);

        vm.warp(block.timestamp + 22 hours); // 24 h past the expiry
        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 1 days));
        assertEq(license.userOf(tokenId), bob);
    }

    function test_BorrowerCanReturnEarly() public {
        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 7 days));
        vm.prank(bob);
        license.endLoan(tokenId);
        assertEq(license.userOf(tokenId), address(0));
    }

    function test_RevertEndLoanByStranger() public {
        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 7 days));
        vm.prank(carol);
        vm.expectRevert("GameLicense: not a party");
        license.endLoan(tokenId);
    }

    // ── Resale kills the loan ────────────────────────────────────

    function test_TransferClearsLoan() public {
        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 7 days));
        vm.prank(alice);
        license.transferFrom(alice, carol, tokenId);
        assertEq(license.userOf(tokenId), address(0));
        assertEq(license.ownerOf(tokenId), carol);
    }

    function test_MarketplaceSaleClearsLoan() public {
        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 7 days));
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
}
