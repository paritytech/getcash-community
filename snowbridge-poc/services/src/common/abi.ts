import { parseAbi } from "viem";

export const registryAbi = parseAbi([
  "function relayer() view returns (address)",
  "function paused() view returns (bool)",
  "event RelayerChanged(address relayer)",
]);

export const factoryAbi = parseAbi([
  "function REGISTRY() view returns (address)",
  "function ROUTER() view returns (address)",
  "function predict(bytes32 account, address owner) view returns (address)",
  "function deploy(bytes32 account, address owner) returns (address forwarder)",
  "event ForwarderDeployed(address indexed forwarder, bytes32 indexed account, address indexed owner)",
]);

export const routerAbi = parseAbi([
  "function FACTORY() view returns (address)",
  "function TOKEN() view returns (address)",
  "function xcmHead() view returns (bytes)",
  "function xcmTail() view returns (bytes)",
  "function claimerHead() view returns (bytes)",
  "event Sent(uint256 indexed depositId, bytes32 indexed account, address token, uint256 amount)",
  "error NotForwarder()",
  "error FeesMismatch()",
  "error SecondSendInTransaction()",
]);

export const forwarderAbi = parseAbi([
  "function trigger(address token, uint128 executionFee, uint128 relayerFee) payable",
  "function withdraw(address token, address to, uint256 amount, uint256 deadline, bytes signature)",
  "function withdrawNonce() view returns (uint256)",
  "function withdrawDigest(address token, address to, uint256 amount, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "event Withdrawn(address indexed token, address indexed to, uint256 amount)",
  "error NotRelayerOrOwner()",
  "error IsPaused()",
  "error NothingToForward()",
  "error Expired()",
  "error BadSignature()",
]);

// Router errors surface through the forwarder, so a trigger call decodes against both.
export const triggerAbi = [...forwarderAbi, ...routerAbi] as const;
