// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICFReceiver} from "./interfaces/ICFReceiver.sol";
import {IChainflipVault} from "./interfaces/IChainflipVault.sol";
import {ISaleVaultProxy} from "./interfaces/ISaleVaultProxy.sol";
import {CfParameters} from "./libraries/CfParameters.sol";
import {MAX_BACKOFF_SHIFT, SaleVaultProxy} from "./SaleVaultProxy.sol";

/// @title SaleVaultProxyFactory, the CCM target that deploys and funds one SaleVaultProxy per home and claimer
contract SaleVaultProxyFactory is ICFReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Config {
        IChainflipVault vault;
        IERC20 usdc;
        address treasury;
        // Can only retire the factory, its own key and never an operator key
        address guardian;
        bytes32 broker;
        uint32 homeChain;
        uint32 homeToken;
        uint32 retryBlocks;
        // Chainflip MinimumDeposit of the source asset, only checked here
        uint256 minDeposit;
        // Chainflip refund fee plus the source egress fee, only checked here
        uint256 refundFee;
        uint256 minReturn;
        // At least twice minReturn, 0 is refused
        uint256 maxReturn;
        uint256 priceFloorBps;
        uint256 feeAllowance;
        uint256 returnCooldown;
        uint256 releaseDelay;
        uint256 releaseAttempts;
        uint256 staleDelay;
    }

    /// The Chainflip Vault, the only address allowed to call `cfReceive`.
    IChainflipVault public immutable VAULT;
    /// The only token a sale is paid in.
    IERC20 public immutable USDC;
    /// Where unattributable deliveries, foreign tokens and native ETH end up.
    address public immutable TREASURY;
    /// The only caller of retire.
    address public immutable GUARDIAN;
    /// The SaleVaultProxy every proxy delegates to.
    address public immutable IMPLEMENTATION;

    /// Least gas left at the check for a delivery to deploy and pay, measured on real USDC in the fork test.
    uint256 public constant DELIVERY_GAS = 225_000;
    /// Gas forwarded to a proxy's onDelivery, measured on real USDC in the fork test.
    uint256 public constant PROXY_CALL_GAS = 125_000;

    // Chainflip's MaxSwapRetryDurationBlocks
    uint256 private constant MAX_RETRY_BLOCKS = 600;
    // Loosest floor a USDC to USDT return may take, a stable pair, before the fee allowance
    uint256 private constant MIN_PRICE_FLOOR_BPS = 9500;
    // Keeps the 64x backoff within about two months
    uint256 private constant MAX_RETURN_COOLDOWN = 1 days;
    // Longest a returnable balance waits once the keeper stops, above the 64x backoff
    uint256 private constant MAX_STALE_DELAY = 90 days;
    // Chainflip State Chain block time, the unit of retryBlocks
    uint256 private constant CF_BLOCK_SECONDS = 6;

    /// True once the guardian retired this factory, never reset.
    bool public retired;
    /// Sum of every pending and deferred amount, never skimmed.
    uint256 public totalPending;
    // USDC a delivery could not move to its proxy, by keccak256(home, claimer), flushed by flush
    mapping(bytes32 => uint256) private _pending;
    // USDC of deliveries cut short of gas, by keccak256(home, claimer, ref, recipient, committed, deadline)
    mapping(bytes32 => uint256) private _deferred;

    event ProxyDeployed(bytes32 indexed home, address indexed claimer, address indexed proxy);
    event Delivered(
        bytes32 indexed home,
        address indexed proxy,
        bytes32 indexed ref,
        address claimer,
        address recipient,
        uint256 committed,
        uint256 amount
    );
    event DeliveryUnbooked(
        bytes32 indexed home,
        address indexed proxy,
        bytes32 indexed ref,
        address claimer,
        uint256 amount
    );
    event DeliveryDeferred(
        bytes32 indexed home,
        address indexed claimer,
        bytes32 indexed ref,
        address recipient,
        uint256 committed,
        uint256 amount,
        uint256 deadline
    );
    event DeliveryPending(
        bytes32 indexed home,
        address indexed claimer,
        bytes32 indexed ref,
        uint256 amount,
        bytes32 reason
    );
    event DeferredExpired(
        bytes32 indexed home,
        address indexed claimer,
        bytes32 indexed ref,
        address recipient,
        uint256 committed,
        uint256 amount,
        uint256 deadline
    );
    event PendingFlushed(bytes32 indexed home, address indexed claimer, address indexed to, uint256 amount);
    event Unattributed(address indexed token, uint256 amount, bytes32 reason);
    event Skimmed(address indexed token, address indexed to, uint256 amount);
    event Retired();

    error NotVault();
    error NotGuardian();
    error AlreadyRetired();
    error ZeroAddress();
    error BadConfig();
    error NotExpired(uint256 deadline);
    error NothingPending();
    error NotEnoughGas();
    error NothingToSkim();
    error CannotSkimUSDC();
    error TransferFailed();
    error DeployFailed();

    constructor(Config memory c) {
        if (
            address(c.vault) == address(0) ||
            address(c.usdc) == address(0) ||
            c.treasury == address(0) ||
            c.guardian == address(0) ||
            c.broker == bytes32(0)
        ) revert ZeroAddress();
        if (
            c.homeChain == 0 ||
            c.homeToken == 0 ||
            c.retryBlocks == 0 ||
            c.retryBlocks > MAX_RETRY_BLOCKS ||
            c.priceFloorBps < MIN_PRICE_FLOOR_BPS ||
            c.priceFloorBps > CfParameters.BPS ||
            c.refundFee == 0 ||
            c.minReturn <= c.minDeposit + 2 * c.refundFee ||
            (c.minReturn * c.priceFloorBps) / CfParameters.BPS <= c.feeAllowance ||
            c.maxReturn < 2 * c.minReturn ||
            c.returnCooldown == 0 ||
            c.returnCooldown > MAX_RETURN_COOLDOWN ||
            c.releaseDelay < c.retryBlocks * CF_BLOCK_SECONDS ||
            c.staleDelay < c.releaseDelay ||
            c.staleDelay <= c.returnCooldown << MAX_BACKOFF_SHIFT ||
            c.staleDelay > MAX_STALE_DELAY ||
            c.releaseAttempts == 0 ||
            c.releaseAttempts > type(uint8).max
        ) revert BadConfig();
        VAULT = c.vault;
        USDC = c.usdc;
        TREASURY = c.treasury;
        GUARDIAN = c.guardian;
        IMPLEMENTATION = _newImplementation(c);
    }

    /// The proxy address for a home and claimer, deployed or not, a zero claimer is refused.
    function predict(bytes32 home, address claimer) public view returns (address) {
        if (claimer == address(0)) revert ZeroAddress();
        bytes memory args = abi.encodePacked(home, claimer);
        return
            Clones.predictDeterministicAddressWithImmutableArgs(IMPLEMENTATION, args, keccak256(args), address(this));
    }

    /// @notice Deploy a home and claimer's proxy if it has no code yet. Idempotent, anyone can call.
    function deploy(bytes32 home, address claimer) external returns (address) {
        return _deploy(home, claimer);
    }

    /// @notice Stop every proxy's returns home for good, deliveries still book and pay. Guardian only, one-way.
    function retire() external {
        if (msg.sender != GUARDIAN) revert NotGuardian();
        if (retired) revert AlreadyRetired();
        retired = true;
        emit Retired();
    }

    /// @notice Chainflip's delivery callback, moves the USDC into the proxy, which pays the provider
    function cfReceive(
        uint32,
        bytes calldata,
        bytes calldata message,
        address token,
        uint256 amount
    ) external payable {
        // The only allowed revert
        if (msg.sender != address(VAULT)) revert NotVault();

        if (token != address(USDC)) {
            emit Unattributed(token, amount, "token");
            return;
        }
        // Six words: ref, recipient, committed, home, deadline, claimer
        if (message.length != 192) {
            emit Unattributed(token, amount, "message");
            return;
        }
        bytes32 ref = bytes32(message[0:32]);
        // Masks a dirty high part of the address word
        address recipient = address(uint160(uint256(bytes32(message[32:64]))));
        uint256 committed = uint256(bytes32(message[64:96]));
        bytes32 home = bytes32(message[96:128]);
        uint256 deadline = uint256(bytes32(message[128:160]));
        uint256 claimerWord = uint256(bytes32(message[160:192]));
        if (home == bytes32(0)) {
            emit Unattributed(token, amount, "home");
            return;
        }
        // The claimer is part of the proxy address, so it is never masked
        if (claimerWord == 0 || claimerWord > type(uint160).max) {
            emit Unattributed(token, amount, "claimer");
            return;
        }
        address claimer = address(uint160(claimerWord));
        // Anyone can submit the signed CCM with any gas, so a short call keeps its terms for deliver
        if (gasleft() < DELIVERY_GAS) {
            _defer(home, claimer, ref, recipient, committed, amount, deadline);
            return;
        }
        _deliver(home, claimer, ref, recipient, committed, amount, deadline, false);
    }

    /// @notice Replay a gas-short delivery by its exact terms, held past its deadline, reverting if the move fails
    function deliver(
        bytes32 home,
        address claimer,
        bytes32 ref,
        address recipient,
        uint256 committed,
        uint256 deadline
    ) external nonReentrant {
        bytes32 key = _deferKey(home, claimer, ref, recipient, committed, deadline);
        uint256 amount = _deferred[key];
        if (amount == 0) revert NothingPending();
        delete _deferred[key];
        totalPending -= amount;
        if (gasleft() < DELIVERY_GAS) revert NotEnoughGas();
        _deliver(home, claimer, ref, recipient, committed, amount, deadline, true);
    }

    /// @notice Move a deferred delivery to pending strictly after its deadline, where flush can reach the claimer
    function expireDeferred(
        bytes32 home,
        address claimer,
        bytes32 ref,
        address recipient,
        uint256 committed,
        uint256 deadline
    ) external nonReentrant {
        if (block.timestamp <= deadline) revert NotExpired(deadline);
        bytes32 key = _deferKey(home, claimer, ref, recipient, committed, deadline);
        uint256 amount = _deferred[key];
        if (amount == 0) revert NothingPending();
        delete _deferred[key];
        _pending[_pendKey(home, claimer)] += amount;
        emit DeferredExpired(home, claimer, ref, recipient, committed, amount, deadline);
    }

    /// USDC a delivery with these terms left deferred, waiting for deliver.
    function pendingDelivery(
        bytes32 home,
        address claimer,
        bytes32 ref,
        address recipient,
        uint256 committed,
        uint256 deadline
    ) external view returns (uint256) {
        return _deferred[_deferKey(home, claimer, ref, recipient, committed, deadline)];
    }

    /// USDC owed to a home and claimer that a delivery could not move to its proxy, waiting for flush.
    function pending(bytes32 home, address claimer) external view returns (uint256) {
        return _pending[_pendKey(home, claimer)];
    }

    /// @notice Move pending USDC into the proxy, or to the claimer when the proxy refuses it. Never pays a provider.
    function flush(bytes32 home, address claimer) external nonReentrant {
        bytes32 key = _pendKey(home, claimer);
        uint256 amount = _pending[key];
        if (amount == 0) revert NothingPending();
        delete _pending[key];
        totalPending -= amount;
        // So the move into the proxy can only fail on the token, never for gas
        if (gasleft() < DELIVERY_GAS) revert NotEnoughGas();
        address to = _deploy(home, claimer);
        if (!_tryTransfer(to, amount)) {
            to = claimer;
            USDC.safeTransfer(to, amount);
        }
        emit PendingFlushed(home, claimer, to, amount);
    }

    /// @notice Send USDC not owed to any home to the treasury.
    function skim() external nonReentrant {
        uint256 free = USDC.balanceOf(address(this)) - totalPending;
        if (free == 0) revert NothingToSkim();
        USDC.safeTransfer(TREASURY, free);
        emit Skimmed(address(USDC), TREASURY, free);
    }

    /// @notice Send a token other than USDC to the treasury.
    function skimToken(address token) external nonReentrant {
        if (token == address(USDC)) revert CannotSkimUSDC();
        uint256 amount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(TREASURY, amount);
        emit Skimmed(token, TREASURY, amount);
    }

    /// @notice Send native ETH a payable delivery left here to the treasury.
    function skimNative() external nonReentrant {
        uint256 amount = address(this).balance;
        (bool ok, ) = TREASURY.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Skimmed(address(0), TREASURY, amount);
    }

    // Creates the implementation every proxy delegates to, virtual only so a test can swap it
    function _newImplementation(Config memory c) internal virtual returns (address) {
        return address(new SaleVaultProxy(address(this), c));
    }

    // Deploys the proxy, moves the USDC in and books it, strict reverts where cfReceive pends
    function _deliver(
        bytes32 home,
        address claimer,
        bytes32 ref,
        address recipient,
        uint256 committed,
        uint256 amount,
        uint256 deadline,
        bool strict
    ) private {
        address proxy = predict(home, claimer);
        if (proxy.code.length == 0) {
            // A self-call so a CREATE2 failure or out-of-gas is caught
            try this.deploy(home, claimer) returns (address deployed) {
                proxy = deployed;
            } catch {
                if (strict) revert DeployFailed();
                _pend(home, claimer, ref, amount, "deploy");
                return;
            }
        }
        if (!_tryTransfer(proxy, amount)) {
            if (strict) revert TransferFailed();
            _pend(home, claimer, ref, amount, "transfer");
            return;
        }
        try ISaleVaultProxy(proxy).onDelivery{gas: PROXY_CALL_GAS}(ref, recipient, committed, amount, deadline) {
            emit Delivered(home, proxy, ref, claimer, recipient, committed, amount);
        } catch {
            // The USDC is on the proxy, unbooked and returnable
            emit DeliveryUnbooked(home, proxy, ref, claimer, amount);
        }
    }

    // Deploys the proxy unless it already has code, its args and salt bind the home and the claimer
    function _deploy(bytes32 home, address claimer) private returns (address proxy) {
        proxy = predict(home, claimer);
        if (proxy.code.length == 0) {
            bytes memory args = abi.encodePacked(home, claimer);
            Clones.cloneDeterministicWithImmutableArgs(IMPLEMENTATION, args, keccak256(args));
            emit ProxyDeployed(home, claimer, proxy);
        }
    }

    // Keeps a short-of-gas delivery for deliver, only copies with the same deadline add up
    function _defer(
        bytes32 home,
        address claimer,
        bytes32 ref,
        address recipient,
        uint256 committed,
        uint256 amount,
        uint256 deadline
    ) private {
        // Unchecked so the booking itself cannot revert
        unchecked {
            _deferred[_deferKey(home, claimer, ref, recipient, committed, deadline)] += amount;
            totalPending += amount;
        }
        emit DeliveryDeferred(home, claimer, ref, recipient, committed, amount, deadline);
    }

    // Books funds for a home and claimer, unchecked so the booking itself cannot revert
    function _pend(bytes32 home, address claimer, bytes32 ref, uint256 amount, bytes32 reason) private {
        unchecked {
            _pending[_pendKey(home, claimer)] += amount;
            totalPending += amount;
        }
        emit DeliveryPending(home, claimer, ref, amount, reason);
    }

    // A pending credit's key, so a credit only ever reaches its own claimer
    function _pendKey(bytes32 home, address claimer) private pure returns (bytes32) {
        return keccak256(abi.encode(home, claimer));
    }

    // A deferred delivery's key, binding every term so a copy with other terms cannot share it
    function _deferKey(
        bytes32 home,
        address claimer,
        bytes32 ref,
        address recipient,
        uint256 committed,
        uint256 deadline
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(home, claimer, ref, recipient, committed, deadline));
    }

    // A USDC transfer that returns false instead of reverting, so a paused token cannot revert a delivery
    function _tryTransfer(address to, uint256 amount) private returns (bool) {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory data) = address(USDC).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        // Any non-zero word or no return data counts as success
        return success && (data.length == 0 || (data.length == 32 && abi.decode(data, (uint256)) != 0));
    }
}
