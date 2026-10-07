// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GameRegistry} from "../src/GameRegistry.sol";
import {GameLicense} from "../src/GameLicense.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// Deploy + wire the three contracts with SEPARATED keys (audit K1):
///   PRIVATE_KEY        pays gas only — keeps NO role after deployment
///   ADMIN_ADDRESS      owner of GameLicense (rotates the attestation
///                      signer) + Marketplace platform-fee receiver
///   ATTEST_SIGNER      address of ticketd's attestation key
/// The ticket-signing key never touches the chain (its pubkey is embedded
/// in the launcher).
///
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
///   (env from contracts/.env, gitignored)
///
/// Then paste the printed addresses into shared/src/deployments.ts.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address attestSigner = vm.envAddress("ATTEST_SIGNER");
        require(admin != vm.addr(pk) && attestSigner != vm.addr(pk), "Deploy: gas key must hold no role");

        vm.startBroadcast(pk);

        GameRegistry registry = new GameRegistry();
        // Prod guard values — for a DEMO deploy (lending shown live), shrink
        // them: e.g. (10 minutes, 1 days, 10 minutes).
        GameLicense license = new GameLicense(registry, admin, attestSigner, 3 days, 14 days, 1 days);
        registry.setLicense(address(license));
        Marketplace market = new Marketplace(license, admin);

        vm.stopBroadcast();

        console.log("GameRegistry  :", address(registry));
        console.log("GameLicense   :", address(license));
        console.log("Marketplace   :", address(market));
        console.log("admin / fees  :", admin);
        console.log("attest signer :", attestSigner);
    }
}
