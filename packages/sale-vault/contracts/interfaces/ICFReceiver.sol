// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

// The callback Chainflip's Vault makes on a cross-chain message (CCM) delivery. The Vault transfers
// the egress token to this address first, then calls `cfReceive` in the same transaction. A revert
// here leaves the tokens in the Vault, so an implementation must never revert on a real delivery.
// Verified against chainflip-io/chainflip-eth-contracts contracts/interfaces/ICFReceiver.sol.
interface ICFReceiver {
    // srcChain/srcAddress: where the swap came from. message: the bytes we attached at the source.
    // token: the asset received (a 0xEee... sentinel for native). amount: how much was transferred.
    function cfReceive(
        uint32 srcChain,
        bytes calldata srcAddress,
        bytes calldata message,
        address token,
        uint256 amount
    ) external payable;
}
