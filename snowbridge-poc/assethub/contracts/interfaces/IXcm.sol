// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

address constant XCM_PRECOMPILE = address(0xA0000);

interface IXcm {
    struct Weight {
        uint64 refTime;
        uint64 proofSize;
    }

    function execute(bytes calldata message, Weight calldata weight) external;

    function weighMessage(bytes calldata message) external view returns (Weight memory weight);
}
