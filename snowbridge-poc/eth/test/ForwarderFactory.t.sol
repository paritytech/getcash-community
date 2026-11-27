// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Forwarder} from "../src/Forwarder.sol";
import {ForwarderFactory} from "../src/ForwarderFactory.sol";
import {Router} from "../src/Router.sol";
import {Fixture} from "./Fixture.sol";

contract ForwarderFactoryTest is Fixture {
    function test_predictMatchesDeploy() public {
        address predicted = factory.predict(account, owner);
        assertEq(predicted.code.length, 0);

        vm.expectEmit(true, true, true, false, address(factory));
        emit ForwarderFactory.ForwarderDeployed(predicted, account, owner);
        address actual = factory.deploy(account, owner);

        assertEq(actual, predicted);
        assertGt(actual.code.length, 0);
    }

    function test_saltIsHashOfAccountAndOwner() public view {
        bytes32 salt = keccak256(abi.encode(account, owner));
        bytes memory init = bytes.concat(type(Forwarder).creationCode, abi.encode(account, owner));
        address expected = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, keccak256(init)))))
        );
        assertEq(factory.predict(account, owner), expected);
    }

    function test_deployIsOpenToAnyone() public {
        vm.prank(stranger);
        address first = factory.deploy(account, owner);

        assertEq(Forwarder(payable(first)).OWNER(), owner);
        assertTrue(factory.isForwarder(first));
    }

    function test_aSecondDeployReturnsTheExistingForwarderAndIsCheap() public {
        address first = factory.deploy(account, owner);

        vm.recordLogs();
        vm.prank(stranger);
        address second = factory.deploy{gas: 60_000}(account, owner);

        assertEq(second, first);
        assertTrue(factory.isForwarder(first));
        assertEq(vm.getRecordedLogs().length, 0, "nothing is deployed or announced again");
    }

    function test_accountAndOwnerBothChangeTheAddress() public view {
        address base = factory.predict(account, owner);
        assertTrue(factory.predict(keccak256("other account"), owner) != base);
        assertTrue(factory.predict(account, stranger) != base);
    }

    function test_differentFactoriesGiveDifferentAddresses() public {
        (ForwarderFactory other,) = newFactory();
        assertTrue(other.predict(account, owner) != factory.predict(account, owner));
    }

    function test_isForwarderOnlyForWhatTheFactoryDeployed() public {
        address predicted = factory.predict(account, owner);
        assertFalse(factory.isForwarder(predicted), "not deployed yet");

        Forwarder f = deployed();
        assertTrue(factory.isForwarder(address(f)));

        assertFalse(factory.isForwarder(address(0)));
        assertFalse(factory.isForwarder(stranger));
        assertFalse(factory.isForwarder(address(router)));
        assertFalse(factory.isForwarder(address(factory)));
        assertFalse(factory.isForwarder(address(registry)));
    }

    function test_aForwarderOfAnotherFactoryIsNotOurs() public {
        (ForwarderFactory other,) = newFactory();
        address foreign = other.deploy(account, owner);
        assertTrue(other.isForwarder(foreign));
        assertFalse(factory.isForwarder(foreign));
    }

    function test_depositBeforeDeploymentIsForwardedAfterIt() public {
        address predicted = factory.predict(account, owner);
        usdc.mint(predicted, DEPOSIT);

        Forwarder f = deployed();
        assertEq(address(f), predicted);
        triggerAs(relayer, f, address(usdc));

        assertEq(usdc.balanceOf(gateway.AGENT()), DEPOSIT);
        assertEq(lastCall().xcm, expectedXcm(address(f), 1, account, address(usdc), DEPOSIT));
    }

    function test_theFactoryBuiltItsOwnRouter() public view {
        assertGt(address(router).code.length, 0);
        assertEq(address(router.FACTORY()), address(factory));
        assertEq(address(factory.REGISTRY()), address(registry));
    }

    function testFuzz_predictMatchesDeploy(bytes32 account_, address owner_) public {
        address predicted = factory.predict(account_, owner_);
        assertEq(factory.deploy(account_, owner_), predicted);
        assertTrue(factory.isForwarder(predicted));
    }
}
