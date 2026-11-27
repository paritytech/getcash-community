// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {Registry} from "../src/Registry.sol";
import {Fixture} from "./Fixture.sol";

contract RegistryTest is Fixture {
    function test_constructorSetsTheKeysAndEmits() public {
        vm.recordLogs();
        Registry r = new Registry(admin, relayer, guardian);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 3);
        assertEq(logs[1].topics[0], Registry.RelayerChanged.selector);
        assertEq(abi.decode(logs[1].data, (address)), relayer);
        assertEq(r.admin(), admin);
        assertEq(r.relayer(), relayer);
        assertEq(r.guardian(), guardian);
        assertFalse(r.paused());
    }

    function test_zeroAddressesAreRefused() public {
        vm.expectRevert(Registry.ZeroAddress.selector);
        new Registry(address(0), relayer, guardian);
        vm.expectRevert(Registry.ZeroAddress.selector);
        new Registry(admin, address(0), guardian);
        vm.expectRevert(Registry.ZeroAddress.selector);
        new Registry(admin, relayer, address(0));

        vm.startPrank(admin);
        vm.expectRevert(Registry.ZeroAddress.selector);
        registry.setRelayer(address(0));
        vm.expectRevert(Registry.ZeroAddress.selector);
        registry.setAdmin(address(0));
        vm.expectRevert(Registry.ZeroAddress.selector);
        registry.setGuardian(address(0));
        vm.stopPrank();
    }

    function test_onlyAdminSetsKeys() public {
        address[4] memory callers = [stranger, relayer, guardian, owner];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(Registry.OnlyAdmin.selector);
            registry.setRelayer(stranger);
            vm.expectRevert(Registry.OnlyAdmin.selector);
            registry.setGuardian(stranger);
            vm.expectRevert(Registry.OnlyAdmin.selector);
            registry.setAdmin(stranger);
            vm.stopPrank();
        }
    }

    function test_adminSetsTheTriggerKeyAndEmits() public {
        address next = makeAddr("next");
        vm.expectEmit(address(registry));
        emit Registry.RelayerChanged(next);
        vm.prank(admin);
        registry.setRelayer(next);
        assertEq(registry.relayer(), next);
    }

    function test_onlyGuardianPauses() public {
        address[4] memory callers = [stranger, relayer, admin, owner];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Registry.OnlyGuardian.selector);
            registry.setPaused(true);
        }

        vm.expectEmit(address(registry));
        emit Registry.Paused(true);
        vm.prank(guardian);
        registry.setPaused(true);
        assertTrue(registry.paused());

        vm.prank(guardian);
        registry.setPaused(false);
        assertFalse(registry.paused());
    }

    function test_rotatedGuardianTakesOverThePause() public {
        address next = makeAddr("next guardian");
        vm.prank(admin);
        registry.setGuardian(next);

        vm.prank(guardian);
        vm.expectRevert(Registry.OnlyGuardian.selector);
        registry.setPaused(true);
        vm.prank(next);
        registry.setPaused(true);
        assertTrue(registry.paused());
    }
}
