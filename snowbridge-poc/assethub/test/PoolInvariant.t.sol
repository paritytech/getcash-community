// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Pool} from "../contracts/Pool.sol";
import {MockErc20, MockXcm} from "./Mocks.sol";
import {PoolBase} from "./PoolBase.sol";

/// Drives the pool with arbitrary sequences of funding, fronting, settling and claiming.
contract PoolHandler is Test {
    Pool public immutable pool;
    MockXcm public immutable xcm;
    MockErc20 public immutable erc20;
    address public immutable token;
    address public immutable settler;
    uint256 public immutable feeCapBps;
    uint256 public immutable bridgeFee;

    address[3] public actors = [address(0xa11ce), address(0xb0b), address(0xca401)];
    bytes32[3] public accounts = [bytes32(uint256(0x1234)), bytes32(uint256(0x5678)), bytes32(uint256(0xfee))];

    constructor(Pool pool_, MockXcm xcm_, MockErc20 erc20_) {
        pool = pool_;
        xcm = xcm_;
        erc20 = erc20_;
        token = pool_.TOKEN();
        settler = pool_.SETTLER();
        feeCapBps = pool_.FRONT_FEE_CAP_BPS();
        bridgeFee = pool_.BRIDGE_FEE();
    }

    function addFunds(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % 3];
        amount = bound(amount, 0, 1e6);
        erc20.mint(actor, amount);
        vm.startPrank(actor);
        erc20.approve(address(pool), amount);
        pool.addFunds(token, amount);
        vm.stopPrank();
    }

    function removeFunds(uint256 actorSeed, uint256 amount) external {
        vm.prank(actors[actorSeed % 3]);
        try pool.removeFunds(token, bound(amount, 0, 2e6)) {} catch {}
    }

    function front(uint256 actorSeed, uint256 id, uint256 accountSeed, uint256 amount, uint256 extraFee) external {
        amount = bound(amount, 1, 1e6);
        uint256 fee = bridgeFee + bound(extraFee, 0, amount * feeCapBps / 10_000);
        vm.prank(actors[actorSeed % 3]);
        try pool.front(bound(id, 1, 5), accounts[accountSeed % 3], token, amount, fee) {} catch {}
    }

    function settle(uint256 id, uint256 accountSeed, uint256 amount) external {
        amount = bound(amount, 0, 1e6);
        erc20.mint(address(pool), amount);
        vm.prank(settler);
        try pool.settle(bound(id, 1, 5), accounts[accountSeed % 3], token, amount) {}
        catch {
            erc20.burn(address(pool), amount);
        }
    }

    function claim(uint256 accountSeed) external {
        try pool.claim(accounts[accountSeed % 3], token) {} catch {}
    }

    function setFailsFor(uint256 accountSeed, bool value) external {
        xcm.setFailsFor(accounts[accountSeed % 3], value);
    }

    function setFailing(bool value) external {
        xcm.setFailing(value);
    }

    function totalOfFunds() external view returns (uint256 total) {
        for (uint256 i; i < 3; ++i) total += pool.funds(actors[i], token);
    }

    function totalOfOwed() external view returns (uint256 total) {
        for (uint256 i; i < 3; ++i) total += pool.owed(accounts[i], token);
    }
}

contract PoolInvariantTest is PoolBase {
    PoolHandler handler;

    function setUp() public override {
        super.setUp();
        handler = new PoolHandler(pool, xcm, erc20);
        targetContract(address(handler));
    }

    /// Every token in the pool is either some payer's funds or owed to someone; nothing is stranded or double counted.
    function invariant_poolBalanceEqualsFundsPlusOwed() public view {
        uint256 liabilities = pool.totalFunds(TOKEN) + pool.totalOwed(TOKEN);
        assertEq(erc20.balanceOf(address(pool)), liabilities);
    }

    function invariant_totalsAreTheSumsOfTheLedgers() public view {
        assertEq(pool.totalFunds(TOKEN), handler.totalOfFunds());
        assertEq(pool.totalOwed(TOKEN), handler.totalOfOwed());
    }
}
