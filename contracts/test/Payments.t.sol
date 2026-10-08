// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameRegistry} from "../src/GameRegistry.sol";
import {GameLicense} from "../src/GameLicense.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {IGameVaultEvents} from "../src/interfaces/IGameVaultEvents.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

/// Studio whose wallet is a contract that can refuse ETH (audit K4: before
/// pull payments, it froze the resale of every copy of its games).
contract SwitchableStudio {
    bool public accepting = true;

    function setup(GameRegistry registry, uint256 price, uint96 royaltyBps) external returns (uint256 editionId) {
        uint256 studioId = registry.registerStudio("Hostile Studio");
        uint256 gameId = registry.createGame(studioId, "Hostile Game");
        editionId = registry.createEdition(gameId, 100, price, royaltyBps, "QmHostile", bytes32(uint256(1)));
    }

    function setAccepting(bool on) external {
        accepting = on;
    }

    function claim(Marketplace market) external {
        market.withdraw();
    }

    receive() external payable {
        require(accepting, "studio: no ETH");
    }
}

/// Seller contract whose receive() burns all the gas it is given.
contract GasBurnerSeller is ERC721Holder {
    function buyAndList(GameLicense license, Marketplace market, uint256 editionId, uint256 price)
        external
        payable
        returns (uint256 tokenId)
    {
        tokenId = license.buy{value: msg.value}(editionId);
        license.approve(address(market), tokenId);
        market.list(tokenId, price);
    }

    function claim(Marketplace market) external {
        market.withdraw();
    }

    receive() external payable {
        if (gasleft() > 100_000) return; // full-gas withdraw(): accept
        while (true) {} // stipend: burn everything
    }
}

/// Seller contract that tries to re-enter the Marketplace from receive().
contract ReentrantSeller is ERC721Holder {
    Marketplace public market;
    uint256 public reenterTokenId;

    function buyAndList(GameLicense license, Marketplace m, uint256 editionId, uint256 price)
        external
        payable
        returns (uint256 tokenId)
    {
        market = m;
        tokenId = license.buy{value: msg.value}(editionId);
        license.approve(address(m), tokenId);
        m.list(tokenId, price);
        reenterTokenId = tokenId;
    }

    receive() external payable {
        if (address(market) != address(0) && msg.sender == address(market) && reenterTokenId != 0) {
            uint256 id = reenterTokenId;
            reenterTokenId = 0;
            market.buy{value: msg.value}(id); // must not succeed
        }
    }
}

