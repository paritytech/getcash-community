// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {Forwarder} from "../src/Forwarder.sol";
import {Router} from "../src/Router.sol";
import {Fixture} from "./Fixture.sol";
import {Batcher, BalanceHookToken, HookToken} from "./mocks/Mocks.sol";

/// @dev The router sends one token only, so these tests make the allowed token itself the one with callbacks. A
///      callback that nests a trigger of the token owner's own forwarder inside the trigger key's transaction must not
///      get a second router message into it.
contract NestedTest is Fixture {
    HookToken private hookToken;
    Forwarder private victim;
    Forwarder private attacker;
    bytes32 private attackerAccount = keccak256("attacker");

    function setUp() public override {
        super.setUp();
        hookToken = new HookToken();
        (factory, router) = newFactoryFor(address(hookToken));
        victim = deployed();
        attacker = deployedFor(attackerAccount, address(hookToken));
        hookToken.mint(address(attacker), 5e6);
        hookToken.mint(address(victim), DEPOSIT);
    }

    function _triggerVictimAsTheTriggerKey() private {
        vm.prank(relayer, relayer);
        victim.trigger{value: uint256(EXEC_FEE) + RELAYER_FEE}(address(hookToken), EXEC_FEE, RELAYER_FEE);
    }

    function _assertNothingMoved() private view {
        assertEq(gateway.callCount(), 0);
        assertEq(hookToken.balanceOf(address(attacker)), 5e6);
        assertEq(hookToken.balanceOf(address(victim)), DEPOSIT);
        assertEq(router.sendsOf(address(attacker)), 0);
        assertEq(router.sendsOf(address(victim)), 0);
    }

    function _assertOnlyTheVictimsMessage() private view {
        assertEq(gateway.callCount(), 1);
        assertEq(lastCall().claimer, bytes.concat(CLAIMER_HEAD, account));
        assertEq(lastCall().xcm, expectedXcm(address(victim), 1, account, address(hookToken), DEPOSIT));
        assertEq(hookToken.balanceOf(address(attacker)), 5e6, "the attacker's forwarder was not forwarded");
        assertEq(router.sendsOf(address(attacker)), 0);
    }

    function test_aNestedSendBeforeTheOuterOneRevertsTheWholeTransaction() public {
        hookToken.arm(HookToken.Hook.Approve, 1, attacker, address(hookToken), false);

        vm.expectRevert(Router.SecondSendInTransaction.selector);
        _triggerVictimAsTheTriggerKey();

        _assertNothingMoved();
    }

    function test_aNestedSendFromTheRoutersPullRevertsTheWholeTransaction() public {
        hookToken.arm(HookToken.Hook.TransferFrom, 1, attacker, address(hookToken), false);

        vm.expectRevert(Router.SecondSendInTransaction.selector);
        _triggerVictimAsTheTriggerKey();

        _assertNothingMoved();
    }

    function test_aNestedSendFromTheGatewaysPullRevertsTheWholeTransaction() public {
        hookToken.arm(HookToken.Hook.TransferFrom, 2, attacker, address(hookToken), false);

        vm.expectRevert(Router.SecondSendInTransaction.selector);
        _triggerVictimAsTheTriggerKey();

        _assertNothingMoved();
    }

    function test_aTokenSwallowingTheRefusedNestedSendStillGetsOnlyTheVictimsMessage() public {
        hookToken.arm(HookToken.Hook.TransferFrom, 1, attacker, address(hookToken), true);

        _triggerVictimAsTheTriggerKey();

        _assertOnlyTheVictimsMessage();
    }

    function test_aNestedSendFromTheApproveTheRouterMakesRevertsTheWholeTransaction() public {
        hookToken.arm(HookToken.Hook.Approve, 2, attacker, address(hookToken), false);

        vm.expectRevert(Router.SecondSendInTransaction.selector);
        _triggerVictimAsTheTriggerKey();

        _assertNothingMoved();
    }

    function test_aNestedSendFromBalanceOfCannotRunInAStaticCall() public {
        BalanceHookToken balanceToken = new BalanceHookToken();
        (factory, router) = newFactoryFor(address(balanceToken));
        Forwarder theVictim = deployed();
        Forwarder mine = deployedFor(keccak256("attacker 2"), address(balanceToken));
        balanceToken.mint(address(mine), 5e6);
        balanceToken.mint(address(theVictim), DEPOSIT);
        balanceToken.arm(mine, address(balanceToken));

        vm.prank(relayer, relayer);
        vm.expectRevert();
        theVictim.trigger{value: uint256(EXEC_FEE) + RELAYER_FEE, gas: 3_000_000}(
            address(balanceToken), EXEC_FEE, RELAYER_FEE
        );

        assertEq(gateway.callCount(), 0);
        assertEq(balanceToken.balances(address(mine)), 5e6);
    }

    function test_aNormalTriggerEmitsExactlyOneMessageForTheTriggeredForwardersAccount() public {
        vm.recordLogs();
        triggerAs(relayer, victim, address(hookToken));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 sent;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == Router.Sent.selector) {
                ++sent;
                assertEq(logs[i].topics[2], account);
            }
        }
        assertEq(sent, 1);
        _assertOnlyTheVictimsMessage();
    }

    function test_aSecondTriggerInTheSameTransactionIsRefused() public {
        Batcher batcher = new Batcher();
        vm.prank(admin);
        registry.setRelayer(address(batcher));
        Forwarder second = deployedFor(keccak256("second user"), owner);
        hookToken.mint(address(second), DEPOSIT);

        vm.expectRevert(Router.SecondSendInTransaction.selector);
        batcher.trigger2(victim, second, address(hookToken));

        assertEq(gateway.callCount(), 0);
        assertEq(hookToken.balanceOf(address(victim)), DEPOSIT);
        assertEq(hookToken.balanceOf(address(second)), DEPOSIT);
    }
}
