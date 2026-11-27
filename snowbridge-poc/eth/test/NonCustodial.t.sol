// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {Forwarder} from "../src/Forwarder.sol";
import {Registry} from "../src/Registry.sol";
import {Router} from "../src/Router.sol";
import {Fixture} from "./Fixture.sol";

/// @dev The deposit can only end up at the Gateway with the forwarder's own account, whoever triggers.
contract NonCustodialTest is Fixture {
    bytes32 private constant TRANSFER = keccak256("Transfer(address,address,uint256)");
    bytes32 private constant APPROVAL = keccak256("Approval(address,address,uint256)");

    function test_triggerKeyMovesFundsOnlyToTheRouterAndTheRouterOnlyToTheGateway() public {
        address[2] memory callers = [relayer, owner];
        for (uint256 c; c < callers.length; ++c) {
            Forwarder f = deployedFor(keccak256(abi.encode("user", c)), owner);
            usdc.mint(address(f), DEPOSIT);
            uint256 callerBefore = usdc.balanceOf(callers[c]);
            uint256 agentBefore = usdc.balanceOf(gateway.AGENT());

            vm.recordLogs();
            triggerAs(callers[c], f, address(usdc));
            Vm.Log[] memory logs = vm.getRecordedLogs();

            uint256 transfers;
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter != address(usdc)) continue;
                address from = address(uint160(uint256(logs[i].topics[1])));
                address to = address(uint160(uint256(logs[i].topics[2])));
                if (logs[i].topics[0] == TRANSFER) {
                    ++transfers;
                    bool toRouter = from == address(f) && to == address(router);
                    bool toGateway = from == address(router) && to == gateway.AGENT();
                    assertTrue(toRouter || toGateway, "token moved somewhere else");
                } else if (logs[i].topics[0] == APPROVAL) {
                    bool forRouter = from == address(f) && to == address(router);
                    bool forGateway = from == address(router) && to == address(gateway);
                    assertTrue(forRouter || forGateway, "approval for somebody else");
                }
            }
            assertEq(transfers, 2);
            assertEq(usdc.balanceOf(callers[c]), callerBefore, "the caller received nothing");
            assertEq(usdc.balanceOf(gateway.AGENT()), agentBefore + DEPOSIT);
            assertEq(usdc.balanceOf(address(f)), 0);
            assertEq(usdc.balanceOf(address(router)), 0);
        }
    }

    function test_accountInTheSpliceAndTheClaimerIsTheForwardersOwn() public {
        bytes32 accountA = keccak256("account A");
        bytes32 accountB = keccak256("account B");
        Forwarder a = deployedFor(accountA, owner);
        Forwarder b = deployedFor(accountB, owner);
        usdc.mint(address(a), 11e6);
        usdc.mint(address(b), 22e6);

        triggerAs(relayer, b, address(usdc));
        assertEq(lastCall().xcm, expectedXcm(address(b), 1, accountB, address(usdc), 22e6));
        assertEq(lastCall().claimer, bytes.concat(CLAIMER_HEAD, accountB));

        triggerAs(relayer, a, address(usdc));
        assertEq(lastCall().xcm, expectedXcm(address(a), 1, accountA, address(usdc), 11e6));
        assertEq(lastCall().claimer, bytes.concat(CLAIMER_HEAD, accountA));
    }

    function test_aForwarderAnAttackerDeploysCanOnlyPayTheAttacker() public {
        Forwarder victim = deployed();
        usdc.mint(address(victim), DEPOSIT);
        bytes32 attackerAccount = keccak256("attacker account");
        Forwarder mine = deployedFor(attackerAccount, stranger);
        usdc.mint(address(mine), 3e6);

        triggerAs(stranger, mine, address(usdc));

        assertEq(lastCall().claimer, bytes.concat(CLAIMER_HEAD, attackerAccount));
        assertEq(usdc.balanceOf(address(victim)), DEPOSIT, "someone else's forwarder is untouched");
    }

    function test_theTriggerKeyCannotWithdrawEvenWithItsOwnSignature() public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        bytes memory sig = signWithdraw(f, relayerPk, address(usdc), relayer, DEPOSIT, block.timestamp);

        vm.prank(relayer);
        vm.expectRevert(Forwarder.BadSignature.selector);
        f.withdraw(address(usdc), relayer, DEPOSIT, block.timestamp, sig);

        vm.prank(relayer);
        vm.expectRevert(Router.NotForwarder.selector);
        router.send(address(usdc), DEPOSIT, 0, 0);
        assertEq(usdc.balanceOf(address(f)), DEPOSIT);
    }

    function test_registryKeysCannotChangeWhereAForwarderSends() public {
        Forwarder f = deployed();
        vm.startPrank(admin);
        registry.setRelayer(makeAddr("another trigger key"));
        registry.setGuardian(makeAddr("another guardian"));
        registry.setAdmin(makeAddr("another admin"));
        vm.expectRevert(Registry.OnlyAdmin.selector);
        registry.setRelayer(makeAddr("the old admin has no power left"));
        vm.stopPrank();

        assertEq(f.ACCOUNT(), account);
        assertEq(address(f.ROUTER()), address(router));
        assertEq(address(router.GATEWAY()), address(gateway));
    }

    function testFuzz_onlyTheTriggerKeyOrTheOwnerTriggers(address caller) public {
        Forwarder f = deployed();
        usdc.mint(address(f), DEPOSIT);
        vm.deal(caller, 1 ether);
        vm.assume(caller != address(f) && caller != address(vm));

        vm.prank(caller);
        if (caller == relayer || caller == owner) {
            f.trigger(address(usdc), 0, 0);
            assertEq(lastCall().claimer, bytes.concat(CLAIMER_HEAD, account));
            assertEq(usdc.balanceOf(gateway.AGENT()), DEPOSIT);
        } else {
            vm.expectRevert(Forwarder.NotRelayerOrOwner.selector);
            f.trigger(address(usdc), 0, 0);
            assertEq(usdc.balanceOf(address(f)), DEPOSIT);
        }
    }

    function testFuzz_whoeverTriggersTheDestinationIsTheForwardersOwn(
        bytes32 account_,
        address owner_,
        uint96 amount,
        bool byOwner
    ) public {
        vm.assume(amount > 0 && owner_ != address(0) && owner_ != address(vm) && owner_.code.length == 0);
        Forwarder f = deployedFor(account_, owner_);
        usdc.mint(address(f), amount);
        vm.deal(owner_, 1 ether);

        triggerAs(byOwner ? owner_ : relayer, f, address(usdc));

        assertEq(lastCall().claimer, bytes.concat(CLAIMER_HEAD, account_));
        assertEq(lastCall().xcm, expectedXcm(address(f), 1, account_, address(usdc), amount));
        assertEq(lastCall().sender, address(router));
        assertEq(usdc.balanceOf(gateway.AGENT()), amount);
    }

    // ─── the callable surface is pinned ──────────────────────────

    function test_routerSurface() public view {
        string[] memory expected = new string[](9);
        expected[0] = "GATEWAY()";
        expected[1] = "FACTORY()";
        expected[2] = "xcmHead()";
        expected[3] = "xcmTail()";
        expected[4] = "claimerHead()";
        expected[5] = "sendsOf(address)";
        expected[6] = "deposits(uint256)";
        expected[7] = "send(address,uint256,uint128,uint128)";
        expected[8] = "TOKEN()";
        assertSurface("Router", expected);
    }

    function test_forwarderSurface() public view {
        string[] memory expected = new string[](11);
        expected[0] = "WITHDRAW_TYPEHASH()";
        expected[1] = "FACTORY()";
        expected[2] = "REGISTRY()";
        expected[3] = "ROUTER()";
        expected[4] = "ACCOUNT()";
        expected[5] = "OWNER()";
        expected[6] = "withdrawNonce()";
        expected[7] = "trigger(address,uint128,uint128)";
        expected[8] = "withdraw(address,address,uint256,uint256,bytes)";
        expected[9] = "withdrawDigest(address,address,uint256,uint256,uint256)";
        expected[10] = "eip712Domain()";
        assertSurface("Forwarder", expected);
    }

    function test_factorySurface() public view {
        string[] memory expected = new string[](5);
        expected[0] = "REGISTRY()";
        expected[1] = "ROUTER()";
        expected[2] = "isForwarder(address)";
        expected[3] = "predict(bytes32,address)";
        expected[4] = "deploy(bytes32,address)";
        assertSurface("ForwarderFactory", expected);
    }

    function test_noDelegatecallCallcodeOrSelfdestructInForwarderOrRouter() public {
        _assertNoDangerousOpcodes(address(deployed()).code);
        _assertNoDangerousOpcodes(address(router).code);
    }

    function assertSurface(string memory name, string[] memory expected) internal view {
        string memory path = string.concat(vm.projectRoot(), "/out/", name, ".sol/", name, ".json");
        string[] memory actual = vm.parseJsonKeys(vm.readFile(path), ".methodIdentifiers");
        assertEq(actual.length, expected.length, string.concat(name, ": function count changed"));
        for (uint256 i; i < expected.length; ++i) {
            bool found;
            for (uint256 j; j < actual.length; ++j) {
                if (keccak256(bytes(actual[j])) == keccak256(bytes(expected[i]))) found = true;
            }
            assertTrue(found, string.concat(name, ": missing ", expected[i]));
        }
    }

    function _assertNoDangerousOpcodes(bytes memory code) private pure {
        for (uint256 i; i < code.length; ++i) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x5f;
                continue;
            }
            assertTrue(op != 0xf4, "DELEGATECALL");
            assertTrue(op != 0xf2, "CALLCODE");
            assertTrue(op != 0xff, "SELFDESTRUCT");
        }
    }
}
