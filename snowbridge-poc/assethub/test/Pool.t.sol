// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Pool} from "../contracts/Pool.sol";
import {PoolBase} from "./PoolBase.sol";
import {TransferMessage} from "./Mocks.sol";

contract PoolTest is PoolBase {
    function test_unfrontedSettleSplitsBridgeFeeAndUser() public {
        settle(1, USER, 1_000);

        assertEq(xcm.messageCount(), 2);
        assertTransfer(0, USER, 995);
        assertTransfer(1, FEE_ACCOUNT, BRIDGE_FEE);
        assertTrue(pool.settled(1));
    }

    function test_unfrontedSettleEmitsSettledAndUserPaid() public {
        deliver(1_000);
        vm.expectEmit(true, false, false, true);
        emit Pool.Settled(1, false, address(0), 995);
        vm.expectEmit(true, false, false, true);
        emit Pool.UserPaid(1, USER, TOKEN, 995);
        settleOnly(1, USER, 1_000);
    }

    function test_settleSmallerThanBridgeFeePaysOnlyTheFee() public {
        settle(1, USER, 3);

        assertEq(xcm.messageCount(), 1);
        assertTransfer(0, FEE_ACCOUNT, 3);
    }

    function test_settleOnlyBySettler() public {
        vm.expectRevert(Pool.NotSettler.selector);
        pool.settle(1, USER, TOKEN, 1_000);

        vm.prank(PAYER);
        vm.expectRevert(Pool.NotSettler.selector);
        pool.settle(1, USER, TOKEN, 1_000);
    }

    function test_settleTwiceReverts() public {
        settle(1, USER, 1_000);
        vm.prank(SETTLER);
        vm.expectRevert(Pool.AlreadySettled.selector);
        pool.settle(1, USER, TOKEN, 1_000);
    }

    function test_frontPaysUserAndSettleRepaysPayer() public {
        front(PAYER, 1, USER, 1_000, 15);

        assertEq(xcm.messageCount(), 1);
        assertTransfer(0, USER, 985);
        assertEq(pool.funds(PAYER, TOKEN), 10_000 - 985);
        deliver(1_000);

        vm.expectEmit(true, false, false, true);
        emit Pool.Settled(1, true, PAYER, 995);
        settleOnly(1, USER, 1_000);

        assertEq(xcm.messageCount(), 2);
        assertTransfer(1, FEE_ACCOUNT, BRIDGE_FEE);
        assertEq(pool.funds(PAYER, TOKEN), 10_000 - 985 + 995);
    }

    function test_frontedAccountMismatchPaysTheUserAndNotThePayer() public {
        front(PAYER, 1, OTHER_USER, 1_000, 15);
        settle(1, USER, 1_000);

        assertTransfer(1, USER, 995);
        assertEq(pool.funds(PAYER, TOKEN), 10_000 - 985);
    }

    function test_frontedAmountMismatchPaysTheUserAndNotThePayer() public {
        front(PAYER, 1, USER, 900, 14);
        settle(1, USER, 1_000);

        assertTransfer(1, USER, 995);
        assertEq(pool.funds(PAYER, TOKEN), 10_000 - 886);
    }

    function test_frontOfAnotherTokenNeedsFundsInThatToken() public {
        vm.prank(PAYER);
        vm.expectRevert(Pool.InsufficientFunds.selector);
        pool.front(1, USER, address(0xdead), 1_000, 15);
    }

    function test_frontTwiceReverts() public {
        front(PAYER, 1, USER, 1_000, 15);
        vm.prank(OTHER_PAYER);
        vm.expectRevert(Pool.AlreadyFronted.selector);
        pool.front(1, USER, TOKEN, 1_000, 15);
    }

    function test_frontAfterSettleReverts() public {
        settle(1, USER, 1_000);
        vm.prank(PAYER);
        vm.expectRevert(Pool.AlreadySettled.selector);
        pool.front(1, USER, TOKEN, 1_000, 15);
    }

    function test_frontFeeBounds() public {
        vm.startPrank(PAYER);
        vm.expectRevert(Pool.FeeOutOfRange.selector);
        pool.front(1, USER, TOKEN, 1_000, BRIDGE_FEE - 1);
        vm.expectRevert(Pool.FeeOutOfRange.selector);
        pool.front(1, USER, TOKEN, 1_000, BRIDGE_FEE + 11);
        vm.expectRevert(Pool.FeeOutOfRange.selector);
        pool.front(1, USER, TOKEN, 5, 5);
        pool.front(1, USER, TOKEN, 1_000, BRIDGE_FEE + 10);
        vm.stopPrank();
        assertTransfer(0, USER, 985);
    }

    function test_frontNeedsFunds() public {
        vm.prank(OTHER_PAYER);
        vm.expectRevert(Pool.InsufficientFunds.selector);
        pool.front(1, USER, TOKEN, 1_000, 15);
    }

    function test_frontSpendsOnlyTheCallersFunds() public {
        fund(OTHER_PAYER, 500);
        vm.prank(OTHER_PAYER);
        vm.expectRevert(Pool.InsufficientFunds.selector);
        pool.front(1, USER, TOKEN, 1_000, 15);
        assertEq(pool.funds(PAYER, TOKEN), 10_000);
    }

    function test_failedTransferRollsBackFront() public {
        xcm.setFailing(true);
        vm.prank(PAYER);
        vm.expectRevert("xcm failed");
        pool.front(1, USER, TOKEN, 1_000, 15);

        xcm.setFailing(false);
        assertEq(pool.funds(PAYER, TOKEN), 10_000);
        (uint8 status,) = pool.state(1, USER, TOKEN, 1_000);
        assertEq(status, 0);
    }

    function test_removeFundsReturnsTokens() public {
        vm.prank(PAYER);
        pool.removeFunds(TOKEN, 4_000);

        assertEq(pool.funds(PAYER, TOKEN), 6_000);
        assertEq(erc20.balanceOf(PAYER), 4_000);
    }

    function test_removeMoreThanOwnFundsReverts() public {
        fund(OTHER_PAYER, 500);
        vm.prank(OTHER_PAYER);
        vm.expectRevert(Pool.InsufficientFunds.selector);
        pool.removeFunds(TOKEN, 501);
    }

    function test_fundsOfOtherTokensAreRejected() public {
        vm.prank(PAYER);
        vm.expectRevert(Pool.UnsupportedToken.selector);
        pool.addFunds(address(0xdead), 1);
        vm.prank(PAYER);
        vm.expectRevert(Pool.UnsupportedToken.selector);
        pool.removeFunds(address(0xdead), 1);
    }

    function testFuzz_settleNeverPaysOutMoreThanTheDeposit(uint96 amount) public {
        settle(1, USER, amount);

        uint256 paid;
        for (uint256 i; i < xcm.messageCount(); ++i) {
            paid += TransferMessage.amount(xcm.messages(i));
        }
        assertEq(paid, amount);
    }

    function testFuzz_frontedSettleKeepsPayerWithinTheCap(uint96 amount, uint16 extraFee) public {
        amount = uint96(bound(amount, 1_000, 5_000));
        uint256 maxExtra = uint256(amount) * CAP_BPS / 10_000;
        uint256 fee = BRIDGE_FEE + bound(extraFee, 0, maxExtra);

        front(PAYER, 1, USER, amount, fee);
        settle(1, USER, amount);

        uint256 margin = pool.funds(PAYER, TOKEN) - 10_000;
        assertEq(margin, fee - BRIDGE_FEE);
        assertLe(margin, maxExtra);
    }
}
