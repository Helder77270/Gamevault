// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GameLicense} from "../src/GameLicense.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// Redeploy ONLY the Marketplace against the live GameLicense — nothing
/// references the Marketplace on-chain, so licences, editions and paired
/// cartridges are untouched (used for the K4 pull-payments upgrade).
///
///   GAME_LICENSE=0x… forge script script/DeployMarketplace.s.sol --rpc-url base_sepolia --broadcast
///   (PRIVATE_KEY = gas only, ADMIN_ADDRESS = fee receiver; contracts/.env)
///
/// Before switching shared/src/deployments.ts: the old Marketplace must hold
/// no live listing and no balance (push payments never kept any).
contract DeployMarketplace is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        GameLicense license = GameLicense(vm.envAddress("GAME_LICENSE"));
        require(admin != vm.addr(pk), "Deploy: gas key must hold no role");
        require(address(license).code.length > 0, "Deploy: GAME_LICENSE has no code");

        vm.startBroadcast(pk);
        Marketplace market = new Marketplace(license, admin);
        vm.stopBroadcast();

        console.log("Marketplace   :", address(market));
        console.log("license       :", address(license));
        console.log("admin / fees  :", admin);
    }
}
