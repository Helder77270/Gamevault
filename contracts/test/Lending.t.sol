// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameRegistry} from "../src/GameRegistry.sol";
import {GameLicense} from "../src/GameLicense.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// The cartridge-loan rules with OFF-CHAIN friendship: the platform attests
/// "owner and borrower friends since T"; the contract enforces age, bounded
/// duration, one borrower, cooldown, and resale-kills-loan.
contract LendingTest is Test {
    GameRegistry registry;
    GameLicense license;
    Marketplace market;

    uint256 platformPk = 0xA11CE;
    address platform;
    address admin = makeAddr("admin");
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
        license = new GameLicense(registry, admin, platform, makeAddr("platformFees"), 3 days, 14 days, 1 days);
        registry.setLicense(address(license));
        market = new Marketplace(license, platform);

        vm.startPrank(studio);
        uint256 studioId = registry.registerStudio("GameVault Dev");
        uint256 gameId = registry.createGame(studioId, "Runner");
        editionId = registry.createEdition(gameId, 100, 0.01 ether, 1000, true, "cid", bytes32(uint256(1)));
        vm.stopPrank();

        vm.deal(alice, 1 ether);
        vm.deal(carol, 1 ether);
        vm.prank(alice);
        tokenId = license.buy{value: 0.01 ether}(editionId);
    }

    /// Platform attestation for (owner, to) friends since `since`.
    function _attest(address owner_, address to, uint64 since) internal view returns (uint64 deadline, bytes memory sig) {
        deadline = uint64(block.timestamp + 10 minutes);
        bytes32 digest = license.attestationDigest(owner_, to, tokenId, since, deadline);
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

    /// A copy the studio made non-resellable can still be lent: a loan is
    /// not a transfer.
    function test_LockedCopyCanStillBeLent() public {
        vm.prank(studio);
        uint256 locked = registry.createEdition(1, 100, 0.01 ether, 0, false, "cid", bytes32(uint256(3)));
        vm.prank(alice);
        tokenId = license.buy{value: 0.01 ether}(locked);
        assertFalse(license.isResellable(tokenId));

        _lend(alice, bob, _maturedSince(), uint64(block.timestamp + 7 days));
        assertEq(license.userOf(tokenId), bob);
        assertEq(license.ownerOf(tokenId), alice);
    }

    // ── Attestation gating ───────────────────────────────────────

    function test_RevertLendWithoutValidSig() public {
        uint64 since = _maturedSince();
        uint64 deadline = uint64(block.timestamp + 10 minutes);
        bytes32 digest = license.attestationDigest(alice, bob, tokenId, since, deadline);
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

    function test_DoesNotClaim4907Interface() public view {
        // views follow ERC-4907 but setUser does not exist — no false claim
        assertFalse(license.supportsInterface(0xad092b5c));
        assertTrue(license.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(license.supportsInterface(0x2a55205a)); // ERC-2981
    }

    // ── Key separation & rotation (audit K1) ─────────────────────

    function test_AdminRotatesAttestationSigner() public {
        uint256 newPk = 0xB0B5;
        vm.prank(admin);
        license.setAttestationSigner(vm.addr(newPk));
        assertEq(license.attestationSigner(), vm.addr(newPk));

        // the OLD key's attestations are dead immediately
        uint64 since = _maturedSince();
        (uint64 deadline, bytes memory oldSig) = _attest(alice, bob, since);
        vm.prank(alice);
        vm.expectRevert("GameLicense: bad attestation");
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days), since, deadline, oldSig);

        // the NEW key works
        bytes32 digest = license.attestationDigest(alice, bob, tokenId, since, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newPk, digest);
        vm.prank(alice);
        license.lend(tokenId, bob, uint64(block.timestamp + 1 days), since, deadline, abi.encodePacked(r, s, v));
        assertEq(license.userOf(tokenId), bob);
    }

    function test_RevertRotationByNonOwner() public {
        vm.prank(platform); // the signer itself has no admin power
        vm.expectRevert();
        license.setAttestationSigner(carol);
    }

    function test_RevertZeroSigner() public {
        vm.prank(admin);
        vm.expectRevert("GameLicense: zero signer");
        license.setAttestationSigner(address(0));
    }

    function test_RevertAttestationForAnotherToken() public {
        // alice owns a second licence; an attestation for token #1 can't lend #2
        vm.prank(alice);
        uint256 second = license.buy{value: 0.01 ether}(editionId);
        uint64 since = _maturedSince();
        (uint64 deadline, bytes memory sig) = _attest(alice, bob, since); // bound to tokenId (#1)
        vm.prank(alice);
        vm.expectRevert("GameLicense: bad attestation");
        license.lend(second, bob, uint64(block.timestamp + 1 days), since, deadline, sig);
    }

    // ── Marketplace: resurrected listing (audit K3) ──────────────

    function test_RevertResurrectedListing() public {
        vm.startPrank(alice);
        license.setApprovalForAll(address(market), true);
        market.list(tokenId, 0.02 ether);
        license.transferFrom(alice, bob, tokenId); // leaves…
        vm.stopPrank();
        vm.prank(bob);
        license.transferFrom(bob, alice, tokenId); // …and comes back
        vm.prank(carol);
        vm.expectRevert("Marketplace: stale listing");
        market.buy{value: 0.02 ether}(tokenId); // old price must not be honoured
    }
}
