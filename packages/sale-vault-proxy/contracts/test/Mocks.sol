// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICFReceiver} from "../interfaces/ICFReceiver.sol";
import {SaleVaultProxyFactory} from "../SaleVaultProxyFactory.sol";

// A 6-decimal USDC stand-in that can blacklist a recipient or pause every transfer, as Circle USDC can
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocked;
    bool public paused;

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

    function setPaused(bool value) external {
        paused = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!paused, "USDC: paused");
        require(!blocked[to], "USDC: recipient blocked");
        super._update(from, to, value);
    }
}

// A token that calls back into a target on every transfer once armed, to prove the reentrancy guard
contract ReentrantToken is ERC20 {
    address public hookTarget;
    bytes public hookData;

    constructor() ERC20("Reentrant", "RE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        address t = hookTarget;
        if (t == address(0)) return;
        hookTarget = address(0);
        (bool ok, bytes memory reason) = t.call(hookData);
        if (!ok) {
            assembly {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }
}

// A Chainflip Vault stand-in: deliver transfers then calls cfReceive, xSwapToken pulls and records the swap
contract MockChainflipVault {
    struct Swap {
        uint32 dstChain;
        bytes dstAddress;
        uint32 dstToken;
        address srcToken;
        uint256 amount;
        bytes cfParameters;
        address sender;
    }

    Swap[] public swaps;
    bool public paused;

    function lastSwap() external view returns (Swap memory) {
        return swaps[swaps.length - 1];
    }

    function setPaused(bool value) external {
        paused = value;
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
        require(!paused, "Vault: suspended");
        srcToken.transferFrom(msg.sender, address(this), amount);
        swaps.push(Swap(dstChain, dstAddress, dstToken, address(srcToken), amount, cfParameters, msg.sender));
    }

    // Plays a killed swap, refunding to the swap's refund address
    function refund(IERC20 token, address to, uint256 amount) external {
        token.transfer(to, amount);
    }
}

// An implementation whose onDelivery always reverts, to reach the unbooked branch
contract RevertingSaleVaultProxy {
    function onDelivery(bytes32, address, uint256, uint256, uint256) external pure {
        revert("onDelivery reverted");
    }
}

// A factory whose proxies delegate to RevertingSaleVaultProxy
contract RevertingSaleVaultProxyFactory is SaleVaultProxyFactory {
    constructor(Config memory c) SaleVaultProxyFactory(c) {}

    function _newImplementation(Config memory) internal override returns (address) {
        return address(new RevertingSaleVaultProxy());
    }
}
