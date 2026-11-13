// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title QuarantineTreasury, holds USDC a SaleVaultProxyFactory could not attribute, apart from skimmed dust
/// @notice The factory is the only caller. It pushes a bad delivery's USDC here with a labelled record, and
///         later moves it out on the factory's instruction. Skimmed dust goes to a different treasury address,
///         so this contract only ever holds quarantined funds and never mixes them with anything else.
contract QuarantineTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// The sale USDC, the only token this contract ever holds.
    IERC20 public immutable USDC;
    /// The SaleVaultProxyFactory that books and recovers, the only caller.
    address public immutable FACTORY;

    /// A quarantined delivery, labelled so the record alone says what it was.
    struct Entry {
        uint256 amount; // USDC held, 0 once recovered
        bytes32 reason; // why unattributable: "message", "home" or "claimer"
        bytes32 ref; // the sale's fundingRequestId when the message decoded, else 0
        bytes32 tag; // keccak256(message), the delivery's fingerprint for off-chain match
    }

    /// Each quarantined delivery by the factory's rising id, read one id to see the whole record.
    mapping(uint256 => Entry) public held;
    /// Sum of every amount still held, equal to or below this contract's USDC balance.
    uint256 public total;

    error NotFactory();

    constructor(IERC20 usdc, address factory) {
        USDC = usdc;
        FACTORY = factory;
    }

    /// @notice Pull a bad delivery's USDC from the factory and record it under its id. Factory only.
    /// @dev The factory calls this inside a try/catch, so a revert here never strands the delivery.
    function quarantine(uint256 id, uint256 amount, bytes32 reason, bytes32 ref, bytes32 tag) external {
        if (msg.sender != FACTORY) revert NotFactory();
        held[id] = Entry({amount: amount, reason: reason, ref: ref, tag: tag});
        unchecked {
            total += amount;
        }
        // Reverts if the factory never approved or the token blocks it, which the factory catches
        USDC.safeTransferFrom(FACTORY, address(this), amount);
    }

    /// @notice Send a held delivery's USDC where the factory decides, keeping the record. Factory only.
    /// @return amount The USDC moved, 0 when this id holds nothing here.
    function recover(uint256 id, address to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != FACTORY) revert NotFactory();
        amount = held[id].amount;
        if (amount == 0) return 0;
        // Keeps the reason, ref and tag as a record, only the amount clears
        held[id].amount = 0;
        total -= amount;
        USDC.safeTransfer(to, amount);
    }
}
