// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GameRegistry} from "../src/GameRegistry.sol";

/// Seeds the deployed registry with the dev-catalog content: the caller's
/// key becomes the studio owner (royalty receiver on resales).
///
///   PRIVATE_KEY=0x... forge script script/Seed.s.sol --rpc-url base_sepolia --broadcast
contract Seed is Script {
    GameRegistry constant REGISTRY = GameRegistry(0xa1401b1bbf85202F88E59F54701F541f41656665);

    // Matches shared/src/catalog.ts (pinned 2026-07-23)
    string constant BUILD_CID = "QmT1xbCCRG3sc3Gju8AGrdXvfnUMuXftmBLjF1uw5vEF1U";
    bytes32 constant BUILD_HASH = 0x701338ec186baa41df25c5be7983e009602a012d4ff7952fbe8bc910bff3e7cb;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        uint256 studioId = REGISTRY.registerStudio("GameVault Dev");
        uint256 gameId = REGISTRY.createGame(studioId, "GameVault Runner");
        uint256 editionId = REGISTRY.createEdition(
            gameId,
            100, // supply
            0.00001 ether, // price
            1000, // 10% royalty
            BUILD_CID,
            BUILD_HASH
        );

        vm.stopBroadcast();

        console.log("studioId :", studioId);
        console.log("gameId   :", gameId);
        console.log("editionId:", editionId);
    }
}
