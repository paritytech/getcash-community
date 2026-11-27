// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Pool} from "../contracts/Pool.sol";
import {PoolBase} from "./PoolBase.sol";
import {TransferMessage} from "./Mocks.sol";

contract PoolOwedTest is PoolBase {
    address constant STRANGER = address(0x57a);

    function emitted(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic0) return true;
        }
        return false;
    }

    function test_failedUserPayoutIsRecordedAsOwedAndTheDepositIsSettled() public {
        xcm.setFailsFor(USER, true);

        deliver(1_000);
        vm.recordLogs();
        vm.expectEmit(true, false, false, true);
        emit Pool.Owed(1, USER, TOKEN, 995);
        settleOnly(1, USER, 1_000);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertFalse(emitted(logs, Pool.UserPaid.selector));
        assertTrue(emitted(logs, Pool.Settled.selector));
        assertEq(pool.owed(USER, TOKEN), 995);
        assertEq(pool.totalOwed(TOKEN), 995);
        assertTrue(pool.settled(1));
        assertEq(xcm.messageCount(), 1);
        assertTransfer(0, FEE_ACCOUNT, BRIDGE_FEE);
    }

    function test_failedFeePayoutIsRecordedAsOwedToTheFeeAccount() public {
        xcm.setFailsFor(FEE_ACCOUNT, true);

        deliver(1_000);
        vm.expectEmit(true, false, false, true);
        emit Pool.Owed(1, FEE_ACCOUNT, TOKEN, BRIDGE_FEE);
        settleOnly(1, USER, 1_000);

        assertTransfer(0, USER, 995);
        assertEq(pool.owed(FEE_ACCOUNT, TOKEN), BRIDGE_FEE);
        assertEq(pool.owed(USER, TOKEN), 0);
    }

    function test_settleDoesNotRevertWhenEveryPayoutFails() public {
        xcm.setFailing(true);

        settle(1, USER, 1_000);

        assertEq(xcm.messageCount(), 0);
        assertEq(pool.owed(USER, TOKEN), 995);
        assertEq(pool.owed(FEE_ACCOUNT, TOKEN), BRIDGE_FEE);
        assertEq(pool.totalOwed(TOKEN), 1_000);
    }

    function test_settleDoesNotRevertWhenWeighingFails() public {
        xcm.setWeighFailing(true);

        settle(1, USER, 1_000);

        assertEq(xcm.messageCount(), 0);
        assertEq(pool.totalOwed(TOKEN), 1_000);
    }

    function test_frontedSettleNeedsNoXcmForThePayer() public {
        front(PAYER, 1, USER, 1_000, 15);
        xcm.setFailing(true);

        settle(1, USER, 1_000);

        assertEq(pool.funds(PAYER, TOKEN), 10_000 - 985 + 995);
        assertEq(pool.owed(USER, TOKEN), 0);
        assertEq(pool.owed(FEE_ACCOUNT, TOKEN), BRIDGE_FEE);
    }

    function test_mismatchedFrontIsSettledAsOwedWhenTheUserCannotBePaid() public {
        front(PAYER, 1, OTHER_USER, 1_000, 15);
        xcm.setFailsFor(USER, true);

        settle(1, USER, 1_000);

        assertEq(pool.owed(USER, TOKEN), 995);
        assertEq(pool.funds(PAYER, TOKEN), 10_000 - 985);
    }

    function test_claimPaysTheOwedAccountWhenCalledByAnyone() public {
        xcm.setFailsFor(USER, true);
        settle(1, USER, 1_000);
        xcm.setFailsFor(USER, false);

        vm.expectEmit(true, false, false, true);
        emit Pool.Claimed(USER, TOKEN, 995);
        vm.prank(STRANGER);
        pool.claim(USER, TOKEN);

        assertEq(xcm.messageCount(), 2);
        assertTransfer(1, USER, 995);
        assertEq(pool.owed(USER, TOKEN), 0);
        assertEq(pool.totalOwed(TOKEN), 0);
    }

    function test_claimKeepsTheDebtWhileThePayoutStillFails() public {
        xcm.setFailsFor(USER, true);
        settle(1, USER, 1_000);

        vm.expectRevert("xcm failed");
        pool.claim(USER, TOKEN);

        assertEq(pool.owed(USER, TOKEN), 995);
        assertEq(pool.totalOwed(TOKEN), 995);
    }

    function test_claimTwiceReverts() public {
        xcm.setFailsFor(USER, true);
        settle(1, USER, 1_000);
        xcm.setFailsFor(USER, false);
        pool.claim(USER, TOKEN);

        vm.expectRevert(Pool.NothingOwed.selector);
        pool.claim(USER, TOKEN);
    }

    function test_claimWithNothingOwedReverts() public {
        vm.expectRevert(Pool.NothingOwed.selector);
        pool.claim(USER, TOKEN);
    }

    function test_claimOfTheFeeAccountPaysTheFeeAccount() public {
        xcm.setFailsFor(FEE_ACCOUNT, true);
        settle(1, USER, 1_000);
        xcm.setFailsFor(FEE_ACCOUNT, false);

        pool.claim(FEE_ACCOUNT, TOKEN);

        assertTransfer(1, FEE_ACCOUNT, BRIDGE_FEE);
    }

    function test_owedTokensCannotBeRemovedAsFunds() public {
        xcm.setFailsFor(USER, true);
        settle(1, USER, 1_000);
        uint256 poolBalance = erc20.balanceOf(address(pool));

        vm.startPrank(PAYER);
        vm.expectRevert(Pool.InsufficientFunds.selector);
        pool.removeFunds(TOKEN, 10_001);
        pool.removeFunds(TOKEN, 10_000);
        vm.stopPrank();

        assertEq(erc20.balanceOf(address(pool)), poolBalance - 10_000);
        assertGe(erc20.balanceOf(address(pool)), pool.totalFunds(TOKEN) + pool.totalOwed(TOKEN));
    }

    function test_totalsFollowEveryMovementOfFunds() public {
        fund(OTHER_PAYER, 500);
        assertEq(pool.totalFunds(TOKEN), 10_500);

        front(PAYER, 1, USER, 1_000, 15);
        assertEq(pool.totalFunds(TOKEN), 10_500 - 985);

        settle(1, USER, 1_000);
        assertEq(pool.totalFunds(TOKEN), 10_500 - 985 + 995);

        vm.prank(OTHER_PAYER);
        pool.removeFunds(TOKEN, 500);
        assertEq(pool.totalFunds(TOKEN), 10_000 - 985 + 995);
        assertEq(pool.totalFunds(TOKEN), pool.funds(PAYER, TOKEN));
    }

    function test_frontWithFailingPayoutChangesNothing() public {
        xcm.setFailsFor(USER, true);
        uint256 fundsBefore = pool.funds(PAYER, TOKEN);

        vm.prank(PAYER);
        vm.expectRevert("xcm failed");
        pool.front(1, USER, TOKEN, 1_000, 15);

        assertEq(pool.funds(PAYER, TOKEN), fundsBefore);
        assertEq(pool.totalFunds(TOKEN), fundsBefore);
        (uint8 status, address payer) = pool.state(1, USER, TOKEN, 1_000);
        assertEq(status, 0);
        assertEq(payer, address(0));

        xcm.setFailsFor(USER, false);
        front(PAYER, 1, USER, 1_000, 15);
        assertTransfer(0, USER, 985);
    }

    function testFuzz_failedPayoutsConserveTheDeposit(uint96 amount) public {
        xcm.setFailing(true);

        settle(1, USER, amount);

        assertEq(pool.owed(USER, TOKEN) + pool.owed(FEE_ACCOUNT, TOKEN), amount);
        assertEq(pool.totalOwed(TOKEN), amount);
        assertGe(erc20.balanceOf(address(pool)), pool.totalFunds(TOKEN) + pool.totalOwed(TOKEN));
    }

    function testFuzz_settleReportsEveryPayoutOnlyOnce(uint96 amount, bool userFails, bool feeFails) public {
        xcm.setFailsFor(USER, userFails);
        xcm.setFailsFor(FEE_ACCOUNT, feeFails);

        settle(1, USER, amount);

        uint256 paid;
        for (uint256 i; i < xcm.messageCount(); ++i) {
            paid += TransferMessage.amount(xcm.messages(i));
        }
        assertEq(paid + pool.totalOwed(TOKEN), amount);
    }
}
