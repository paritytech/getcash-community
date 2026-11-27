// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ISnowbridgeGatewayV2} from "./interfaces/IExternal.sol";
import {IForwarder, IForwarderFactory} from "./interfaces/IForwarding.sol";

/// @title Router
/// @notice The only path from forwarders to the Snowbridge Gateway, so every message of ours has one Ethereum
///         sender. It numbers each deposit and attaches the XCM, with the deposit spliced in, and the forwarder's
///         own account as claimer. No admin, not upgradeable. The three byte strings are opaque to it.
///         It sends one token only, the one Asset Hub's pool handles, so any other token stays in its forwarder.
///         At most one `send` runs per transaction, so a token callback cannot add a second message to a
///         transaction signed by the trigger key.
contract Router {
    using SafeERC20 for IERC20;

    /// @dev Kind tag of an Ethereum-native ERC-20 in the Gateway's `assets` array.
    uint8 private constant NATIVE_ERC20 = 0;

    ISnowbridgeGatewayV2 public immutable GATEWAY;
    IForwarderFactory public immutable FACTORY;
    address public immutable TOKEN;

    bytes public xcmHead;
    bytes public xcmTail;
    bytes public claimerHead;

    /// @notice Sends so far per forwarder. A deposit id is a hash of the forwarder and this count, so it does not
    ///         depend on the order in which different forwarders were triggered.
    mapping(address forwarder => uint256) public sendsOf;
    mapping(uint256 depositId => bytes32 digest) public deposits;

    bool private transient sentInThisTransaction;

    event Sent(uint256 indexed depositId, bytes32 indexed account, address token, uint256 amount);

    error NotForwarder();
    error TokenNotAllowed(address token);
    error FeesMismatch();
    error SecondSendInTransaction();

    constructor(
        ISnowbridgeGatewayV2 gateway,
        IForwarderFactory factory,
        address token,
        bytes memory xcmHead_,
        bytes memory xcmTail_,
        bytes memory claimerHead_
    ) {
        GATEWAY = gateway;
        FACTORY = factory;
        TOKEN = token;
        xcmHead = xcmHead_;
        xcmTail = xcmTail_;
        claimerHead = claimerHead_;
    }

    /// @dev `msg.value` must equal the two fees, so no ether reaches Asset Hub beyond them.
    function send(address token, uint256 amount, uint128 executionFee, uint128 relayerFee) external payable {
        if (!FACTORY.isForwarder(msg.sender)) revert NotForwarder();
        if (token != TOKEN) revert TokenNotAllowed(token);
        if (msg.value != uint256(executionFee) + relayerFee) revert FeesMismatch();
        if (sentInThisTransaction) revert SecondSendInTransaction();
        sentInThisTransaction = true;

        bytes32 account = IForwarder(msg.sender).ACCOUNT();
        uint256 depositId = uint256(keccak256(abi.encode(msg.sender, ++sendsOf[msg.sender])));
        deposits[depositId] = keccak256(abi.encode(account, token, amount));

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).forceApprove(address(GATEWAY), amount);

        bytes[] memory assets = new bytes[](1);
        assets[0] = abi.encode(NATIVE_ERC20, token, SafeCast.toUint128(amount));
        GATEWAY.v2_sendMessage{value: msg.value}(
            bytes.concat(xcmHead, abi.encode(depositId, account, token, amount), xcmTail),
            assets,
            bytes.concat(claimerHead, account),
            executionFee,
            relayerFee
        );

        IERC20(token).forceApprove(address(GATEWAY), 0);
        emit Sent(depositId, account, token, amount);
    }
}
