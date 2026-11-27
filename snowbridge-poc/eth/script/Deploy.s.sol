// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

import {ForwarderFactory} from "../src/ForwarderFactory.sol";
import {Registry} from "../src/Registry.sol";
import {Router} from "../src/Router.sol";
import {ISnowbridgeGatewayV2} from "../src/interfaces/IExternal.sol";

/// @notice Deploys the registry and the factory, whose constructor deploys the router.
/// @dev Env: GATEWAY, TOKEN, ADMIN, RELAYER, GUARDIAN (addresses) and XCM_HEAD, XCM_TAIL, CLAIMER_HEAD (0x-hex bytes).
///      The sender comes from the forge flags (`--private-key`, `--account`, `--ledger`), never from the env.
contract Deploy is Script {
    function run() external returns (Registry registry, ForwarderFactory factory, Router router) {
        address gateway = vm.envAddress("GATEWAY");
        address token = vm.envAddress("TOKEN");
        require(gateway.code.length > 0, "GATEWAY has no code");
        require(token.code.length > 0, "TOKEN has no code");

        vm.startBroadcast();
        registry = new Registry(vm.envAddress("ADMIN"), vm.envAddress("RELAYER"), vm.envAddress("GUARDIAN"));
        factory = new ForwarderFactory(
            registry,
            ISnowbridgeGatewayV2(gateway),
            token,
            vm.envBytes("XCM_HEAD"),
            vm.envBytes("XCM_TAIL"),
            vm.envBytes("CLAIMER_HEAD")
        );
        vm.stopBroadcast();
        router = factory.ROUTER();

        console.log("registry", address(registry));
        console.log("factory ", address(factory));
        console.log("router  ", address(router));
    }
}
