// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {Forwarder} from "../src/Forwarder.sol";
import {ForwarderFactory} from "../src/ForwarderFactory.sol";
import {Router} from "../src/Router.sol";
import {Fixture} from "./Fixture.sol";
import {FakeForwarder, GatewayCall, MockGateway} from "./mocks/Mocks.sol";

contract RouterTest is Fixture {
    function test_rejectsAnEoa() public {
        usdc.mint(stranger, DEPOSIT);
        vm.startPrank(stranger);
        usdc.approve(address(router), DEPOSIT);
        vm.expectRevert(Router.NotForwarder.selector);
        router.send(address(usdc), DEPOSIT, 0, 0);
        vm.stopPrank();

        assertEq(usdc.balanceOf(stranger), DEPOSIT);
        assertEq(router.sendsOf(stranger), 0);
    }

    function test_rejectsTheTriggerKeyAndTheOwnerCallingDirectly() public {
        usdc.mint(relayer, DEPOSIT);
        usdc.mint(owner, DEPOSIT);
        address[3] memory callers = [relayer, owner, admin];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Router.NotForwarder.selector);
            router.send(address(usdc), DEPOSIT, 0, 0);
        }
    }

    function test_rejectsAContractImitatingAForwardersInterface() public {
        Forwarder victim = deployed();
        usdc.mint(address(victim), DEPOSIT);
        vm.prank(address(victim));
        usdc.approve(address(router), DEPOSIT);

        FakeForwarder fake = new FakeForwarder(account);
        usdc.mint(address(fake), DEPOSIT);
        vm.prank(address(fake));
        usdc.approve(address(router), DEPOSIT);

        vm.expectRevert(Router.NotForwarder.selector);
        fake.attack{value: EXEC_FEE}(router, address(usdc), DEPOSIT);

        assertEq(usdc.balanceOf(address(victim)), DEPOSIT);
        assertEq(usdc.balanceOf(address(fake)), DEPOSIT);
        assertEq(gateway.callCount(), 0);
    }

    function test_rejectsAForwarderOfAnotherFactory() public {
        (ForwarderFactory otherFactory, Router otherRouter) = newFactory();
        Forwarder foreign = Forwarder(payable(otherFactory.deploy(account, owner)));
        usdc.mint(address(foreign), DEPOSIT);
        vm.prank(address(foreign));
        usdc.approve(address(router), DEPOSIT);

        vm.prank(address(foreign));
        vm.expectRevert(Router.NotForwarder.selector);
        router.send(address(usdc), DEPOSIT, 0, 0);

        vm.prank(relayer);
        foreign.trigger(address(usdc), 0, 0);
        assertEq(otherRouter.sendsOf(address(foreign)), 1);
        assertEq(router.sendsOf(address(foreign)), 0);
    }

    function test_rejectsAnAddressWhoseForwarderIsNotDeployedYet() public {
        address predicted = factory.predict(account, owner);
        vm.prank(predicted);
        vm.expectRevert(Router.NotForwarder.selector);
        router.send(address(usdc), DEPOSIT, 0, 0);
    }

    function test_depositIdIsAHashOfTheForwarderAndItsOwnCount() public {
        Forwarder a = deployed();
        Forwarder b = deployedFor(keccak256("second user"), stranger);
        assertEq(router.sendsOf(address(a)), 0);

        usdc.mint(address(a), 5e6);
        triggerAs(relayer, a, address(usdc));
        assertEq(router.sendsOf(address(a)), 1);
        assertEq(router.sendsOf(address(b)), 0);
        assertEq(router.deposits(depositIdOf(address(a), 1)), keccak256(abi.encode(account, address(usdc), 5e6)));

        usdc.mint(address(b), 6e6);
        triggerAs(relayer, b, address(usdc));
        assertEq(router.sendsOf(address(b)), 1);

        usdc.mint(address(a), 7e6);
        triggerAs(relayer, a, address(usdc));
        assertEq(router.sendsOf(address(a)), 2);
        assertEq(router.deposits(depositIdOf(address(a), 2)), keccak256(abi.encode(account, address(usdc), 7e6)));
        assertEq(gateway.callCount(), 3);
        assertEq(lastCall().xcm, expectedXcm(address(a), 2, account, address(usdc), 7e6));
    }

    function test_depositIdsDoNotDependOnTheOrderOfDifferentForwarders() public {
        Forwarder a = deployed();
        Forwarder b = deployedFor(keccak256("second user"), stranger);
        usdc.mint(address(a), 5e6);
        usdc.mint(address(b), 6e6);
        uint256 start = vm.snapshotState();

        triggerAs(relayer, a, address(usdc));
        triggerAs(relayer, b, address(usdc));
        bytes memory xcmA = gateway.callAt(0).xcm;
        bytes memory xcmB = gateway.callAt(1).xcm;

        vm.revertToState(start);
        triggerAs(relayer, b, address(usdc));
        triggerAs(relayer, a, address(usdc));

        assertEq(gateway.callAt(0).xcm, xcmB);
        assertEq(gateway.callAt(1).xcm, xcmA);
    }

    function test_storesTheHashAndEmitsSent() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        uint256 depositId = depositIdOf(address(f), 1);

        vm.expectEmit(true, true, false, true, address(router));
        emit Router.Sent(depositId, account, address(usdc), DEPOSIT);
        triggerAs(relayer, f, address(usdc));

        assertEq(router.deposits(depositId), keccak256(abi.encode(account, address(usdc), DEPOSIT)));
        assertEq(router.deposits(depositIdOf(address(f), 2)), bytes32(0));
    }

    function test_emitsExactlyOneSentWithTheRightFields() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);

        vm.recordLogs();
        triggerAs(relayer, f, address(usdc));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 sent;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != Router.Sent.selector) continue;
            ++sent;
            assertEq(logs[i].emitter, address(router));
            assertEq(uint256(logs[i].topics[1]), depositIdOf(address(f), 1));
            assertEq(logs[i].topics[2], account);
            (address token, uint256 amount) = abi.decode(logs[i].data, (address, uint256));
            assertEq(token, address(usdc));
            assertEq(amount, DEPOSIT);
        }
        assertEq(sent, 1);
    }

    function test_theGatewayReceivesTheSplicedXcmAndTheClaimer() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        triggerAs(relayer, f, address(usdc));

        GatewayCall memory call = lastCall();
        assertEq(call.sender, address(router));
        uint256 depositId = uint256(keccak256(abi.encode(address(f), uint256(1))));
        assertEq(call.xcm, bytes.concat(XCM_HEAD, abi.encode(depositId, account, address(usdc), DEPOSIT), XCM_TAIL));
        assertEq(call.xcm, expectedXcm(address(f), 1, account, address(usdc), DEPOSIT));
        assertEq(call.claimer, bytes.concat(CLAIMER_HEAD, account));
        assertEq(call.token, address(usdc));
        assertEq(call.amount, DEPOSIT);
        assertEq(call.executionFee, EXEC_FEE);
        assertEq(call.relayerFee, RELAYER_FEE);
        assertEq(call.value, uint256(EXEC_FEE) + RELAYER_FEE);
    }

    function test_theSplicedSectionIsAlways128Bytes() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        triggerAs(relayer, f, address(usdc));
        assertEq(lastCall().xcm.length, XCM_HEAD.length + 128 + XCM_TAIL.length);
        assertEq(lastCall().claimer.length, CLAIMER_HEAD.length + 32);
    }

    function test_theByteStringsAreTheOnesTheFactoryWasBuiltWith() public view {
        assertEq(router.xcmHead(), XCM_HEAD);
        assertEq(router.xcmTail(), XCM_TAIL);
        assertEq(router.claimerHead(), CLAIMER_HEAD);
        assertEq(address(router.GATEWAY()), address(gateway));
        assertEq(address(router.FACTORY()), address(factory));
        assertEq(address(factory.ROUTER()), address(router));
    }

    function test_theRouterHoldsNothingAfterASend() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        triggerAs(relayer, f, address(usdc));

        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
        assertEq(address(gateway.AGENT()).balance, uint256(EXEC_FEE) + RELAYER_FEE);
    }

    function test_theGatewayRevertingRevertsTheWholeTrigger() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        vm.mockCallRevert(address(gateway), abi.encodePacked(MockGateway.v2_sendMessage.selector), "refused");

        vm.prank(relayer);
        vm.expectRevert(bytes("refused"));
        f.trigger{value: uint256(EXEC_FEE) + RELAYER_FEE}(address(usdc), EXEC_FEE, RELAYER_FEE);

        assertEq(usdc.balanceOf(address(f)), DEPOSIT);
        assertEq(router.sendsOf(address(f)), 0, "a failed send does not consume a deposit id");
        assertEq(router.deposits(depositIdOf(address(f), 1)), bytes32(0));
    }

    function test_amountAboveUint128RevertsBeforeTheGateway() public {
        Forwarder f = deployed();
        usdc.mint(address(f), uint256(type(uint128).max) + 1);

        vm.prank(relayer);
        vm.expectRevert();
        f.trigger(address(usdc), 0, 0);
        assertEq(gateway.callCount(), 0);
    }

    function testFuzz_splicedXcmEqualsHeadDepositTail(bytes32 account_, address owner_, uint96 amount) public {
        vm.assume(amount > 0 && owner_ != address(0));
        Forwarder f = deployedFor(account_, owner_);
        usdc.mint(address(f), amount);

        triggerAs(relayer, f, address(usdc));

        assertEq(lastCall().xcm, expectedXcm(address(f), 1, account_, address(usdc), amount));
        assertEq(lastCall().claimer, bytes.concat(CLAIMER_HEAD, account_));
        assertEq(
            router.deposits(depositIdOf(address(f), 1)), keccak256(abi.encode(account_, address(usdc), uint256(amount)))
        );
    }
}
