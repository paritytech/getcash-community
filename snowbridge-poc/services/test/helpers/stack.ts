import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { factoryAbi } from "../../src/common/abi";
import { loadArtifact } from "../../src/common/artifacts";
import { resolveChain } from "../../src/common/chain";

export const XCM_HEAD: Hex = "0x0510deadbeef0000";
export const XCM_TAIL: Hex = "0xc0ffee0102";
export const CLAIMER_HEAD: Hex = "0x00010100";
export const EXECUTION_FEE = parseEther("0.0005");

export type Wallet = { account: PrivateKeyAccount; key: Hex };

export type Stack = Awaited<ReturnType<typeof deployStack>>;

const mockErc20 = () => loadArtifact("Mocks", "MockERC20");

// Fresh registry, factory, router, mock gateway and token on the given node, with funded admin, trigger key and guardian.
export async function deployStack(rpcUrl: string) {
  const chain = await resolveChain(rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) });

  const newWallet = async (ether = "100"): Promise<Wallet> => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    await testClient.setBalance({ address: account.address, value: parseEther(ether) });
    return { account, key };
  };
  const clientFor = (wallet: Wallet) => createWalletClient({ account: wallet.account, chain, transport: http(rpcUrl) });

  const admin = await newWallet();
  const trigger = await newWallet();
  const guardian = await newWallet();
  const deployer = await newWallet();

  const deploy = async (abi: Abi, bytecode: Hex, args: readonly unknown[] = []): Promise<Address> => {
    const hash = await clientFor(deployer).deployContract({ abi, bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("deployment produced no contract address");
    return getAddress(receipt.contractAddress);
  };
  const deployNamed = (source: string, name: string, args: readonly unknown[] = []) => {
    const artifact = loadArtifact(source, name);
    return deploy(artifact.abi, artifact.bytecode, args);
  };

  const gateway = await deployNamed("Mocks", "MockGateway");
  const registry = await deployNamed("Registry", "Registry", [admin.account.address, trigger.account.address, guardian.account.address]);
  const token = await deployNamed("Mocks", "MockERC20", ["USDC"]);
  const factory = await deployNamed("ForwarderFactory", "ForwarderFactory", [registry, gateway, token, XCM_HEAD, XCM_TAIL, CLAIMER_HEAD]);
  const router = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "ROUTER" });

  return {
    rpcUrl,
    chain,
    publicClient,
    testClient,
    newWallet,
    clientFor,
    deployNamed,
    admin,
    trigger,
    guardian,
    gateway,
    registry,
    factory,
    router,
    token,
  };
}

export async function mintTo(stack: Stack, token: Address, to: Address, amount: bigint): Promise<void> {
  const hash = await stack.clientFor(stack.admin).writeContract({
    address: token,
    abi: mockErc20().abi,
    functionName: "mint",
    args: [to, amount],
  });
  await stack.publicClient.waitForTransactionReceipt({ hash });
}

export async function tokenBalance(stack: Stack, token: Address, who: Address): Promise<bigint> {
  return (await stack.publicClient.readContract({
    address: token,
    abi: mockErc20().abi,
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}

export async function callRegistry(stack: Stack, caller: Wallet, functionName: "setRelayer" | "setPaused", arg: Address | boolean): Promise<void> {
  const hash = await stack.clientFor(caller).writeContract({
    address: stack.registry,
    abi: loadArtifact("Registry", "Registry").abi,
    functionName,
    args: [arg],
  });
  await stack.publicClient.waitForTransactionReceipt({ hash });
}

export type GatewayCall = {
  sender: Address;
  xcm: Hex;
  claimer: Hex;
  token: Address;
  amount: bigint;
  executionFee: bigint;
  relayerFee: bigint;
  value: bigint;
};

export async function gatewayCalls(stack: Stack): Promise<GatewayCall[]> {
  const { abi } = loadArtifact("Mocks", "MockGateway");
  const count = (await stack.publicClient.readContract({ address: stack.gateway, abi, functionName: "callCount" })) as bigint;
  const calls: GatewayCall[] = [];
  for (let index = 0n; index < count; index++) {
    calls.push(
      (await stack.publicClient.readContract({ address: stack.gateway, abi, functionName: "callAt", args: [index] })) as GatewayCall,
    );
  }
  return calls;
}

export function expectedDepositId(forwarder: Address, count: bigint): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [forwarder, count])));
}

export function expectedXcm(depositId: bigint, account: Hex, token: Address, amount: bigint): Hex {
  const body = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [depositId, account, token, amount],
  );
  return `0x${XCM_HEAD.slice(2)}${body.slice(2)}${XCM_TAIL.slice(2)}`;
}

export async function waitFor<T>(read: () => Promise<T | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
