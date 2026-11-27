// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {IXcm, XCM_PRECOMPILE} from "./interfaces/IXcm.sol";

/// Pays an Ethereum ERC-20 held as a foreign asset to an `AccountId32` with an XCM `TransferAsset` from this contract.
library XcmTransfer {
    error ValueExceedsU128();

    function transfer(uint64 chainId, address token, uint256 amount, bytes32 account) internal {
        bytes memory message = encode(chainId, token, amount, account);
        IXcm.Weight memory weight = IXcm(XCM_PRECOMPILE).weighMessage(message);
        IXcm(XCM_PRECOMPILE).execute(message, weight);
    }

    /// Same payout as `transfer` that reports failure instead of reverting. It never reverts itself.
    function tryTransfer(uint64 chainId, address token, uint256 amount, bytes32 account) internal returns (bool) {
        if (amount >> 128 != 0) return false;
        bytes memory message = encode(chainId, token, amount, account);
        (bool weighed, bytes memory weighedWeight) =
            XCM_PRECOMPILE.staticcall(abi.encodeCall(IXcm.weighMessage, (message)));
        if (!weighed || weighedWeight.length != 64) return false;
        (uint256 refTime, uint256 proofSize) = abi.decode(weighedWeight, (uint256, uint256));
        if (refTime > type(uint64).max || proofSize > type(uint64).max) return false;
        IXcm.Weight memory weight = IXcm.Weight({refTime: uint64(refTime), proofSize: uint64(proofSize)});
        (bool executed,) = XCM_PRECOMPILE.call(abi.encodeCall(IXcm.execute, (message, weight)));
        return executed;
    }

    function encode(uint64 chainId, address token, uint256 amount, bytes32 account)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            hex"05040404", // V5, one instruction, TransferAsset, one asset
            hex"02020907", // parents 2, X2, GlobalConsensus, Ethereum
            compact(chainId),
            hex"0300", // AccountKey20 with no network
            token,
            hex"00", // Fungible
            compact(amount),
            hex"00010100", // beneficiary: parents 0, X1, AccountId32 with no network
            account
        );
    }

    function compact(uint256 value) internal pure returns (bytes memory) {
        if (value < 1 << 6) return littleEndian(value << 2, 1);
        if (value < 1 << 14) return littleEndian((value << 2) | 1, 2);
        if (value < 1 << 30) return littleEndian((value << 2) | 2, 4);
        if (value >= 1 << 128) revert ValueExceedsU128();
        uint256 length = 4;
        while ((value >> (8 * length)) != 0) ++length;
        return abi.encodePacked(bytes1(uint8(((length - 4) << 2) | 3)), littleEndian(value, length));
    }

    function littleEndian(uint256 value, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i; i < length; ++i) {
            out[i] = bytes1(uint8(value >> (8 * i)));
        }
    }
}
