// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import {CfParameters} from "../libraries/CfParameters.sol";

// Exposes the CfParameters library for the vector tests
contract CfParametersHarness {
    function encode(
        uint32 retryBlocks,
        address refund,
        uint256 minPrice,
        bytes32 broker
    ) external pure returns (bytes memory) {
        return CfParameters.encode(retryBlocks, refund, minPrice, broker);
    }

    function minPriceX128(uint256 amount, uint256 floorBps, uint256 feeAllowance) external pure returns (uint256) {
        return CfParameters.minPriceX128(amount, floorBps, feeAllowance);
    }
}
