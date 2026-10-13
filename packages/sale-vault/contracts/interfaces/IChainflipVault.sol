// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// The one Chainflip Vault entry point this contract calls: start a token swap out of this chain.
// The Vault pulls `amount` of `srcToken` from the caller with `safeTransferFrom`, so the caller
// must approve the Vault first. Verified against chainflip-io/chainflip-eth-contracts
// contracts/interfaces/IVault.sol and contracts/Vault.sol (xSwapToken does the transferFrom).
interface IChainflipVault {
    // dstChain/dstToken: Chainflip protocol ids for the destination. dstAddress: the raw destination
    // account bytes (a 32-byte account for Polkadot Asset Hub). cfParameters: extra Chainflip params.
    function xSwapToken(
        uint32 dstChain,
        bytes calldata dstAddress,
        uint32 dstToken,
        IERC20 srcToken,
        uint256 amount,
        bytes calldata cfParameters
    ) external;
}
