import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { ETHEREUM_RPC } from "./config";

export const chain = defineChain({
  id: 11155111,
  name: "local-ethereum",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ETHEREUM_RPC] } },
});

export const publicClient = createPublicClient({ chain, transport: http(ETHEREUM_RPC), pollingInterval: 500 });

export const walletFor = (account: PrivateKeyAccount) => createWalletClient({ chain, account, transport: http(ETHEREUM_RPC) });

export const tokenAbi = parseAbi([
  "function mint(address account, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function gateway() view returns (address)",
]);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(what: string, read: () => Promise<T | undefined | false>, timeoutMs: number, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(intervalMs);
  }
}

export async function sendEth(wallet: { sendTransaction(request: { to: Address; value: bigint }): Promise<Hex> }, to: Address, value: bigint): Promise<Hex> {
  const hash = await wallet.sendTransaction({ to, value });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`ether transfer to ${to} reverted`);
  return hash;
}

export async function freeBalance(api: { query: { system: { account: (account: string) => Promise<unknown> } } }, account: string): Promise<bigint> {
  const info = (await api.query.system.account(account)) as unknown as { data: { free: { toBigInt(): bigint } } };
  return info.data.free.toBigInt();
}
