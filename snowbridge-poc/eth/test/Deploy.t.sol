// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {ForwarderFactory} from "../src/ForwarderFactory.sol";
import {Registry} from "../src/Registry.sol";
import {Router} from "../src/Router.sol";
import {MockERC20, MockGateway} from "./mocks/Mocks.sol";

/// @dev One test: the script reads process-wide env vars, which parallel tests would race on.
contract DeployTest is Test {
    function test_scriptDeploysFromEnvAndRefusesAGatewayOrTokenWithoutCode() public {
        MockGateway gateway = new MockGateway();
        MockERC20 token = new MockERC20("USDC");
        address admin = makeAddr("admin");
        address relayer = makeAddr("relayer");
        address guardian = makeAddr("guardian");
        vm.setEnv("GATEWAY", vm.toString(address(gateway)));
        vm.setEnv("TOKEN", vm.toString(address(token)));
        vm.setEnv("ADMIN", vm.toString(admin));
        vm.setEnv("RELAYER", vm.toString(relayer));
        vm.setEnv("GUARDIAN", vm.toString(guardian));
        vm.setEnv("XCM_HEAD", "0x0510deadbeef");
        vm.setEnv("XCM_TAIL", "0xc0ffee");
        vm.setEnv("CLAIMER_HEAD", "0x00010100");
        Deploy script = new Deploy();

        (Registry registry, ForwarderFactory factory, Router router) = script.run();

        assertEq(registry.admin(), admin);
        assertEq(registry.relayer(), relayer);
        assertEq(registry.guardian(), guardian);
        assertEq(address(factory.REGISTRY()), address(registry));
        assertEq(address(factory.ROUTER()), address(router));
        assertEq(address(router.FACTORY()), address(factory));
        assertEq(address(router.GATEWAY()), address(gateway));
        assertEq(router.TOKEN(), address(token));
        assertEq(router.xcmHead(), hex"0510deadbeef");
        assertEq(router.xcmTail(), hex"c0ffee");
        assertEq(router.claimerHead(), hex"00010100");

        vm.setEnv("TOKEN", vm.toString(makeAddr("not a token")));
        vm.expectRevert("TOKEN has no code");
        script.run();

        vm.setEnv("TOKEN", vm.toString(address(token)));
        vm.setEnv("GATEWAY", vm.toString(makeAddr("not a contract")));
        vm.expectRevert("GATEWAY has no code");
        script.run();
    }
}
