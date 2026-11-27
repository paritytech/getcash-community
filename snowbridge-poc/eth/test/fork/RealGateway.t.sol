// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {Forwarder} from "../../src/Forwarder.sol";
import {ForwarderFactory} from "../../src/ForwarderFactory.sol";
import {ISnowbridgeGatewayV2} from "../../src/interfaces/IExternal.sol";
import {Registry} from "../../src/Registry.sol";
import {Router} from "../../src/Router.sol";
import {HookToken, MockERC20} from "../mocks/Mocks.sol";

struct Asset {
    uint8 kind;
    bytes data;
}

struct Xcm {
    uint8 kind;
    bytes data;
}

struct Payload {
    address origin;
    Asset[] assets;
    Xcm xcm;
    bytes claimer;
    uint128 value;
    uint128 executionFee;
    uint128 relayerFee;
}

interface IGatewayViews {
    function isTokenRegistered(address token) external view returns (bool);
    function v2_outboundNonce() external view returns (uint64);
    function v2_registerToken(address token, uint8 network, uint128 executionFee, uint128 relayerFee)
        external
        payable;
}

/// @dev Runs the contracts against the real Gateway v2 on the local stack's execution chain, as a read-only fork.
///      Set GATEWAY_FORK_RPC (for example http://127.0.0.1:8545) to run it. Unset, the tests are skipped; set but
///      unreachable, or without the stack's contracts, they fail.
contract RealGatewayForkTest is Test {
    address private constant GATEWAY = 0xB1185EDE04202fE62D38F5db72F71e38Ff3E8305;
    address private constant TOKEN = 0x54D6643762E46036b3448659791adAf554225541;
    bytes32 private constant ACCEPTED = keccak256(
        "OutboundMessageAccepted(uint64,(address,(uint8,bytes)[],(uint8,bytes),bytes,uint128,uint128,uint128))"
    );

    bytes private constant XCM_HEAD = hex"0510deadbeef0000";
    bytes private constant XCM_TAIL = hex"c0ffee0102";
    bytes private constant CLAIMER_HEAD = hex"00010100";
    uint256 private constant DEPOSIT = 1_000e6;
    uint128 private constant EXEC_FEE = 0.0005 ether;

    address private admin = makeAddr("admin");
    address private relayer = makeAddr("relayer");
    address private guardian = makeAddr("guardian");
    address private owner;
    uint256 private ownerPk;
    bytes32 private account = keccak256("getcash user");

    Registry private registry;
    ForwarderFactory private factory;
    Router private router;

    function setUp() public {
        string memory rpc = vm.envOr("GATEWAY_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        require(GATEWAY.code.length != 0, "no Gateway at the expected address");
        require(IGatewayViews(GATEWAY).isTokenRegistered(TOKEN), "test token not registered");

        (owner, ownerPk) = makeAddrAndKey("owner");
        registry = new Registry(admin, relayer, guardian);
        (factory, router) = _factoryFor(TOKEN);
        vm.deal(relayer, 10 ether);
        vm.deal(owner, 10 ether);
        vm.deal(address(this), 1 ether);
    }

    function _factoryFor(address token) private returns (ForwarderFactory f, Router r) {
        f = new ForwarderFactory(registry, ISnowbridgeGatewayV2(GATEWAY), token, XCM_HEAD, XCM_TAIL, CLAIMER_HEAD);
        r = f.ROUTER();
    }

    function _registerWithGateway(address token) private {
        IGatewayViews(GATEWAY).v2_registerToken{value: 0.01 ether}(token, 0, 0.01 ether, 0);
    }

    function _funded(address owner_) private returns (Forwarder f) {
        f = Forwarder(payable(factory.deploy(account, owner_)));
        deal(TOKEN, address(f), DEPOSIT);
    }

    function _acceptedMessages(Vm.Log[] memory logs) private pure returns (uint256 count, Payload memory last) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != GATEWAY || logs[i].topics[0] != ACCEPTED) continue;
            ++count;
            (, last) = abi.decode(logs[i].data, (uint64, Payload));
        }
    }

    function test_realGatewayAcceptsTheTriggerAndEmitsOurPayload() public {
        Forwarder f = _funded(owner);
        uint64 nonceBefore = IGatewayViews(GATEWAY).v2_outboundNonce();

        vm.recordLogs();
        vm.prank(relayer);
        f.trigger{value: EXEC_FEE}(TOKEN, EXEC_FEE, 0);
        (uint256 accepted, Payload memory payload) = _acceptedMessages(vm.getRecordedLogs());

        uint256 depositId = uint256(keccak256(abi.encode(address(f), uint256(1))));
        assertEq(accepted, 1);
        assertEq(IGatewayViews(GATEWAY).v2_outboundNonce(), nonceBefore + 1);
        assertEq(payload.origin, address(router));
        assertEq(payload.assets.length, 1);
        assertEq(payload.assets[0].kind, 0, "native ERC-20");
        assertEq(payload.assets[0].data, abi.encode(TOKEN, uint128(DEPOSIT)));
        assertEq(payload.xcm.kind, 0, "raw VersionedXcm");
        assertEq(payload.xcm.data, bytes.concat(XCM_HEAD, abi.encode(depositId, account, TOKEN, DEPOSIT), XCM_TAIL));
        assertEq(payload.claimer, bytes.concat(CLAIMER_HEAD, account));
        assertEq(payload.value, 0);
        assertEq(payload.executionFee, EXEC_FEE);
        assertEq(payload.relayerFee, 0);
        assertEq(IERC20(TOKEN).balanceOf(address(f)), 0);
        assertEq(router.TOKEN(), TOKEN);
    }

    function test_aFeeSumAboveUint128IsRefusedByTheGatewayAndTheTriggerLeavesNothingBehind() public {
        Forwarder f = _funded(owner);
        uint128 half = uint128(1) << 127;
        uint64 nonceBefore = IGatewayViews(GATEWAY).v2_outboundNonce();
        vm.deal(relayer, 2 ** 128);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSignature("ExceededMaximumValue()"));
        f.trigger{value: 2 ** 128}(TOKEN, half, half);

        assertEq(IGatewayViews(GATEWAY).v2_outboundNonce(), nonceBefore);
        assertEq(router.sendsOf(address(f)), 0);
    }

    function test_aTokenTheGatewayAcceptsButTheRouterDoesNotStaysInTheForwarderAndTheOwnerWithdrawsIt() public {
        MockERC20 other = new MockERC20("OTHER");
        _registerWithGateway(address(other));
        Forwarder f = Forwarder(payable(factory.deploy(account, owner)));
        other.mint(address(f), DEPOSIT);
        uint64 nonceBefore = IGatewayViews(GATEWAY).v2_outboundNonce();

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(Router.TokenNotAllowed.selector, address(other)));
        f.trigger{value: EXEC_FEE}(address(other), EXEC_FEE, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Router.TokenNotAllowed.selector, address(other)));
        f.trigger{value: EXEC_FEE}(address(other), EXEC_FEE, 0);

        assertEq(IGatewayViews(GATEWAY).v2_outboundNonce(), nonceBefore);
        assertEq(other.balanceOf(address(f)), DEPOSIT);

        bytes32 digest = f.withdrawDigest(address(other), owner, DEPOSIT, f.withdrawNonce(), block.timestamp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        f.withdraw(address(other), owner, DEPOSIT, block.timestamp, abi.encodePacked(r, s, v));
        assertEq(other.balanceOf(owner), DEPOSIT);
    }

    function test_theNestedAttackWithARegisteredTokenIsRefusedBecauseTheRouterSendsOnlyItsOwnToken() public {
        HookToken hookToken = new HookToken();
        _registerWithGateway(address(hookToken));
        Forwarder victim = Forwarder(payable(factory.deploy(keccak256("victim"), makeAddr("victim owner"))));
        Forwarder attacker = Forwarder(payable(factory.deploy(keccak256("attacker"), address(hookToken))));
        deal(TOKEN, address(attacker), 5e6);
        hookToken.mint(address(victim), 1);
        hookToken.arm(HookToken.Hook.Approve, 1, attacker, TOKEN, false);
        uint64 nonceBefore = IGatewayViews(GATEWAY).v2_outboundNonce();

        vm.prank(relayer, relayer);
        vm.expectRevert(abi.encodeWithSelector(Router.TokenNotAllowed.selector, address(hookToken)));
        victim.trigger{value: 0.001 ether}(address(hookToken), 0.001 ether, 0);

        assertEq(IGatewayViews(GATEWAY).v2_outboundNonce(), nonceBefore, "no message was accepted");
        assertEq(IERC20(TOKEN).balanceOf(address(attacker)), 5e6);
    }

    /// @dev The allowed token itself has callbacks that nest a trigger of an attacker's forwarder (owner = the token)
    ///      inside the trigger key's own transaction.
    function _nestedScenario(HookToken.Hook hook, uint256 fireAt)
        private
        returns (Forwarder victim, Forwarder attacker, address hookAddress, Router hookRouter)
    {
        HookToken hookToken = new HookToken();
        hookAddress = address(hookToken);
        _registerWithGateway(hookAddress);
        ForwarderFactory hookFactory;
        (hookFactory, hookRouter) = _factoryFor(hookAddress);

        victim = Forwarder(payable(hookFactory.deploy(keccak256("victim"), makeAddr("victim owner"))));
        attacker = Forwarder(payable(hookFactory.deploy(keccak256("attacker"), hookAddress)));
        hookToken.mint(address(attacker), 5e6);
        hookToken.mint(address(victim), 1);
        hookToken.arm(hook, fireAt, attacker, hookAddress, false);
    }

    function test_aNestedTriggerInsideTheTriggerKeysTransactionRevertsAndEmitsNothing() public {
        (Forwarder victim, Forwarder attacker, address hookToken, Router hookRouter) =
            _nestedScenario(HookToken.Hook.Approve, 1);
        uint64 nonceBefore = IGatewayViews(GATEWAY).v2_outboundNonce();

        vm.prank(relayer, relayer);
        vm.expectRevert(Router.SecondSendInTransaction.selector);
        victim.trigger{value: 0.001 ether}(hookToken, 0.001 ether, 0);

        assertEq(IGatewayViews(GATEWAY).v2_outboundNonce(), nonceBefore, "no message was accepted");
        assertEq(hookRouter.sendsOf(address(attacker)), 0);
        assertEq(hookRouter.sendsOf(address(victim)), 0);
        assertEq(IERC20(hookToken).balanceOf(address(attacker)), 5e6);
    }

    function test_aNestedTriggerFromTheGatewaysOwnPullRevertsAndEmitsNothing() public {
        (Forwarder victim, Forwarder attacker, address hookToken, Router hookRouter) =
            _nestedScenario(HookToken.Hook.TransferFrom, 2);
        uint64 nonceBefore = IGatewayViews(GATEWAY).v2_outboundNonce();

        vm.prank(relayer, relayer);
        vm.expectRevert();
        victim.trigger{value: 0.001 ether}(hookToken, 0.001 ether, 0);

        assertEq(IGatewayViews(GATEWAY).v2_outboundNonce(), nonceBefore);
        assertEq(hookRouter.sendsOf(address(attacker)), 0);
    }
}
