// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Forwarder} from "../src/Forwarder.sol";
import {ForwarderFactory} from "../src/ForwarderFactory.sol";
import {ISnowbridgeGatewayV2} from "../src/interfaces/IExternal.sol";
import {Registry} from "../src/Registry.sol";
import {Router} from "../src/Router.sol";
import {GatewayCall, MockERC20, MockGateway, MockTether} from "./mocks/Mocks.sol";

abstract contract Fixture is Test {
    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant DEPOSIT = 1_000e6;
    uint128 internal constant EXEC_FEE = 0.0005 ether;
    uint128 internal constant RELAYER_FEE = 0.0002 ether;

    bytes internal constant XCM_HEAD = hex"0510deadbeef0000";
    bytes internal constant XCM_TAIL = hex"c0ffee0102";
    bytes internal constant CLAIMER_HEAD = hex"00010100";

    address internal owner = vm.addr(OWNER_PK);
    address internal admin = makeAddr("admin");
    address internal relayer;
    uint256 internal relayerPk;
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");
    bytes32 internal account = keccak256("getcash user");

    MockERC20 internal usdc;
    MockTether internal usdt;
    MockGateway internal gateway;
    Registry internal registry;
    ForwarderFactory internal factory;
    Router internal router;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        (relayer, relayerPk) = makeAddrAndKey("relayer");
        usdc = new MockERC20("USDC");
        usdt = new MockTether();
        gateway = new MockGateway();
        registry = new Registry(admin, relayer, guardian);
        (factory, router) = newFactory();
        vm.deal(relayer, 100 ether);
        vm.deal(owner, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    function newFactory() internal returns (ForwarderFactory f, Router r) {
        return newFactoryFor(address(usdc));
    }

    function newFactoryFor(address token) internal returns (ForwarderFactory f, Router r) {
        f = new ForwarderFactory(
            registry, ISnowbridgeGatewayV2(address(gateway)), token, XCM_HEAD, XCM_TAIL, CLAIMER_HEAD
        );
        r = f.ROUTER();
    }

    function deployed() internal returns (Forwarder) {
        return deployedFor(account, owner);
    }

    function deployedFor(bytes32 account_, address owner_) internal returns (Forwarder) {
        return Forwarder(payable(factory.deploy(account_, owner_)));
    }

    function depositIdOf(address forwarder, uint256 count) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(forwarder, count)));
    }

    function expectedXcm(address forwarder, uint256 count, bytes32 account_, address token, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        return bytes.concat(XCM_HEAD, abi.encode(depositIdOf(forwarder, count), account_, token, amount), XCM_TAIL);
    }

    function triggerAs(address caller, Forwarder f, address token) internal {
        vm.prank(caller);
        f.trigger{value: uint256(EXEC_FEE) + RELAYER_FEE}(token, EXEC_FEE, RELAYER_FEE);
    }

    function lastCall() internal view returns (GatewayCall memory) {
        return gateway.last();
    }

    function signWithdraw(Forwarder f, uint256 pk, address token, address to, uint256 amount, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = f.withdrawDigest(token, to, amount, f.withdrawNonce(), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
