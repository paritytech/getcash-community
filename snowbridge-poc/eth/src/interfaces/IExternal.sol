// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The one Snowbridge call the router makes: `IGatewayV2.v2_sendMessage`
///         (snowbridge contracts/src/v2/IGateway.sol).
/// @dev `xcm` is a SCALE-encoded `VersionedXcm`, each `assets` entry is `abi.encode(uint8(0), token, uint128 amount)`
///      for an Ethereum ERC-20, `claimer` is a SCALE-encoded XCM `Location`. The Gateway reverts unless
///      `msg.value >= executionFee + relayerFee` and `msg.value <= type(uint128).max`.
interface ISnowbridgeGatewayV2 {
    function v2_sendMessage(
        bytes calldata xcm,
        bytes[] calldata assets,
        bytes calldata claimer,
        uint128 executionFee,
        uint128 relayerFee
    ) external payable;
}
