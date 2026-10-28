// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IChainflipVault} from "./interfaces/IChainflipVault.sol";
import {ISaleVaultProxy} from "./interfaces/ISaleVaultProxy.sol";
import {CfParameters} from "./libraries/CfParameters.sol";
import {SaleVaultProxyFactory} from "./SaleVaultProxyFactory.sol";

// The return backoff stops doubling after this many shifts
uint256 constant MAX_BACKOFF_SHIFT = 6;

/// @title SaleVaultProxy, a seller's Arbitrum sale address that pays each sale once and sends the rest home
contract SaleVaultProxy is ISaleVaultProxy, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Paid,
        Held
    }

    // One sale's record, packed in one slot
    struct Delivery {
        Status status;
        uint96 amount;
        uint96 leftover;
    }

    /// The factory that deploys proxies and is the only caller of onDelivery.
    address public immutable FACTORY;
    /// Where native ETH forced in here ends up.
    address public immutable TREASURY;
    // This implementation's own address, to refuse calls that are not through a proxy
    address private immutable SELF;
    /// The only token a sale pays and returns.
    IERC20 public immutable USDC;
    /// The Chainflip Vault a return swaps through.
    IChainflipVault public immutable VAULT;
    /// Chainflip chain id of the return destination (Asset Hub).
    uint32 public immutable HOME_CHAIN;
    /// Chainflip asset id of the return asset (USDT on Asset Hub).
    uint32 public immutable HOME_TOKEN;
    /// The broker account a return names, at 0 bps.
    bytes32 public immutable BROKER;
    /// Chainflip blocks a return retries its min price before refunding here.
    uint32 public immutable RETRY_BLOCKS;
    /// Least balance a return sends, above Chainflip's minimum deposit plus two refund fees.
    uint256 public immutable MIN_RETURN;
    /// Most a single return sends, at least twice MIN_RETURN, never 0.
    uint256 public immutable MAX_RETURN;
    /// Least output a return accepts, in bps of its amount.
    uint256 public immutable PRICE_FLOOR_BPS;
    /// Fixed fee headroom taken off the floor output.
    uint256 public immutable FEE_ALLOWANCE;
    /// Base wait between returns, doubled on every attempt.
    uint256 public immutable RETURN_COOLDOWN;
    /// Wait after the last delivery or return before a balance below MIN_RETURN can be released.
    uint256 public immutable RELEASE_DELAY;
    /// Returns sent after which a balance that came back from one can be released.
    uint256 public immutable RELEASE_ATTEMPTS;
    /// Wait after the last delivery or return before any balance can be released.
    uint256 public immutable STALE_DELAY;

    /// When the last return was sent.
    uint64 public lastReturnAt;
    /// When the last delivery that left funds or the last return happened, the release clock.
    uint64 public lastActivityAt;
    /// Returns sent since the last delivery that left funds, saturating at 255.
    uint8 public attempts;
    // Balance left right after the last return, more than this means something came back
    uint96 private _keptAtReturn;

    // Each sale's record by keccak256(ref, recipient, committed)
    mapping(bytes32 => Delivery) private _deliveries;

    event SalePaid(bytes32 indexed ref, address indexed recipient, uint256 committed, uint256 leftover);
    event SaleHeld(bytes32 indexed ref, address indexed recipient, uint256 committed, uint256 amount, bytes32 reason);
    event ExtraDelivery(bytes32 indexed ref, address indexed recipient, uint256 committed, uint256 amount);
    event ReturnedHome(uint256 amount, uint256 minPriceX128, uint8 attempt);
    event Released(uint256 amount);
    event ForeignSkimmed(address indexed token, uint256 amount);

    error NotFactory();
    error NotProxy();
    error BelowMinimum(uint256 balance, uint256 minimum);
    error ReturnNotDue(uint256 nextReturnAt);
    error FactoryRetired();
    error NothingToRelease();
    error ReleaseNotDue(uint256 releaseAt);
    error CannotSkimUSDC();
    error TransferFailed();

    constructor(address factory, SaleVaultProxyFactory.Config memory c) {
        FACTORY = factory;
        TREASURY = c.treasury;
        SELF = address(this);
        USDC = c.usdc;
        VAULT = c.vault;
        HOME_CHAIN = c.homeChain;
        HOME_TOKEN = c.homeToken;
        BROKER = c.broker;
        RETRY_BLOCKS = c.retryBlocks;
        MIN_RETURN = c.minReturn;
        MAX_RETURN = c.maxReturn;
        PRICE_FLOOR_BPS = c.priceFloorBps;
        FEE_ALLOWANCE = c.feeAllowance;
        RETURN_COOLDOWN = c.returnCooldown;
        RELEASE_DELAY = c.releaseDelay;
        RELEASE_ATTEMPTS = c.releaseAttempts;
        STALE_DELAY = c.staleDelay;
    }

    modifier onlyProxy() {
        if (address(this) == SELF) revert NotProxy();
        _;
    }

    /// The seller's 32-byte Asset Hub account, this proxy's first immutable arg.
    function home() public view onlyProxy returns (bytes32 h) {
        (h, ) = _args();
    }

    /// The seller's Arbitrum address release pays, this proxy's second immutable arg.
    function claimer() public view onlyProxy returns (address c) {
        (, c) = _args();
    }

    /// @notice Book and pay one delivery, held past its deadline, never reverting after the caller check
    function onDelivery(
        bytes32 ref,
        address recipient,
        uint256 committed,
        uint256 amount,
        uint256 deadline
    ) external {
        if (msg.sender != FACTORY) revert NotFactory();
        if (
            recipient == address(0) ||
            committed == 0 ||
            committed > type(uint96).max ||
            amount > type(uint96).max ||
            deadline == 0
        ) {
            emit SaleHeld(ref, recipient, committed, amount, "terms");
            return;
        }
        bytes32 key = _key(ref, recipient, committed);
        Delivery memory d = _deliveries[key];
        uint256 total = uint256(d.amount) + amount;
        d.amount = total > type(uint96).max ? type(uint96).max : uint96(total);
        if (d.status == Status.Paid) {
            _deliveries[key] = d;
            _restart(amount);
            emit ExtraDelivery(ref, recipient, committed, amount);
            return;
        }
        if (block.timestamp > deadline) {
            d.status = Status.Held;
            _deliveries[key] = d;
            _restart(amount);
            emit SaleHeld(ref, recipient, committed, amount, "expired");
            return;
        }
        if (amount < committed) {
            d.status = Status.Held;
            _deliveries[key] = d;
            _restart(amount);
            emit SaleHeld(ref, recipient, committed, amount, "short");
            return;
        }
        uint96 left = uint96(amount - committed);
        d.status = Status.Paid;
        d.leftover = left;
        _deliveries[key] = d;
        if (_tryTransfer(recipient, committed)) {
            _restart(left);
            emit SalePaid(ref, recipient, committed, left);
        } else {
            _deliveries[key] = Delivery(Status.Held, d.amount, 0);
            _restart(amount);
            emit SaleHeld(ref, recipient, committed, amount, "payout");
        }
    }

    /// @notice Send this proxy's USDC home as USDT, permissionless, refused once retired, refunds come back here
    function returnHome() external onlyProxy nonReentrant {
        if (SaleVaultProxyFactory(FACTORY).retired()) revert FactoryRetired();
        uint256 balance = USDC.balanceOf(address(this));
        if (balance < MIN_RETURN) revert BelowMinimum(balance, MIN_RETURN);
        uint256 due = nextReturnAt();
        if (block.timestamp < due) revert ReturnNotDue(due);
        // A chunk always leaves nothing or at least MIN_RETURN behind
        uint256 amount = balance <= MAX_RETURN ? balance : Math.min(MAX_RETURN, balance - MIN_RETURN);
        uint256 minPrice = CfParameters.minPriceX128(amount, PRICE_FLOOR_BPS, FEE_ALLOWANCE);

        uint8 attempt = attempts == type(uint8).max ? type(uint8).max : attempts + 1;
        attempts = attempt;
        lastReturnAt = uint64(block.timestamp);
        lastActivityAt = uint64(block.timestamp);
        uint256 kept = balance - amount;
        _keptAtReturn = kept > type(uint96).max ? type(uint96).max : uint96(kept);

        USDC.forceApprove(address(VAULT), amount);
        VAULT.xSwapToken(
            HOME_CHAIN,
            abi.encodePacked(home()),
            HOME_TOKEN,
            USDC,
            amount,
            CfParameters.encode(RETRY_BLOCKS, address(this), minPrice, BROKER)
        );
        emit ReturnedHome(amount, minPrice, attempt);
    }

    /// When the next return may be sent, 0 before the first since the last delivery.
    function nextReturnAt() public view returns (uint256) {
        if (attempts == 0) return 0;
        uint256 shift = attempts - 1;
        if (shift > MAX_BACKOFF_SHIFT) shift = MAX_BACKOFF_SHIFT;
        return uint256(lastReturnAt) + (RETURN_COOLDOWN << shift);
    }

    /// @notice Send the whole USDC balance to the claimer once releaseAt has passed, permissionless and repeatable
    function release() external onlyProxy nonReentrant {
        uint256 balance = USDC.balanceOf(address(this));
        if (balance == 0) revert NothingToRelease();
        uint256 due = _releaseAt(balance);
        if (block.timestamp < due) revert ReleaseNotDue(due);
        _keptAtReturn = 0;
        USDC.safeTransfer(claimer(), balance);
        emit Released(balance);
    }

    /// When release may run, 0 once retired or out of attempts with a fresh refund, max before any activity.
    function releaseAt() public view returns (uint256) {
        return _releaseAt(USDC.balanceOf(address(this)));
    }

    /// @notice Move a token other than USDC to the factory, which forwards it to the treasury.
    function skimForeign(address token) external nonReentrant {
        if (token == address(USDC)) revert CannotSkimUSDC();
        uint256 amount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(FACTORY, amount);
        emit ForeignSkimmed(token, amount);
    }

    /// @notice Send native ETH forced in here to the treasury.
    function skimNative() external nonReentrant {
        uint256 amount = address(this).balance;
        (bool ok, ) = TREASURY.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit ForeignSkimmed(address(0), amount);
    }

    /// One sale's status, total delivered and leftover at pay time, all zero before its first delivery.
    function delivery(
        bytes32 ref,
        address recipient,
        uint256 committed
    ) external view onlyProxy returns (uint8, uint256, uint256) {
        Delivery memory d = _deliveries[_key(ref, recipient, committed)];
        return (uint8(d.status), d.amount, d.leftover);
    }

    /// Everything a keeper reads, as eight static words, releasable is what release would send now.
    function state()
        external
        view
        onlyProxy
        returns (bytes32, address, uint256, uint8, uint64, uint256, uint256, uint256)
    {
        (bytes32 h, address c) = _args();
        uint256 balance = USDC.balanceOf(address(this));
        uint256 due = _releaseAt(balance);
        uint256 releasable = block.timestamp >= due ? balance : 0;
        return (h, c, balance, attempts, lastReturnAt, nextReturnAt(), due, releasable);
    }

    // When release may run on a balance, the short wait applies only below MIN_RETURN
    function _releaseAt(uint256 balance) private view returns (uint256) {
        if (SaleVaultProxyFactory(FACTORY).retired()) return 0;
        // Out of attempts only once a returnable refund came back within its window, dust or a later credit goes home
        if (
            attempts >= RELEASE_ATTEMPTS &&
            balance >= uint256(_keptAtReturn) + MIN_RETURN &&
            block.timestamp <= uint256(lastReturnAt) + RELEASE_DELAY
        ) return 0;
        if (balance < MIN_RETURN) return uint256(lastActivityAt) + RELEASE_DELAY;
        // A returnable balance with no delivery or return yet has no clock, it goes home first
        if (lastActivityAt == 0) return type(uint256).max;
        return uint256(lastActivityAt) + STALE_DELAY;
    }

    // Only funds a delivery leaves here restart the backoff and the release clock
    function _restart(uint256 kept) private {
        if (kept == 0) return;
        attempts = 0;
        lastActivityAt = uint64(block.timestamp);
    }

    // The clone's args, home then claimer
    function _args() private view returns (bytes32 h, address c) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        h = bytes32(args);
        // solhint-disable-next-line no-inline-assembly
        assembly {
            c := shr(96, mload(add(args, 0x40)))
        }
    }

    // A sale's record key, binding its ref to its recipient and committed amount
    function _key(bytes32 ref, address recipient, uint256 committed) private pure returns (bytes32) {
        return keccak256(abi.encode(ref, recipient, committed));
    }

    // A USDC transfer that returns false instead of reverting, so a blocked payout cannot revert a delivery
    function _tryTransfer(address to, uint256 amount) private returns (bool) {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory data) = address(USDC).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        // Any non-zero word or no return data counts as success
        return success && (data.length == 0 || (data.length == 32 && abi.decode(data, (uint256)) != 0));
    }
}
