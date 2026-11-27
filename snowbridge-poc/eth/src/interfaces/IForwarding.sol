// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IForwarderFactory {
    function isForwarder(address forwarder) external view returns (bool);
}

interface IForwarder {
    function ACCOUNT() external view returns (bytes32);
}
