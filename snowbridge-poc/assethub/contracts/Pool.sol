// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {XcmTransfer} from "./XcmTransfer.sol";

/// Pays bridged deposits to users, or repays whoever fronted them; a payout that fails is recorded as owed.
contract Pool {
    /// The Asset Hub account of the router, as seen by pallet-revive.
    address public immutable SETTLER;
    uint16 public immutable FRONT_FEE_CAP_BPS;
    uint256 public immutable BRIDGE_FEE;
    bytes32 public immutable FEE_ACCOUNT;
    /// Ethereum address of the bridged token.
    address public immutable TOKEN;
    /// ERC-20 precompile of `TOKEN` on Asset Hub.
    address public immutable TOKEN_ERC20;
    uint64 public immutable ETHEREUM_CHAIN_ID;

    mapping(uint256 depositId => bool) public settled;
    /// The payer of a front, by `keccak256(abi.encode(depositId, account, token, amount))`.
    mapping(bytes32 key => address payer) public fronted;
    mapping(address payer => mapping(address token => uint256)) public funds;
    mapping(bytes32 account => mapping(address token => uint256)) public owed;
    /// The sum of `funds` per token.
    mapping(address token => uint256) public totalFunds;
    /// The sum of `owed` per token. The pool's balance minus both totals is unaccounted surplus.
    mapping(address token => uint256) public totalOwed;

    event FundsAdded(address indexed payer, address indexed token, uint256 amount);
    event FundsRemoved(address indexed payer, address indexed token, uint256 amount);
    event Fronted(
        uint256 indexed depositId, address indexed payer, bytes32 account, address token, uint256 amount, uint256 fee
    );
    event UserPaid(uint256 indexed depositId, bytes32 account, address token, uint256 amount);
    /// `to` is the payer when `repaid`, and zero when the user was paid.
    event Settled(uint256 indexed depositId, bool repaid, address to, uint256 amount);
    /// A payout failed and was recorded as owed to `account`.
    event Owed(uint256 indexed depositId, bytes32 account, address token, uint256 amount);
    event Claimed(bytes32 indexed account, address token, uint256 amount);

    error NotSettler();
    error UnsupportedToken();
    error InsufficientFunds();
    error TransferFailed();
    error AlreadyFronted();
    error AlreadySettled();
    error FeeOutOfRange();
    error FeeCapTooHigh();
    error NothingOwed();

    constructor(
        address settler,
        uint16 frontFeeCapBps,
        uint256 bridgeFee,
        bytes32 feeAccount,
        address token,
        address tokenErc20,
        uint64 ethereumChainId
    ) {
        if (frontFeeCapBps > 10_000) revert FeeCapTooHigh();
        SETTLER = settler;
        FRONT_FEE_CAP_BPS = frontFeeCapBps;
        BRIDGE_FEE = bridgeFee;
        FEE_ACCOUNT = feeAccount;
        TOKEN = token;
        TOKEN_ERC20 = tokenErc20;
        ETHEREUM_CHAIN_ID = ethereumChainId;
    }

    /// 0 none, 1 fronted by `payer`, 2 settled; `payer` is whoever fronted exactly these parameters.
    function state(uint256 depositId, bytes32 account, address token, uint256 amount)
        external
        view
        returns (uint8 status, address payer)
    {
        payer = fronted[_key(depositId, account, token, amount)];
        status = settled[depositId] ? 2 : payer != address(0) ? 1 : 0;
    }

    function addFunds(address token, uint256 amount) external {
        if (token != TOKEN) revert UnsupportedToken();
        funds[msg.sender][token] += amount;
        totalFunds[token] += amount;
        emit FundsAdded(msg.sender, token, amount);
        if (!IERC20(TOKEN_ERC20).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    function removeFunds(address token, uint256 amount) external {
        if (token != TOKEN) revert UnsupportedToken();
        uint256 available = funds[msg.sender][token];
        if (amount > available) revert InsufficientFunds();
        funds[msg.sender][token] = available - amount;
        totalFunds[token] -= amount;
        emit FundsRemoved(msg.sender, token, amount);
        if (!IERC20(TOKEN_ERC20).transfer(msg.sender, amount)) revert TransferFailed();
    }

    /// Pays `account` the deposit minus `fee` from the caller's funds; reverts with no state change if that fails.
    function front(uint256 depositId, bytes32 account, address token, uint256 amount, uint256 fee) external {
        if (settled[depositId]) revert AlreadySettled();
        bytes32 key = _key(depositId, account, token, amount);
        if (fronted[key] != address(0)) revert AlreadyFronted();
        if (fee < BRIDGE_FEE || fee >= amount || fee - BRIDGE_FEE > amount * FRONT_FEE_CAP_BPS / 10_000) {
            revert FeeOutOfRange();
        }

        uint256 payout = amount - fee;
        uint256 available = funds[msg.sender][token];
        if (payout > available) revert InsufficientFunds();
        funds[msg.sender][token] = available - payout;
        totalFunds[token] -= payout;

        fronted[key] = msg.sender;
        emit Fronted(depositId, msg.sender, account, token, amount, fee);

        XcmTransfer.transfer(ETHEREUM_CHAIN_ID, token, payout, account);
        emit UserPaid(depositId, account, token, payout);
    }

    function settle(uint256 depositId, bytes32 account, address token, uint256 amount) external {
        if (msg.sender != SETTLER) revert NotSettler();
        if (settled[depositId]) revert AlreadySettled();
        settled[depositId] = true;

        uint256 bridgeFee = token != TOKEN ? 0 : amount < BRIDGE_FEE ? amount : BRIDGE_FEE;
        uint256 net = amount - bridgeFee;
        address payer = fronted[_key(depositId, account, token, amount)];

        if (payer != address(0)) {
            funds[payer][token] += net;
            totalFunds[token] += net;
            emit Settled(depositId, true, payer, net);
        } else {
            emit Settled(depositId, false, address(0), net);
            if (net != 0) {
                if (XcmTransfer.tryTransfer(ETHEREUM_CHAIN_ID, token, net, account)) {
                    emit UserPaid(depositId, account, token, net);
                } else {
                    _owe(depositId, account, token, net);
                }
            }
        }
        if (bridgeFee != 0 && !XcmTransfer.tryTransfer(ETHEREUM_CHAIN_ID, token, bridgeFee, FEE_ACCOUNT)) {
            _owe(depositId, FEE_ACCOUNT, token, bridgeFee);
        }
    }

    /// Retries the payout of what is owed to `account`, to that same account. Anyone may call it.
    function claim(bytes32 account, address token) external {
        uint256 amount = owed[account][token];
        if (amount == 0) revert NothingOwed();
        owed[account][token] = 0;
        totalOwed[token] -= amount;
        emit Claimed(account, token, amount);
        XcmTransfer.transfer(ETHEREUM_CHAIN_ID, token, amount, account);
    }

    function _owe(uint256 depositId, bytes32 account, address token, uint256 amount) private {
        owed[account][token] += amount;
        totalOwed[token] += amount;
        emit Owed(depositId, account, token, amount);
    }

    function _key(uint256 depositId, bytes32 account, address token, uint256 amount) private pure returns (bytes32) {
        return keccak256(abi.encode(depositId, account, token, amount));
    }
}
