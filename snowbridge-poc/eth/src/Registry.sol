// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Registry
/// @notice Keys and the brake shared by every forwarder version. Nothing here names a bridge, a token or a
///         destination, so whoever controls it can stop forwarding but never redirect a deposit.
contract Registry {
    address public admin;
    /// @notice The trigger key.
    address public relayer;
    address public guardian;
    bool public paused;

    event AdminChanged(address admin);
    event RelayerChanged(address relayer);
    event GuardianChanged(address guardian);
    event Paused(bool paused);

    error OnlyAdmin();
    error OnlyGuardian();
    error ZeroAddress();

    constructor(address admin_, address relayer_, address guardian_) {
        _setAdmin(admin_);
        _setRelayer(relayer_);
        _setGuardian(guardian_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert OnlyGuardian();
        _;
    }

    function setAdmin(address admin_) external onlyAdmin {
        _setAdmin(admin_);
    }

    function setRelayer(address relayer_) external onlyAdmin {
        _setRelayer(relayer_);
    }

    function setGuardian(address guardian_) external onlyAdmin {
        _setGuardian(guardian_);
    }

    function setPaused(bool paused_) external onlyGuardian {
        paused = paused_;
        emit Paused(paused_);
    }

    function _setAdmin(address admin_) private {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        emit AdminChanged(admin_);
    }

    function _setRelayer(address relayer_) private {
        if (relayer_ == address(0)) revert ZeroAddress();
        relayer = relayer_;
        emit RelayerChanged(relayer_);
    }

    function _setGuardian(address guardian_) private {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianChanged(guardian_);
    }
}
