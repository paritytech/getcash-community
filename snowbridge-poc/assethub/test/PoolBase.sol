// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Pool} from "../contracts/Pool.sol";
import {XcmTransfer} from "../contracts/XcmTransfer.sol";
import {XCM_PRECOMPILE} from "../contracts/interfaces/IXcm.sol";
import {MockXcm, MockErc20, MOCK_TOKEN, MOCK_TOKEN_ERC20} from "./Mocks.sol";

abstract contract PoolBase is Test {
    address constant SETTLER = address(0x5e77);
    address constant TOKEN = MOCK_TOKEN;
    address constant TOKEN_ERC20 = MOCK_TOKEN_ERC20;
    bytes32 constant FEE_ACCOUNT = bytes32(uint256(0xfee));
    uint64 constant CHAIN_ID = 11155111;
    uint16 constant CAP_BPS = 100;
    uint256 constant BRIDGE_FEE = 5;

    address constant PAYER = address(0xa11ce);
    address constant OTHER_PAYER = address(0xb0b);
    bytes32 constant USER = bytes32(uint256(0x1234));
    bytes32 constant OTHER_USER = bytes32(uint256(0x5678));

    Pool pool;
    MockXcm xcm = MockXcm(XCM_PRECOMPILE);
    MockErc20 erc20 = MockErc20(TOKEN_ERC20);

    function setUp() public virtual {
        vm.etch(XCM_PRECOMPILE, address(new MockXcm()).code);
        vm.etch(TOKEN_ERC20, address(new MockErc20()).code);
        pool = new Pool(SETTLER, CAP_BPS, BRIDGE_FEE, FEE_ACCOUNT, TOKEN, TOKEN_ERC20, CHAIN_ID);
        fund(PAYER, 10_000);
    }

    function fund(address payer, uint256 amount) internal {
        erc20.mint(payer, amount);
        vm.startPrank(payer);
        erc20.approve(address(pool), amount);
        pool.addFunds(TOKEN, amount);
        vm.stopPrank();
    }

    function assertTransfer(uint256 index, bytes32 account, uint256 amount) internal view {
        assertEq(xcm.messages(index), XcmTransfer.encode(CHAIN_ID, TOKEN, amount, account));
    }

    /// The tokens of a deposit arrive in the pool, as the router's `DepositAsset` does before `settle`.
    function deliver(uint256 amount) internal {
        erc20.mint(address(pool), amount);
    }

    function settleOnly(uint256 id, bytes32 account, uint256 amount) internal {
        vm.prank(SETTLER);
        pool.settle(id, account, TOKEN, amount);
    }

    function settle(uint256 id, bytes32 account, uint256 amount) internal {
        deliver(amount);
        settleOnly(id, account, amount);
    }

    function front(address payer, uint256 id, bytes32 account, uint256 amount, uint256 fee) internal {
        vm.prank(payer);
        pool.front(id, account, TOKEN, amount, fee);
    }
}
