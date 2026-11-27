import { createWalletClient, http, isAddressEqual, parseEventLogs, type Address, type Chain, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { factoryAbi, routerAbi, triggerAbi } from "../common/abi";
import type { Logger } from "../common/log";
import type { Config } from "./config";
import type { Registration, Store } from "./store";

export function makeSigner(key: Hex, chain: Chain, rpcUrl: string) {
  const account = privateKeyToAccount(key);
  return { account, walletClient: createWalletClient({ account, chain, transport: http(rpcUrl) }) };
}

export type Signer = ReturnType<typeof makeSigner>;

export type SendContext = { publicClient: PublicClient; config: Config; router: Address; store: Store; log: Logger };

export async function ensureDeployed(ctx: SendContext, signer: Signer, registration: Registration): Promise<void> {
  const code = await ctx.publicClient.getCode({ address: registration.address });
  if (code && code !== "0x") return;

  const hash = await signer.walletClient.writeContract({
    address: ctx.config.factory,
    abi: factoryAbi,
    functionName: "deploy",
    args: [registration.account, registration.owner],
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: ctx.config.receiptTimeoutMs });
  if (receipt.status !== "success") throw new Error(`forwarder deploy transaction ${hash} reverted`);
  ctx.log.info("forwarder deployed", { forwarder: registration.address, txHash: hash });
}

export async function sendTrigger(ctx: SendContext, signer: Signer, registration: Registration, token: Address): Promise<void> {
  const { executionFee, relayerFee } = ctx.config;
  const { request } = await ctx.publicClient.simulateContract({
    account: signer.account,
    address: registration.address,
    abi: triggerAbi,
    functionName: "trigger",
    args: [token, executionFee, relayerFee],
    value: executionFee + relayerFee,
  });
  const hash = await signer.walletClient.writeContract(request);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: ctx.config.receiptTimeoutMs });
  if (receipt.status !== "success") throw new Error(`trigger transaction ${hash} reverted`);
  recordSent(ctx, registration, receipt);
}

function recordSent(ctx: SendContext, registration: Registration, receipt: TransactionReceipt): void {
  const sent = parseEventLogs({
    abi: routerAbi,
    eventName: "Sent",
    logs: receipt.logs.filter((entry) => isAddressEqual(entry.address, ctx.router)),
  });
  if (sent.length === 0) ctx.log.error("trigger mined without a Sent event", { txHash: receipt.transactionHash });

  for (const { args } of sent) {
    const record = {
      depositId: args.depositId.toString(),
      forwarder: registration.address,
      account: args.account,
      token: args.token,
      amount: args.amount.toString(),
      txHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      triggeredAt: new Date().toISOString(),
    };
    ctx.store.recordDeposit(registration.address, record);
    ctx.log.info("deposit sent", record);
  }
}
