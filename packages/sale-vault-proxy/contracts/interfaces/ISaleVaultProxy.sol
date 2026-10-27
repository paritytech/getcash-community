// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

// One seller home's sale vault proxy, as the factory and off-chain readers see it
interface ISaleVaultProxy {
    function onDelivery(
        bytes32 ref,
        address recipient,
        uint256 committed,
        uint256 amount,
        uint256 deadline
    ) external;

    function returnHome() external;

    function release() external;

    function skimForeign(address token) external;

    function skimNative() external;

    function home() external view returns (bytes32);

    function claimer() external view returns (address);

    function nextReturnAt() external view returns (uint256);

    function releaseAt() external view returns (uint256);

    // One sale's record, keyed by its exact terms so a copied ref cannot take it
    function delivery(
        bytes32 ref,
        address recipient,
        uint256 committed
    ) external view returns (uint8 status, uint256 amount, uint256 leftover);

    // Eight static words, decoded by index off chain, so the order is fixed
    function state()
        external
        view
        returns (
            bytes32 home,
            address claimer,
            uint256 balance,
            uint8 attempts,
            uint64 lastReturnAt,
            uint256 nextReturnAt,
            uint256 releaseAt,
            uint256 releasable
        );
}
