// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Forwarder} from "../src/Forwarder.sol";
import {Registry} from "../src/Registry.sol";
import {Router} from "../src/Router.sol";
import {Fixture} from "./Fixture.sol";

contract ForwarderTest is Fixture {
    function test_strangerCannotTrigger() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);

        vm.prank(stranger);
        vm.expectRevert(Forwarder.NotRelayerOrOwner.selector);
        f.trigger{value: uint256(EXEC_FEE) + RELAYER_FEE}(address(usdc), EXEC_FEE, RELAYER_FEE);

        assertEq(usdc.balanceOf(address(f)), DEPOSIT);
        assertEq(gateway.callCount(), 0);
    }

    function test_guardianAndAdminCannotTrigger() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        address[2] memory callers = [guardian, admin];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Forwarder.NotRelayerOrOwner.selector);
            f.trigger(address(usdc), 0, 0);
        }
    }

    function test_triggerKeyTriggers() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);

        triggerAs(relayer, f, address(usdc));

        assertEq(gateway.callCount(), 1);
        assertEq(usdc.balanceOf(address(f)), 0);
        assertEq(usdc.balanceOf(gateway.AGENT()), DEPOSIT);
    }

    function test_ownerTriggers() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);

        triggerAs(owner, f, address(usdc));

        assertEq(gateway.callCount(), 1);
        assertEq(lastCall().relayerFee, RELAYER_FEE, "the owner pays its own relayer fee");
        assertEq(usdc.balanceOf(gateway.AGENT()), DEPOSIT);
    }

    function test_pausedRevertsForTheTriggerKeyAndTheOwner() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        vm.prank(guardian);
        registry.setPaused(true);

        address[2] memory callers = [relayer, owner];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Forwarder.IsPaused.selector);
            f.trigger{value: uint256(EXEC_FEE) + RELAYER_FEE}(address(usdc), EXEC_FEE, RELAYER_FEE);
        }
        assertEq(usdc.balanceOf(address(f)), DEPOSIT);

        vm.prank(guardian);
        registry.setPaused(false);
        triggerAs(relayer, f, address(usdc));
        assertEq(gateway.callCount(), 1);
    }

    function test_strangerStillGetsNotRelayerOrOwnerWhilePaused() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        vm.prank(guardian);
        registry.setPaused(true);

        vm.prank(stranger);
        vm.expectRevert(Forwarder.NotRelayerOrOwner.selector);
        f.trigger(address(usdc), 0, 0);
    }

    function test_rotatedKeyStopsAndNewKeyWorks() public {
        Forwarder f = deployed();
        address next = makeAddr("next relayer");
        vm.deal(next, 1 ether);

        vm.expectEmit(address(registry));
        emit Registry.RelayerChanged(next);
        vm.prank(admin);
        registry.setRelayer(next);

        usdc.mint(address(f), DEPOSIT);
        vm.prank(relayer);
        vm.expectRevert(Forwarder.NotRelayerOrOwner.selector);
        f.trigger{value: uint256(EXEC_FEE) + RELAYER_FEE}(address(usdc), EXEC_FEE, RELAYER_FEE);
        assertEq(usdc.balanceOf(address(f)), DEPOSIT);

        triggerAs(next, f, address(usdc));
        assertEq(gateway.callCount(), 1);
        assertEq(usdc.balanceOf(gateway.AGENT()), DEPOSIT);
    }

    function test_nothingToForwardReverts() public {
        Forwarder f = deployed();
        vm.prank(relayer);
        vm.expectRevert(Forwarder.NothingToForward.selector);
        f.trigger(address(usdc), 0, 0);
    }

    function test_allowancesAreZeroAfterEveryTrigger() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        triggerAs(relayer, f, address(usdc));
        assertEq(usdc.allowance(address(f), address(router)), 0);
        assertEq(usdc.allowance(address(router), address(gateway)), 0);
    }

    function test_allowancesAreZeroForATokenWhoseApproveRefusesToChangeANonZeroAllowance() public {
        (factory, router) = newFactoryFor(address(usdt));
        Forwarder f = deployed();

        usdt.mint(address(f), DEPOSIT);
        triggerAs(relayer, f, address(usdt));
        usdt.mint(address(f), DEPOSIT);
        triggerAs(relayer, f, address(usdt));

        assertEq(usdt.allowance(address(f), address(router)), 0);
        assertEq(usdt.allowance(address(router), address(gateway)), 0);
        assertEq(gateway.callCount(), 2);
    }

    function test_depositsAfterTheFirstTriggerAreForwardedToo() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        triggerAs(relayer, f, address(usdc));
        usdc.mint(address(f), 7e6);
        triggerAs(relayer, f, address(usdc));

        assertEq(lastCall().amount, 7e6);
        assertEq(router.sendsOf(address(f)), 2);
    }

    function test_etherSentToTheDepositAddressIsAccepted() public {
        Forwarder f = deployed();
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(f).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(f).balance, 1 ether);
    }

    // ─── fee value checks ────────────────────────────────────────

    function test_relayerFeeZeroWorks() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);

        vm.prank(relayer);
        f.trigger{value: EXEC_FEE}(address(usdc), EXEC_FEE, 0);

        assertEq(lastCall().executionFee, EXEC_FEE);
        assertEq(lastCall().relayerFee, 0);
        assertEq(lastCall().value, EXEC_FEE);
    }

    function test_zeroFeesAreAcceptedLikeTheGatewayDoes() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);

        vm.prank(relayer);
        f.trigger(address(usdc), 0, 0);

        assertEq(lastCall().value, 0);
        assertEq(usdc.balanceOf(gateway.AGENT()), DEPOSIT);
    }

    function test_valueBelowTheFeesReverts() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);

        vm.prank(relayer);
        vm.expectRevert(Router.FeesMismatch.selector);
        f.trigger{value: uint256(EXEC_FEE) + RELAYER_FEE - 1}(address(usdc), EXEC_FEE, RELAYER_FEE);

        vm.prank(relayer);
        vm.expectRevert(Router.FeesMismatch.selector);
        f.trigger(address(usdc), EXEC_FEE, 0);

        assertEq(usdc.balanceOf(address(f)), DEPOSIT);
    }

    function test_valueAboveTheFeesRevertsSoNoEtherReachesAssetHub() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);

        vm.prank(relayer);
        vm.expectRevert(Router.FeesMismatch.selector);
        f.trigger{value: uint256(EXEC_FEE) + RELAYER_FEE + 1}(address(usdc), EXEC_FEE, RELAYER_FEE);
    }

    function testFuzz_exactValueIsAccepted(uint128 executionFee, uint128 relayerFee) public {
        executionFee = uint128(bound(executionFee, 0, 1_000 ether));
        relayerFee = uint128(bound(relayerFee, 0, 1_000 ether));
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        vm.deal(relayer, uint256(executionFee) + relayerFee);

        vm.prank(relayer);
        f.trigger{value: uint256(executionFee) + relayerFee}(address(usdc), executionFee, relayerFee);

        assertEq(lastCall().executionFee, executionFee);
        assertEq(lastCall().relayerFee, relayerFee);
        assertEq(lastCall().value, uint256(executionFee) + relayerFee);
        assertEq(address(router).balance, 0);
        assertEq(address(f).balance, 0);
    }

    // ─── owner withdrawal by signed message ──────────────────────

    function test_strangerSubmitsTheOwnersWithdrawal() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        address to = makeAddr("user's exchange");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signWithdraw(f, OWNER_PK, address(usdc), to, DEPOSIT, deadline);

        vm.expectEmit(address(f));
        emit Forwarder.Withdrawn(address(usdc), to, DEPOSIT);
        vm.prank(stranger);
        f.withdraw(address(usdc), to, DEPOSIT, deadline, sig);

        assertEq(usdc.balanceOf(to), DEPOSIT);
        assertEq(f.withdrawNonce(), 1);
    }

    function test_withdrawalCannotBeReplayed() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        address to = makeAddr("user's exchange");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signWithdraw(f, OWNER_PK, address(usdc), to, DEPOSIT, deadline);
        f.withdraw(address(usdc), to, DEPOSIT, deadline, sig);

        usdc.mint(address(f), DEPOSIT);
        vm.expectRevert(Forwarder.BadSignature.selector);
        f.withdraw(address(usdc), to, DEPOSIT, deadline, sig);
        assertEq(usdc.balanceOf(address(f)), DEPOSIT);
    }

    function test_withdrawalWithTheWrongSignerReverts() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);

        uint256[2] memory keys = [uint256(0xB0B), uint256(0xBAD)];
        for (uint256 i; i < keys.length; ++i) {
            bytes memory forged = signWithdraw(f, keys[i], address(usdc), relayer, DEPOSIT, block.timestamp);
            vm.prank(relayer);
            vm.expectRevert(Forwarder.BadSignature.selector);
            f.withdraw(address(usdc), relayer, DEPOSIT, block.timestamp, forged);
        }
        assertEq(usdc.balanceOf(address(f)), DEPOSIT);
    }

    function test_withdrawalWithAnExpiredDeadlineReverts() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        bytes memory late = signWithdraw(f, OWNER_PK, address(usdc), owner, DEPOSIT, block.timestamp - 1);

        vm.expectRevert(Forwarder.Expired.selector);
        f.withdraw(address(usdc), owner, DEPOSIT, block.timestamp - 1, late);
    }

    function test_withdrawalAtTheDeadlineWorks() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        bytes memory sig = signWithdraw(f, OWNER_PK, address(usdc), owner, DEPOSIT, block.timestamp);
        f.withdraw(address(usdc), owner, DEPOSIT, block.timestamp, sig);
        assertEq(usdc.balanceOf(owner), DEPOSIT);
    }

    function test_signatureBindsEveryField() public {
        Forwarder f = deployed();
        usdc.mint(address(f), 2 * DEPOSIT);
        address to = makeAddr("to");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signWithdraw(f, OWNER_PK, address(usdc), to, DEPOSIT, deadline);

        vm.expectRevert(Forwarder.BadSignature.selector);
        f.withdraw(address(usdc), stranger, DEPOSIT, deadline, sig);
        vm.expectRevert(Forwarder.BadSignature.selector);
        f.withdraw(address(usdc), to, DEPOSIT + 1, deadline, sig);
        vm.expectRevert(Forwarder.BadSignature.selector);
        f.withdraw(address(usdt), to, DEPOSIT, deadline, sig);
        vm.expectRevert(Forwarder.BadSignature.selector);
        f.withdraw(address(usdc), to, DEPOSIT, deadline + 1, sig);
    }

    function test_withdrawalSignatureIsBoundToOneForwarder() public {
        Forwarder a = deployed();
        Forwarder b = deployedFor(keccak256("another account"), owner);
        usdc.mint(address(a), DEPOSIT);
        usdc.mint(address(b), DEPOSIT);
        bytes memory sig = signWithdraw(a, OWNER_PK, address(usdc), owner, DEPOSIT, block.timestamp);

        vm.expectRevert(Forwarder.BadSignature.selector);
        b.withdraw(address(usdc), owner, DEPOSIT, block.timestamp, sig);
        a.withdraw(address(usdc), owner, DEPOSIT, block.timestamp, sig);
    }

    function test_withdrawalWorksWhilePausedAndForEther() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        vm.deal(address(f), 1 ether);
        vm.prank(guardian);
        registry.setPaused(true);

        bytes memory sig = signWithdraw(f, OWNER_PK, address(usdc), owner, DEPOSIT, block.timestamp);
        f.withdraw(address(usdc), owner, DEPOSIT, block.timestamp, sig);
        assertEq(usdc.balanceOf(owner), DEPOSIT);

        uint256 before = owner.balance;
        sig = signWithdraw(f, OWNER_PK, address(0), owner, 1 ether, block.timestamp);
        f.withdraw(address(0), owner, 1 ether, block.timestamp, sig);
        assertEq(owner.balance, before + 1 ether);
    }

    function test_accountAndOwnerAreFixed() public {
        Forwarder f = deployed();
        vm.startPrank(admin);
        registry.setRelayer(stranger);
        registry.setGuardian(stranger);
        registry.setAdmin(stranger);
        vm.stopPrank();

        assertEq(f.ACCOUNT(), account);
        assertEq(f.OWNER(), owner);
        assertEq(address(f.ROUTER()), address(router));
        assertEq(address(f.FACTORY()), address(factory));
        assertEq(address(f.REGISTRY()), address(registry));
    }
}
