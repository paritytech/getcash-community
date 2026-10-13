// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICFReceiver} from "./interfaces/ICFReceiver.sol";
import {IChainflipVault} from "./interfaces/IChainflipVault.sol";

/**
 * @title  SaleVault
 * @notice The on-Arbitrum end of a fiat off-ramp. Chainflip delivers USDC here, this pays the Meld
 *         provider the exact amount and keeps the leftover as self-funding dust.
 * @dev    cfReceive MUST NOT revert once the caller is the Vault, else Chainflip strands the funds.
 *         Every mismatch is bucketed and returned, never reverted. See chainflip-eth-contracts Vault.sol.
 */
contract SaleVault is ICFReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// The Chainflip Vault, the only address allowed to call `cfReceive`.
    IChainflipVault public immutable VAULT;
    /// The only token this contract accounts for. Anything else is operator-rescuable via rescueForeign.
    IERC20 public immutable USDC;
    /// Chainflip chain id for the return destination (Polkadot Asset Hub).
    uint32 public immutable HOME_CHAIN;
    /// Chainflip asset id for the return asset (USDT on Asset Hub).
    uint32 public immutable HOME_TOKEN;

    /// Hot key. Returns refunds, withdraws dust, resolves stuck deliveries. Can move funds.
    address public operator;
    /// Cold key. Its only power is rotating the operator, and it has no fund-moving function of its own.
    address public admin;
    /// Pending cold key, for the two-step admin handover.
    address public pendingAdmin;

    enum Status {
        None,
        Paid,
        Held,
        Returned
    }

    struct Sale {
        address recipient; // Meld deposit address the sale pays
        uint128 amount; // exact amount the sale promised the provider
        bytes32 home; // the seller's Asset Hub account, where a return goes
        uint128 held; // what is held for this sale when the payout did not happen
        Status status;
    }

    /// Each sale, keyed by `ref = keccak256(fundingRequestId)`.
    mapping(bytes32 => Sale) public sales;
    /// Leftover above the exact amount, across all paid sales. Withdrawable by the operator for gas.
    uint256 public dust;
    /// Sum of all `held` amounts. Each exits only to its own sale's home, never to the operator.
    uint256 public heldTotal;
    /// Deliveries that could not be attributed (wrong token, bad message, repeated ref). Operator-rescuable.
    uint256 public stuck;

    event SalePaid(bytes32 indexed ref, address indexed recipient, uint256 amount, uint256 dustAdded);
    event SaleHeld(bytes32 indexed ref, uint256 held);
    event Unknown(uint256 amount, bytes32 reason);
    event Returned(bytes32 indexed ref, uint256 amount, bytes32 kind);
    event DustWithdrawn(uint256 amount);
    event RescuedForeign(address indexed token, address indexed to, uint256 amount);
    event RescuedNative(address indexed to, uint256 amount);
    event OperatorChanged(address indexed previous, address indexed current);
    event AdminChanged(address indexed previous, address indexed current);

    error NotVault();
    error NotOperator();
    error NotAdmin();
    error NotPending();
    error NotHeld();
    error NotPaid();
    error BadAmount();
    error InsufficientDust();
    error ZeroAddress();
    error CannotRescueUSDC();
    error TransferFailed();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        IChainflipVault vault_,
        IERC20 usdc_,
        uint32 homeChain_,
        uint32 homeToken_,
        address operator_,
        address admin_
    ) {
        if (
            address(vault_) == address(0) ||
            address(usdc_) == address(0) ||
            operator_ == address(0) ||
            admin_ == address(0)
        ) revert ZeroAddress();
        VAULT = vault_;
        USDC = usdc_;
        HOME_CHAIN = homeChain_;
        HOME_TOKEN = homeToken_;
        operator = operator_;
        admin = admin_;
    }

    /**
     * @notice Chainflip's delivery callback. Pays the exact amount, keeps the rest as dust, or holds it.
     * @dev    Never reverts once the caller is the Vault. The message is decoded by hand (not abi.decode,
     *         which can revert on a dirty address) after the length is checked.
     */
    function cfReceive(
        uint32,
        bytes calldata,
        bytes calldata message,
        address token,
        uint256 amount
    ) external payable {
        // The only hard failure allowed. The real Vault never trips it, and a stranger calling with
        // no real egress behind them deserves the revert.
        if (msg.sender != address(VAULT)) revert NotVault();

        // From here on, return rather than revert. A non-USDC delivery is not counted (stuck is
        // USDC-denominated, so counting it would break solvency), only flagged for rescue.
        if (token != address(USDC)) {
            emit Unknown(amount, "token");
            return;
        }
        if (message.length != 128) {
            stuck += amount;
            emit Unknown(amount, "message");
            return;
        }

        bytes32 ref = bytes32(message[0:32]);
        address recipient = address(uint160(uint256(bytes32(message[32:64]))));
        uint256 committed = uint256(bytes32(message[64:96]));
        bytes32 home = bytes32(message[96:128]);

        if (sales[ref].status != Status.None) {
            stuck += amount;
            emit Unknown(amount, "ref");
            return;
        }
        // Both fit uint128 in practice (USDC 6-dp, Chainflip bounds swaps below 2^128). Guard anyway
        // so a malformed message cannot wrap on the cast.
        if (committed > type(uint128).max || amount > type(uint128).max) {
            stuck += amount;
            emit Unknown(amount, "range");
            return;
        }

        if (amount >= committed) {
            sales[ref] = Sale({
                recipient: recipient,
                amount: uint128(committed),
                home: home,
                held: 0,
                status: Status.Paid
            });
            // Exact payout, without a revert on failure (USDC can be paused or blacklist the recipient).
            if (_tryTransfer(recipient, committed)) {
                uint256 added = amount - committed;
                dust += added;
                emit SalePaid(ref, recipient, committed, added);
            } else {
                // Payout did not land: hold the whole delivery for this sale's home instead of dust.
                sales[ref].status = Status.Held;
                sales[ref].held = uint128(amount);
                heldTotal += amount;
                emit SaleHeld(ref, amount);
            }
        } else {
            // Underfilled. Record the whole delivery as held, redeemable to the sale's own home.
            sales[ref] = Sale({
                recipient: recipient,
                amount: uint128(committed),
                home: home,
                held: uint128(amount),
                status: Status.Held
            });
            heldTotal += amount;
            emit SaleHeld(ref, amount);
        }
    }

    /**
     * @notice Send a held amount back to its sale's own Asset Hub account. Permissionless: the home
     *         was fixed when the delivery arrived, so anyone paying the gas can only help the seller.
     */
    function returnHeld(bytes32 ref, bytes calldata cfParameters) external nonReentrant {
        Sale storage sale = sales[ref];
        if (sale.status != Status.Held) revert NotHeld();
        uint256 amount = sale.held;
        sale.held = 0;
        sale.status = Status.Returned;
        heldTotal -= amount;
        _returnToHome(sale.home, amount, cfParameters);
        emit Returned(ref, amount, "held");
    }

    /**
     * @notice After Meld reports a paid sale refunded, send the refund to the seller's home from dust.
     * @dev    Bounded by dust, not the sale amount: the sale's own amount already left to the provider,
     *         so refunding more would break solvency.
     */
    function returnRefund(
        bytes32 ref,
        uint256 amount,
        bytes calldata cfParameters
    ) external onlyOperator nonReentrant {
        Sale storage sale = sales[ref];
        if (sale.status != Status.Paid) revert NotPaid();
        if (amount == 0 || amount > sale.amount) revert BadAmount();
        if (amount > dust) revert InsufficientDust();
        sale.status = Status.Returned;
        dust -= amount;
        _returnToHome(sale.home, amount, cfParameters);
        emit Returned(ref, amount, "refund");
    }

    /// @notice Move counted dust to the operator wallet, for gas. Bounded by `dust`.
    function withdrawDust(uint256 amount) external onlyOperator {
        if (amount == 0 || amount > dust) revert BadAmount();
        dust -= amount;
        USDC.safeTransfer(operator, amount);
        emit DustWithdrawn(amount);
    }

    /// @notice Send a stuck (unattributable) delivery to a home the operator confirmed. Bounded by `stuck`.
    function resolveUnknown(
        bytes32 home,
        uint256 amount,
        bytes calldata cfParameters
    ) external onlyOperator nonReentrant {
        if (amount == 0 || amount > stuck) revert BadAmount();
        stuck -= amount;
        _returnToHome(home, amount, cfParameters);
        emit Returned(bytes32(0), amount, "unknown");
    }

    /// @notice Rescue a non-USDC token delivered here by mistake. USDC is excluded so this can never
    ///         touch the counted buckets, and our lane only ever delivers USDC, so this is defensive.
    function rescueForeign(IERC20 token, address to, uint256 amount) external onlyOperator {
        if (address(token) == address(USDC)) revert CannotRescueUSDC();
        token.safeTransfer(to, amount);
        emit RescuedForeign(address(token), to, amount);
    }

    /// @notice Rescue native ETH trapped by a payable delivery. The vault never sends value on our
    ///         USDC lane, so this too is defensive.
    function rescueNative(address payable to, uint256 amount) external onlyOperator {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit RescuedNative(to, amount);
    }

    /// @notice Cold admin rotates the hot operator. The admin can do nothing else to funds.
    function setOperator(address newOperator) external onlyAdmin {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    /// @notice Begin handing the cold admin role to a new key (two-step).
    function transferAdmin(address newAdmin) external onlyAdmin {
        pendingAdmin = newAdmin;
    }

    /// @notice Complete the admin handover from the pending key.
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPending();
        emit AdminChanged(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    /// Unattributed USDC available for the operator to rescue: balance minus every counted bucket.
    function unclaimed() external view returns (uint256) {
        return USDC.balanceOf(address(this)) - dust - heldTotal - stuck;
    }

    // Approve the Vault for exactly this swap and send the funds home as USDT on Asset Hub.
    function _returnToHome(bytes32 home, uint256 amount, bytes calldata cfParameters) private {
        USDC.forceApprove(address(VAULT), amount);
        VAULT.xSwapToken(HOME_CHAIN, abi.encodePacked(home), HOME_TOKEN, USDC, amount, cfParameters);
    }

    // A USDC transfer that returns false instead of reverting, so a blocked payout cannot revert
    // cfReceive. A low-level call is required precisely because it does not propagate the revert.
    function _tryTransfer(address to, uint256 amount) private returns (bool) {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory data) = address(USDC).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        // Only decode a well-formed bool, so any other return data counts as a failed payout rather
        // than reverting on decode, which would break the never-revert guarantee.
        return success && (data.length == 0 || (data.length == 32 && abi.decode(data, (bool))));
    }
}
