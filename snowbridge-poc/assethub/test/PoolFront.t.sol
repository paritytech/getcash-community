// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Pool} from "../contracts/Pool.sol";
import {XcmTransfer} from "../contracts/XcmTransfer.sol";
import {PoolBase} from "./PoolBase.sol";
import {TransferMessage} from "./Mocks.sol";

contract PoolFrontTest is PoolBase {
    address constant ATTACKER = address(0xbad);
    bytes32 constant ATTACKER_ACCOUNT = bytes32(uint256(0xbad));
    address constant OTHER_TOKEN = address(0xa0b8);

    function test_strangerFrontOfOtherParametersDoesNotBlockTheHonestFront() public {
        fund(ATTACKER, 1);
        front(ATTACKER, 1, ATTACKER_ACCOUNT, BRIDGE_FEE + 1, BRIDGE_FEE);
        assertTransfer(0, ATTACKER_ACCOUNT, 1);

        front(PAYER, 1, USER, 1_000, 15);
        assertTransfer(1, USER, 985);

        settle(1, USER, 1_000);

        assertEq(pool.funds(PAYER, TOKEN), 10_000 - 985 + 995);
        assertEq(pool.funds(ATTACKER, TOKEN), 0);
        assertEq(xcm.messageCount(), 3);
    }

    function test_frontOfAnotherAmountOrAccountOrIdIsAnotherFront() public {
        front(PAYER, 1, USER, 1_000, 15);
        front(PAYER, 1, USER, 1_001, 15);
        front(PAYER, 1, OTHER_USER, 1_000, 15);
        front(PAYER, 2, USER, 1_000, 15);

        assertEq(xcm.messageCount(), 4);
    }

    function test_theFeeIsNotPartOfTheKey() public {
        front(PAYER, 1, USER, 1_000, 15);
        vm.prank(OTHER_PAYER);
        vm.expectRevert(Pool.AlreadyFronted.selector);
        pool.front(1, USER, TOKEN, 1_000, 6);
    }

    function test_frontOfASettledDepositReverts() public {
        settle(1, USER, 1_000);

        vm.prank(PAYER);
        vm.expectRevert(Pool.AlreadySettled.selector);
        pool.front(1, USER, TOKEN, 1_000, 15);
        vm.prank(PAYER);
        vm.expectRevert(Pool.AlreadySettled.selector);
        pool.front(1, OTHER_USER, TOKEN, 2_000, 15);
    }

    function test_stateReportsNoneFrontedAndSettled() public {
        (uint8 status, address payer) = pool.state(1, USER, TOKEN, 1_000);
        assertEq(status, 0);
        assertEq(payer, address(0));

        front(PAYER, 1, USER, 1_000, 15);
        (status, payer) = pool.state(1, USER, TOKEN, 1_000);
        assertEq(status, 1);
        assertEq(payer, PAYER);
        (status, payer) = pool.state(1, USER, TOKEN, 1_001);
        assertEq(status, 0);
        assertEq(payer, address(0));

        settle(1, USER, 1_000);
        (status, payer) = pool.state(1, USER, TOKEN, 1_000);
        assertEq(status, 2);
        assertEq(payer, PAYER);
        (status,) = pool.state(1, OTHER_USER, TOKEN, 1_000);
        assertEq(status, 2);
    }

    function test_settleOfAnotherTokenTakesNoBridgeFee() public {
        vm.prank(SETTLER);
        pool.settle(1, USER, OTHER_TOKEN, 1_000);

        assertEq(xcm.messageCount(), 1);
        assertEq(xcm.messages(0), XcmTransfer.encode(CHAIN_ID, OTHER_TOKEN, 1_000, USER));
        assertEq(pool.totalOwed(OTHER_TOKEN), 0);
    }

    function test_aFeeInTheBridgedTokensUnitsNeverEatsAnotherTokensDeposit() public {
        Pool realistic = new Pool(SETTLER, CAP_BPS, 1e15, FEE_ACCOUNT, TOKEN, TOKEN_ERC20, CHAIN_ID);

        vm.prank(SETTLER);
        realistic.settle(1, USER, OTHER_TOKEN, 1_000e6);

        assertEq(xcm.messageCount(), 1);
        assertEq(TransferMessage.beneficiary(xcm.messages(0)), USER);
        assertEq(TransferMessage.amount(xcm.messages(0)), 1_000e6);
    }

    function test_settleBeyondU128IsOwedInsteadOfReverting() public {
        uint256 amount = (1 << 128) + 100;

        settle(1, USER, amount);

        assertEq(pool.owed(USER, TOKEN), amount - BRIDGE_FEE);
        assertEq(xcm.messageCount(), 1);
        assertTransfer(0, FEE_ACCOUNT, BRIDGE_FEE);
    }

    function test_settleOfTheLargestAmountDoesNotRevert() public {
        vm.prank(SETTLER);
        pool.settle(1, USER, TOKEN, type(uint256).max);

        assertEq(pool.owed(USER, TOKEN), type(uint256).max - BRIDGE_FEE);
    }

    function test_constructorRejectsAFeeCapAbove100Percent() public {
        vm.expectRevert(Pool.FeeCapTooHigh.selector);
        new Pool(SETTLER, 10_001, BRIDGE_FEE, FEE_ACCOUNT, TOKEN, TOKEN_ERC20, CHAIN_ID);

        new Pool(SETTLER, 10_000, BRIDGE_FEE, FEE_ACCOUNT, TOKEN, TOKEN_ERC20, CHAIN_ID);
    }
}
