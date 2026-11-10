// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

// Chainflip Vault callback after it transfers the CCM egress token here
interface ICFReceiver {
    function cfReceive(
        uint32 srcChain,
        bytes calldata srcAddress,
        bytes calldata message,
        address token,
        uint256 amount
    ) external payable;
}
