import { ethers } from "hardhat";
import {
  ARBITRUM_ONE,
  ARBITRUM_SEPOLIA,
  HOME_CHAIN,
  factoryConfig,
  type SaleVaultProxyNetwork,
} from "../config/networks";

const coder = ethers.AbiCoder.defaultAbiCoder();

// A sale's source chain, the contract never reads it
export const SRC_CHAIN = HOME_CHAIN;
// A deposit channel's CCM carries an empty srcAddress, this is a word longer for headroom
export const SRC_ADDR = "0x1234";
export const BROKER_MAINNET = ARBITRUM_ONE.broker;
export const BROKER_TESTNET = ARBITRUM_SEPOLIA.broker;

// 2100-01-01 in unix seconds, a payment deadline no test reaches
export const FAR_DEADLINE = 4_102_444_800n;

// A 20-byte stand-in for a seller's claimer key address
export function claimerOf(seed: string): string {
  return ethers.getAddress(
    ethers.dataSlice(ethers.keccak256(ethers.toUtf8Bytes("claimer:" + seed)), 12),
  );
}

// The claimer every helper uses unless a test picks another
export const CLAIMER = claimerOf("seller");

// The 192-byte CCM message, abi.encode of six static words
export function encodeMessage(
  ref: string,
  recipient: string,
  committed: bigint,
  home: string,
  deadline: bigint = FAR_DEADLINE,
  claimer: string = CLAIMER,
): string {
  return coder.encode(
    ["bytes32", "address", "uint256", "bytes32", "uint256", "address"],
    [ref, recipient, committed, home, deadline, claimer],
  );
}

export function refOf(id: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(id));
}

// A 32-byte stand-in for an Asset Hub account
export function homeOf(seed: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes("home:" + seed));
}

// The clone args, home then claimer, 52 bytes
export function cloneArgs(home: string, claimer: string): string {
  if (ethers.dataLength(home) !== 32) throw new Error("home must be 32 bytes");
  return ethers.concat([home, ethers.getAddress(claimer)]);
}

export function initcodeHash(implementation: string, home: string, claimer: string): string {
  const args = cloneArgs(home, claimer);
  return ethers.keccak256(
    ethers.concat([
      "0x61",
      ethers.toBeHex(ethers.dataLength(args) + 0x2d, 2),
      "0x3d81600a3d39f3363d3d373d3d3d363d73",
      implementation,
      "0x5af43d82803e903d91602b57fd5bf3",
      args,
    ]),
  );
}

// The CREATE2 salt, keccak256 of the 52-byte clone args
export function proxySalt(home: string, claimer: string): string {
  return ethers.keccak256(cloneArgs(home, claimer));
}

// The proxy address off chain: OZ Clones initcode with home and claimer as args, salted by proxySalt
export function predictProxy(
  factory: string,
  implementation: string,
  home: string,
  claimer: string,
): string {
  return ethers.getCreate2Address(
    factory,
    proxySalt(home, claimer),
    initcodeHash(implementation, home, claimer),
  );
}

// TS mirror of CfParameters.minPriceX128
export function minPriceX128(amount: bigint, floorBps: bigint, feeAllowance: bigint): bigint {
  const minOut = (amount * floorBps) / 10_000n - feeAllowance;
  if (minOut < 0n) throw new Error("min out underflows");
  return (minOut << 128n) / amount;
}

function le(value: bigint, bytes: number): string {
  let hex = "";
  for (let i = 0; i < bytes; i++) {
    hex += ((value >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0");
  }
  return "0x" + hex;
}

// TS mirror of CfParameters.encode
export function encodeCfParameters(
  retryBlocks: number,
  refund: string,
  minPrice: bigint,
  broker: string,
): string {
  return ethers.hexlify(
    ethers.concat([
      "0x01",
      le(BigInt(retryBlocks), 4),
      refund,
      le(minPrice, 32),
      "0x00000000",
      broker,
      "0x0000",
      "0x00",
    ]),
  );
}

// Mainnet numbers on mocked tokens, with a small cap so chunking is reachable
export const TEST_NETWORK: SaleVaultProxyNetwork = {
  ...ARBITRUM_ONE,
  maxReturn: 100_000_000n,
};

export async function deployMocks() {
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const vault = await (await ethers.getContractFactory("MockChainflipVault")).deploy();
  await usdc.mint(await vault.getAddress(), 1_000_000_000_000n);
  return { usdc, vault };
}

export async function deploySystem(overrides: Partial<SaleVaultProxyNetwork> = {}) {
  const [deployer, treasury, recipient, stranger, guardian] = await ethers.getSigners();
  const { usdc, vault } = await deployMocks();
  const net: SaleVaultProxyNetwork = {
    ...TEST_NETWORK,
    vault: await vault.getAddress(),
    usdc: await usdc.getAddress(),
    ...overrides,
  };
  const factory = await (
    await ethers.getContractFactory("SaleVaultProxyFactory")
  ).deploy(factoryConfig(net, treasury.address, guardian.address));
  const implementation = await ethers.getContractAt(
    "SaleVaultProxy",
    await factory.IMPLEMENTATION(),
  );
  return {
    factory,
    implementation,
    usdc,
    vault,
    net,
    deployer,
    treasury,
    recipient,
    stranger,
    guardian,
  };
}

export type System = Awaited<ReturnType<typeof deploySystem>>;

// Delivers through the mock Vault, transfer first then cfReceive, as Chainflip does
export async function deliver(
  s: System,
  message: string,
  amount: bigint,
  opts: { token?: string; gasLimit?: bigint } = {},
) {
  const token = opts.token ?? (await s.usdc.getAddress());
  return s.vault.deliver(
    await s.factory.getAddress(),
    SRC_CHAIN,
    SRC_ADDR,
    message,
    token,
    amount,
    opts.gasLimit === undefined ? {} : { gasLimit: opts.gasLimit },
  );
}

export async function proxyAt(s: System, home: string, claimer: string = CLAIMER) {
  return ethers.getContractAt("SaleVaultProxy", await s.factory.predict(home, claimer));
}

// A sale delivered and settled, returning its proxy
export async function sell(
  s: System,
  id: string,
  committed: bigint,
  amount: bigint,
  recipient?: string,
) {
  const home = homeOf(id);
  await deliver(
    s,
    encodeMessage(refOf(id), recipient ?? s.recipient.address, committed, home),
    amount,
  );
  return { home, proxy: await proxyAt(s, home) };
}
