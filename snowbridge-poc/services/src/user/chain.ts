import { createPublicClient, createWalletClient, erc20Abi, http, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { forwarderAbi } from "../common/abi";
import { resolveChain } from "../common/chain";

export type Connection = Awaited<ReturnType<typeof connect>>;

export async function connect(rpcUrl: string, account: LocalAccount) {
  const chain = await resolveChain(rpcUrl);
  return {
    chainId: chain.id,
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
    walletClient: createWalletClient({ account, chain, transport: http(rpcUrl) }),
  };
}

export async function sendTokens(connection: Connection, token: Address, to: Address, amount: bigint): Promise<Hex> {
  const hash = await connection.walletClient.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  await connection.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export function readWithdrawNonce(connection: Connection, forwarder: Address): Promise<bigint> {
  return connection.publicClient.readContract({ address: forwarder, abi: forwarderAbi, functionName: "withdrawNonce" });
}

export type SignedWithdraw = { token: Address; to: Address; amount: bigint; deadline: bigint; signature: Hex };

export async function submitWithdraw(connection: Connection, forwarder: Address, signed: SignedWithdraw): Promise<Hex> {
  const hash = await connection.walletClient.writeContract({
    address: forwarder,
    abi: forwarderAbi,
    functionName: "withdraw",
    args: [signed.token, signed.to, signed.amount, signed.deadline, signed.signature],
  });
  await connection.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
