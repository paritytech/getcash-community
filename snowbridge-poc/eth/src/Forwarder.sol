// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {ForwarderFactory} from "./ForwarderFactory.sol";
import {Registry} from "./Registry.sol";
import {Router} from "./Router.sol";

/// @title Forwarder
/// @notice One user's deposit address on Ethereum. It can only send its balance through the router, which names
///         the user's Polkadot account from here, or back to an address the owner signed for. Nothing is upgradeable.
contract Forwarder is EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address token,address to,uint256 amount,uint256 nonce,uint256 deadline)");

    ForwarderFactory public immutable FACTORY;
    Registry public immutable REGISTRY;
    Router public immutable ROUTER;
    bytes32 public immutable ACCOUNT;
    address public immutable OWNER;

    uint256 public withdrawNonce;

    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotRelayerOrOwner();
    error IsPaused();
    error NothingToForward();
    error Expired();
    error BadSignature();

    constructor(bytes32 account, address owner) EIP712("Forwarder", "1") {
        FACTORY = ForwarderFactory(msg.sender);
        REGISTRY = FACTORY.REGISTRY();
        ROUTER = FACTORY.ROUTER();
        ACCOUNT = account;
        OWNER = owner;
    }

    receive() external payable {}

    /// @notice Sends this forwarder's whole balance of `token` to the user's account through the router. The caller
    ///         pays the Snowbridge fees as `msg.value`, which must equal `executionFee + relayerFee`.
    function trigger(address token, uint128 executionFee, uint128 relayerFee) external payable {
        if (msg.sender != OWNER && msg.sender != REGISTRY.relayer()) revert NotRelayerOrOwner();
        if (REGISTRY.paused()) revert IsPaused();

        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToForward();

        IERC20(token).forceApprove(address(ROUTER), amount);
        ROUTER.send{value: msg.value}(token, amount, executionFee, relayerFee);
    }

    /// @notice Sends `amount` of `token` (`address(0)` for ether) to `to`, as signed by the owner. Anyone may
    ///         submit the signature, and neither a pause nor a newer forwarder version blocks it.
    function withdraw(address token, address to, uint256 amount, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = withdrawDigest(token, to, amount, withdrawNonce, deadline);
        if (ECDSA.recover(digest, signature) != OWNER) revert BadSignature();
        withdrawNonce += 1;

        emit Withdrawn(token, to, amount);
        if (token == address(0)) {
            Address.sendValue(payable(to), amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function withdrawDigest(address token, address to, uint256 amount, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(WITHDRAW_TYPEHASH, token, to, amount, nonce, deadline)));
    }
}
