// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GameRegistry} from "../src/GameRegistry.sol";
import {GameLicense} from "../src/GameLicense.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {FriendRegistry} from "../src/FriendRegistry.sol";

/// Deploy + wire the three contracts. The deployer address doubles as the
/// platform fee receiver (fine for the throwaway key).
///
///   $env:PRIVATE_KEY = "0x..."   # throwaway, funded with Base Sepolia ETH
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
///
/// Then paste the printed addresses into:
///   - shared/src/deployments.ts  (arms ticketd ownerOf + launcher revocation)
///   - subgraph/subgraph.yaml     (addresses + startBlock, then deploy)
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        GameRegistry registry = new GameRegistry();
        FriendRegistry friendsReg = new FriendRegistry();
        GameLicense license = new GameLicense(registry, friendsReg);
        registry.setLicense(address(license));
        Marketplace market = new Marketplace(license, vm.addr(pk));

        vm.stopBroadcast();

        console.log("GameRegistry  :", address(registry));
        console.log("FriendRegistry:", address(friendsReg));
        console.log("GameLicense   :", address(license));
        console.log("Marketplace   :", address(market));
    }
}
