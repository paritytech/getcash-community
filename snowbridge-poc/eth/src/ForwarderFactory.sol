// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {Forwarder} from "./Forwarder.sol";
import {Registry} from "./Registry.sol";
import {Router} from "./Router.sol";
import {ISnowbridgeGatewayV2} from "./interfaces/IExternal.sol";
import {IForwarderFactory} from "./interfaces/IForwarding.sol";

/// @title ForwarderFactory
/// @notice One forwarder version. It deploys its own router in the constructor, which breaks the factory/router
///         cycle without a setter, so a deposit address commits to the router, the Gateway, the one token and the XCM
///         bytes through this factory's address. A change means a new factory and new deposit addresses.
contract ForwarderFactory is IForwarderFactory {
    Registry public immutable REGISTRY;
    Router public immutable ROUTER;

    mapping(address forwarder => bool) public isForwarder;

    event ForwarderDeployed(address indexed forwarder, bytes32 indexed account, address indexed owner);

    constructor(
        Registry registry,
        ISnowbridgeGatewayV2 gateway,
        address token,
        bytes memory xcmHead,
        bytes memory xcmTail,
        bytes memory claimerHead
    ) {
        REGISTRY = registry;
        ROUTER = new Router(gateway, this, token, xcmHead, xcmTail, claimerHead);
    }

    function predict(bytes32 account, address owner) public view returns (address) {
        return Create2.computeAddress(_salt(account, owner), keccak256(_creationCode(account, owner)));
    }

    /// @notice Deploys the forwarder for `account` and `owner`, or returns the one already deployed. Anyone may
    ///         call it: the address and everything the forwarder can do are fixed by the two values and this factory.
    function deploy(bytes32 account, address owner) external returns (address forwarder) {
        forwarder = predict(account, owner);
        if (forwarder.code.length != 0) return forwarder;

        new Forwarder{salt: _salt(account, owner)}(account, owner);
        isForwarder[forwarder] = true;
        emit ForwarderDeployed(forwarder, account, owner);
    }

    function _salt(bytes32 account, address owner) private pure returns (bytes32) {
        return keccak256(abi.encode(account, owner));
    }

    function _creationCode(bytes32 account, address owner) private pure returns (bytes memory) {
        return bytes.concat(type(Forwarder).creationCode, abi.encode(account, owner));
    }
}
