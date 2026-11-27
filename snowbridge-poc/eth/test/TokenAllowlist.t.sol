// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Forwarder} from "../src/Forwarder.sol";
import {ForwarderFactory} from "../src/ForwarderFactory.sol";
import {Router} from "../src/Router.sol";
import {Fixture} from "./Fixture.sol";
import {HookToken, MockERC20} from "./mocks/Mocks.sol";

/// @dev Asset Hub's pool handles one token. Any other token a forwarder holds must stay in the forwarder.
contract TokenAllowlistTest is Fixture {
    function _expectNotAllowed(address token) private {
        vm.expectRevert(abi.encodeWithSelector(Router.TokenNotAllowed.selector, token));
    }

    function test_theRouterSendsTheTokenTheFactoryWasBuiltWithAndNoOther() public {
        assertEq(router.TOKEN(), address(usdc));

        (ForwarderFactory tetherFactory, Router tetherRouter) = newFactoryFor(address(usdt));
        assertEq(tetherRouter.TOKEN(), address(usdt));
        Forwarder f = Forwarder(payable(tetherFactory.deploy(account, owner)));
        usdc.mint(address(f), DEPOSIT);

        vm.prank(relayer);
        _expectNotAllowed(address(usdc));
        f.trigger(address(usdc), 0, 0);
    }

    function test_theRouterRefusesAnyOtherTokenBeforeTouchingIt() public {
        Forwarder f = deployed();
        address noCode = makeAddr("not a token");

        vm.prank(address(f));
        _expectNotAllowed(noCode);
        router.send(noCode, DEPOSIT, 0, 0);

        vm.prank(address(f));
        _expectNotAllowed(address(0));
        router.send(address(0), DEPOSIT, 0, 0);
    }

    function testFuzz_theRouterRefusesEveryTokenButItsOwn(address token, uint256 amount) public {
        vm.assume(token != address(usdc));
        Forwarder f = deployed();

        vm.prank(address(f));
        _expectNotAllowed(token);
        router.send(token, amount, 0, 0);
    }

    function test_aStrangerStillGetsNotForwarderForAnyToken() public {
        vm.prank(stranger);
        vm.expectRevert(Router.NotForwarder.selector);
        router.send(address(usdt), DEPOSIT, 0, 0);
    }

    function test_aStrayTokenStaysInTheForwarderForTheTriggerKeyAndTheOwner() public {
        Forwarder f = deployed();
        MockERC20 dai = new MockERC20("DAI");
        dai.mint(address(f), DEPOSIT);
        usdt.mint(address(f), DEPOSIT);
        usdc.mint(address(f), DEPOSIT);

        address[2] memory callers = [relayer, owner];
        address[2] memory strays = [address(dai), address(usdt)];
        for (uint256 i; i < callers.length; ++i) {
            for (uint256 j; j < strays.length; ++j) {
                vm.prank(callers[i]);
                _expectNotAllowed(strays[j]);
                f.trigger{value: uint256(EXEC_FEE) + RELAYER_FEE}(strays[j], EXEC_FEE, RELAYER_FEE);
            }
        }

        assertEq(dai.balanceOf(address(f)), DEPOSIT);
        assertEq(usdt.balanceOf(address(f)), DEPOSIT);
        assertEq(usdc.balanceOf(address(f)), DEPOSIT);
        assertEq(gateway.callCount(), 0);
        assertEq(router.sendsOf(address(f)), 0);
    }

    function test_theOwnerWithdrawsAStrayTokenAndTheRealTokenStillForwards() public {
        Forwarder f = deployed();
        MockERC20 dai = new MockERC20("DAI");
        dai.mint(address(f), DEPOSIT);
        usdc.mint(address(f), DEPOSIT);

        vm.prank(relayer);
        _expectNotAllowed(address(dai));
        f.trigger(address(dai), 0, 0);

        bytes memory sig = signWithdraw(f, OWNER_PK, address(dai), owner, DEPOSIT, block.timestamp);
        vm.prank(stranger);
        f.withdraw(address(dai), owner, DEPOSIT, block.timestamp, sig);
        assertEq(dai.balanceOf(owner), DEPOSIT);
        assertEq(dai.balanceOf(address(f)), 0);

        triggerAs(relayer, f, address(usdc));
        assertEq(gateway.callCount(), 1);
        assertEq(usdc.balanceOf(gateway.AGENT()), DEPOSIT);
    }

    function test_aStrayTokenWithCallbacksCannotGetAnAttackersMessageIntoTheTriggerKeysTransaction() public {
        HookToken hookToken = new HookToken();
        Forwarder victim = deployed();
        Forwarder attacker = deployedFor(keccak256("attacker"), address(hookToken));
        usdc.mint(address(attacker), 5e6);
        hookToken.mint(address(victim), 1);
        hookToken.arm(HookToken.Hook.Approve, 1, attacker, address(usdc), false);

        vm.prank(relayer, relayer);
        _expectNotAllowed(address(hookToken));
        victim.trigger{value: uint256(EXEC_FEE) + RELAYER_FEE}(address(hookToken), EXEC_FEE, RELAYER_FEE);

        assertEq(gateway.callCount(), 0);
        assertEq(usdc.balanceOf(address(attacker)), 5e6);
        assertEq(hookToken.balanceOf(address(victim)), 1);
    }
}
