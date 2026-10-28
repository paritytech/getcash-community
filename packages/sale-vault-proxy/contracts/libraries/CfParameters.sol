// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

// Builds the Chainflip cfParameters a SaleVaultProxy return carries, byte for byte as the swap backend encodes them
library CfParameters {
    /// Basis point denominator of a price floor.
    uint256 internal constant BPS = 10_000;

    /// V1 vault swap params for an EVM source with no CCM, LPP None, no DCA, boost 0, fee 0, no affiliates
    function encode(
        uint32 retryBlocks,
        address refund,
        uint256 minPrice,
        bytes32 broker
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                bytes1(0x01), // VersionedCfParameters V1
                _le32(retryBlocks),
                refund, // 20 raw bytes
                _le256(minPrice),
                bytes4(0x00000000), // refund CCM None, LPP None, DCA None, boost 0
                broker,
                bytes2(0x0000), // broker fee bps
                bytes1(0x00) // no affiliates, compact(0)
            );
    }

    /// Floor price of the whole amount less a fixed fee allowance, as X128
    function minPriceX128(
        uint256 amount,
        uint256 floorBps,
        uint256 feeAllowance
    ) internal pure returns (uint256) {
        uint256 minOut = (amount * floorBps) / BPS - feeAllowance;
        return (minOut << 128) / amount;
    }

    // u32 to little-endian bytes
    function _le32(uint32 x) private pure returns (bytes4) {
        x = ((x & 0xFF00FF00) >> 8) | ((x & 0x00FF00FF) << 8);
        return bytes4((x >> 16) | (x << 16));
    }

    // u256 to little-endian bytes
    function _le256(uint256 v) private pure returns (bytes32) {
        v =
            ((v & 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00) >> 8) |
            ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        v =
            ((v & 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000) >> 16) |
            ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        v =
            ((v & 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000) >> 32) |
            ((v & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);
        v =
            ((v & 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000) >> 64) |
            ((v & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) << 64);
        return bytes32((v >> 128) | (v << 128));
    }
}
