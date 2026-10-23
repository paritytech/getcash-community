// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICFReceiver} from "../interfaces/ICFReceiver.sol";

// A 6-decimal USDC stand-in that can blacklist a recipient, so the payout-failed branch is testable.
// Real Arbitrum USDC reverts transfers to a blacklisted address, and this reverts too.
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Mock USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "USDC: recipient blocked");
        super._update(from, to, value);
    }
}

// A Chainflip Vault stand-in. `deliver` mirrors the real `_executexSwapAndCall`: transfer the token
// to the receiver first, then call cfReceive in the same transaction. `xSwapToken` records the last
// return so a test can assert the home leg, pulling the funds with transferFrom like the real vault.
contract MockChainflipVault {
    struct Swap {
        uint32 dstChain;
        bytes dstAddress;
        uint32 dstToken;
        address srcToken;
        uint256 amount;
        bytes cfParameters;
    }

    Swap[] public swaps;

    function swapCount() external view returns (uint256) {
        return swaps.length;
    }

    function lastSwap() external view returns (Swap memory) {
        return swaps[swaps.length - 1];
    }

    function deliver(
        address receiver,
        uint32 srcChain,
        bytes calldata srcAddress,
        bytes calldata message,
        address token,
        uint256 amount
    ) external payable {
        IERC20(token).transfer(receiver, amount);
        ICFReceiver(receiver).cfReceive{value: msg.value}(srcChain, srcAddress, message, token, amount);
    }

    function xSwapToken(
        uint32 dstChain,
        bytes calldata dstAddress,
        uint32 dstToken,
        IERC20 srcToken,
        uint256 amount,
        bytes calldata cfParameters
    ) external {
        srcToken.transferFrom(msg.sender, address(this), amount);
        swaps.push(Swap(dstChain, dstAddress, dstToken, address(srcToken), amount, cfParameters));
    }
}
