// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {IXcm} from "../contracts/interfaces/IXcm.sol";

address constant MOCK_TOKEN = 0x54D6643762E46036b3448659791adAf554225541;
address constant MOCK_TOKEN_ERC20 = 0x0000000100000000000000000000000002200000;

/// Reads the parts of a message built by `XcmTransfer.encode` for chain id 11155111.
library TransferMessage {
    function token(bytes memory message) internal pure returns (address result) {
        // 4 header + 4 location + 4 compact chain id + 2 junction, then the 20 byte token.
        uint256 at = 4 + 4 + 4 + 2;
        for (uint256 i; i < 20; ++i) {
            result = address(uint160(result) << 8 | uint8(message[at + i]));
        }
    }

    function beneficiary(bytes memory message) internal pure returns (bytes32 result) {
        for (uint256 i = message.length - 32; i < message.length; ++i) {
            result = result << 8 | bytes32(uint256(uint8(message[i])));
        }
    }

    function amount(bytes memory message) internal pure returns (uint256 result) {
        // The token and the fungible tag precede the compact amount.
        uint256 at = 4 + 4 + 4 + 2 + 20 + 1;
        uint8 mode = uint8(message[at]) & 3;
        if (mode == 0) return uint8(message[at]) >> 2;
        if (mode == 1) return (uint256(uint8(message[at])) | uint256(uint8(message[at + 1])) << 8) >> 2;
        if (mode == 2) {
            for (uint256 i; i < 4; ++i) result |= uint256(uint8(message[at + i])) << (8 * i);
            return result >> 2;
        }
        uint256 length = (uint8(message[at]) >> 2) + 4;
        for (uint256 i; i < length; ++i) result |= uint256(uint8(message[at + 1 + i])) << (8 * i);
    }
}

/// Records every executed message and takes the paid tokens out of the executing contract's balance.
contract MockXcm {
    bytes[] public messages;
    bool public failing;
    bool public weighFailing;
    mapping(bytes32 account => bool) public failsFor;

    function setFailing(bool value) external {
        failing = value;
    }

    function setWeighFailing(bool value) external {
        weighFailing = value;
    }

    function setFailsFor(bytes32 account, bool value) external {
        failsFor[account] = value;
    }

    function messageCount() external view returns (uint256) {
        return messages.length;
    }

    function weighMessage(bytes calldata) external view returns (IXcm.Weight memory) {
        require(!weighFailing, "weigh failed");
        return IXcm.Weight({refTime: 1, proofSize: 2});
    }

    function execute(bytes calldata message, IXcm.Weight calldata) external {
        bytes memory copy = message;
        require(!failing && !failsFor[TransferMessage.beneficiary(copy)], "xcm failed");
        if (TransferMessage.token(copy) == MOCK_TOKEN) {
            MockErc20(MOCK_TOKEN_ERC20).burn(msg.sender, TransferMessage.amount(copy));
        }
        messages.push(message);
    }
}

contract MockErc20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function burn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
