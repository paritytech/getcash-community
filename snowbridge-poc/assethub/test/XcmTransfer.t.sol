// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {XcmTransfer} from "../contracts/XcmTransfer.sol";

/// The expected bytes come from the runtime's own codec; regenerate with `pnpm fixtures`.
contract XcmTransferTest is Test {
    string private fixture;

    function setUp() public {
        fixture = vm.readFile("test/fixtures/xcm-transfer.json");
    }

    function test_compact_matchesRuntimeCodec() public view {
        for (uint256 i; i < 13; ++i) {
            string memory path = string.concat(".compact[", vm.toString(i), "]");
            uint256 value = vm.parseUint(vm.parseJsonString(fixture, string.concat(path, ".value")));
            bytes memory expected = vm.parseJsonBytes(fixture, string.concat(path, ".hex"));
            assertEq(XcmTransfer.compact(value), expected, vm.toString(value));
        }
    }

    function test_compact_rejectsValuesAboveU128() public {
        vm.expectRevert(XcmTransfer.ValueExceedsU128.selector);
        this.compactExternal(1 << 128);
    }

    function test_encode_matchesRuntimeCodec() public view {
        for (uint256 i; i < 2; ++i) {
            string memory path = string.concat(".transfers[", vm.toString(i), "]");
            uint64 chainId = uint64(vm.parseUint(vm.parseJsonString(fixture, string.concat(path, ".chainId"))));
            address token = vm.parseJsonAddress(fixture, string.concat(path, ".token"));
            uint256 amount = vm.parseUint(vm.parseJsonString(fixture, string.concat(path, ".amount")));
            bytes32 account = vm.parseJsonBytes32(fixture, string.concat(path, ".account"));
            bytes memory expected = vm.parseJsonBytes(fixture, string.concat(path, ".message"));
            assertEq(XcmTransfer.encode(chainId, token, amount, account), expected);
        }
    }

    function compactExternal(uint256 value) external pure returns (bytes memory) {
        return XcmTransfer.compact(value);
    }
}