contract PaymentsTest is Test, IGameVaultEvents {
    GameRegistry registry;
    GameLicense license;
    Marketplace market;

    address platform = makeAddr("platform");
    address studio = makeAddr("studio");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 editionId;

    function setUp() public {
        registry = new GameRegistry();
        license = new GameLicense(registry, platform, makeAddr("attestSigner"), 3 days, 14 days, 1 days);
        registry.setLicense(address(license));
        market = new Marketplace(license, platform);

        vm.startPrank(studio);
        uint256 studioId = registry.registerStudio("GameVault Dev");
        uint256 gameId = registry.createGame(studioId, "GameVault Runner");
        editionId = registry.createEdition(gameId, 100, 0.01 ether, 1000, "QmRunner", bytes32(uint256(2)));
        vm.stopPrank();

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _aliceLists(uint256 edition, uint256 price) internal returns (uint256 tokenId) {
        (,, uint256 primary,,,,) = registry.editions(edition);
        vm.startPrank(alice);
        tokenId = license.buy{value: primary}(edition);
        license.approve(address(market), tokenId);
        market.list(tokenId, price);
        vm.stopPrank();
    }

    // ── K4: a receiver that refuses ETH no longer blocks the sale ──

    function test_RefusingStudioDoesNotBlockResale() public {
        SwitchableStudio hostile = new SwitchableStudio();
        uint256 hostileEdition = hostile.setup(registry, 0.01 ether, 1000);
        uint256 tokenId = _aliceLists(hostileEdition, 1 ether); // primary paid while accepting

        hostile.setAccepting(false);
        uint256 aliceBefore = alice.balance;

        vm.expectEmit(true, false, false, true, address(market));
        emit PaymentCredited(address(hostile), 0.1 ether);
        vm.prank(bob);
        market.buy{value: 1 ether}(tokenId);

        // the sale went through, the honest parties were paid directly
        assertEq(license.ownerOf(tokenId), bob);
        assertEq(alice.balance - aliceBefore, 0.85 ether);
        assertEq(platform.balance, 0.05 ether);
        // the studio's 10% waits in the Marketplace
        assertEq(market.pendingWithdrawals(address(hostile)), 0.1 ether);
        assertEq(address(market).balance, 0.1 ether);

        // once it accepts ETH again, it claims its royalties
        hostile.setAccepting(true);
        uint256 studioBefore = address(hostile).balance;
        hostile.claim(market);
        assertEq(address(hostile).balance - studioBefore, 0.1 ether);
        assertEq(market.pendingWithdrawals(address(hostile)), 0);
        assertEq(address(market).balance, 0);
    }

    function test_GasBurningSellerIsCreditedNotBlocking() public {
        GasBurnerSeller seller = new GasBurnerSeller();
        uint256 tokenId = seller.buyAndList{value: 0.01 ether}(license, market, editionId, 2 ether);

        uint256 studioBefore = studio.balance;
        vm.prank(bob);
        market.buy{value: 2 ether}(tokenId);

        assertEq(license.ownerOf(tokenId), bob);
        assertEq(studio.balance - studioBefore, 0.2 ether);
        assertEq(platform.balance, 0.1 ether);
        assertEq(market.pendingWithdrawals(address(seller)), 1.7 ether);

        seller.claim(market);
        assertEq(address(seller).balance, 1.7 ether);
        assertEq(address(market).balance, 0);
    }

    function test_ReentrancyFromReceiverIsCredited() public {
        ReentrantSeller seller = new ReentrantSeller();
        uint256 tokenId = seller.buyAndList{value: 0.01 ether}(license, market, editionId, 1 ether);

        vm.prank(bob);
        market.buy{value: 1 ether}(tokenId);

        // the re-entrant buy reverted inside the stipend call → share credited
        assertEq(license.ownerOf(tokenId), bob);
        assertEq(market.pendingWithdrawals(address(seller)), 0.85 ether);
    }

    // ── EOAs keep the direct payment (demo moment unchanged) ──────

    function test_EOAsArePaidDirectlyNothingCredited() public {
        uint256 tokenId = _aliceLists(editionId, 1 ether);
        vm.prank(bob);
        market.buy{value: 1 ether}(tokenId);
        assertEq(market.pendingWithdrawals(alice), 0);
        assertEq(market.pendingWithdrawals(studio), 0);
        assertEq(market.pendingWithdrawals(platform), 0);
        assertEq(address(market).balance, 0);
    }

    function test_RevertWithdrawNothing() public {
        vm.prank(alice);
        vm.expectRevert("Marketplace: nothing to withdraw");
        market.withdraw();
    }

    function test_WithdrawCannotBeReplayed() public {
        SwitchableStudio hostile = new SwitchableStudio();
        uint256 hostileEdition = hostile.setup(registry, 0.01 ether, 1000);
        uint256 tokenId = _aliceLists(hostileEdition, 1 ether);
        hostile.setAccepting(false);
        vm.prank(bob);
        market.buy{value: 1 ether}(tokenId);
        hostile.setAccepting(true);
        hostile.claim(market);
        vm.expectRevert("Marketplace: nothing to withdraw");
        hostile.claim(market);
    }

    // ── Conservation: every wei of the price lands somewhere (K9) ──

    function testFuzz_SplitConservesValue(uint96 priceSeed, uint16 royaltySeed, bool studioRefuses) public {
        uint256 price = bound(uint256(priceSeed), 1, 50 ether);
        uint96 royaltyBps = uint96(bound(uint256(royaltySeed), 0, 2000)); // registry cap 20%

        SwitchableStudio s = new SwitchableStudio();
        uint256 ed = s.setup(registry, 0.01 ether, royaltyBps);
        uint256 tokenId = _aliceLists(ed, price);
        if (studioRefuses) s.setAccepting(false);

        uint256 aliceBefore = alice.balance;
        uint256 studioBefore = address(s).balance;
        uint256 platformBefore = platform.balance;

        vm.prank(bob);
        market.buy{value: price}(tokenId);

        uint256 royalty = (price * royaltyBps) / 10_000;
        uint256 fee = (price * 500) / 10_000;
        uint256 studioGot = address(s).balance - studioBefore + market.pendingWithdrawals(address(s));

        assertEq(studioGot, royalty, "studio share");
        assertEq(platform.balance - platformBefore, fee, "platform share");
        assertEq(alice.balance - aliceBefore, price - royalty - fee, "seller share");
        assertEq(address(market).balance, market.pendingWithdrawals(address(s)), "market holds only credits");
    }
}
