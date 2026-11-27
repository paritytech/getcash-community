import "./quietPolkadot";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, formatUnits, keccak256, type Abi, type Address, type Hex } from "viem";
import { connect, devKeyring } from "../../assethub/src/chain";
import { deployerClient } from "../../assethub/src/ethereum";
import { callView, foreignBalance } from "../../assethub/src/revive";
import { loadForwarderCreationCode } from "../../services/src/common/artifacts";
import type { DepositRecord } from "../../services/src/payout/store";
import { connect as connectEthereum, deriveUser, getDeposits, predictDepositAddress, registerDeposit, sendTokens, type User } from "../../services/src/user";
import { acceptedIn } from "./gateway";
import { publicClient, sendEth, tokenAbi, waitFor } from "./chains";
import { ASSET_HUB_WS, ETHEREUM_RPC } from "./config";
import { readDeployment, type E2eDeployment } from "./deployment";
import { readKeys, identities, type Keys } from "./keys";
import { freePort, startService, type ManagedProcess } from "./procs";
import type { Scenario } from "./report";
import { signWithRetry, type Api } from "./substrate";
import { PoolWatcher, poolAbi, type PoolEvent } from "./watcher";

export const ONE = 10n ** 18n;
export const FRONT_FEE_BPS = 10n;
export const MAX_PER_DEPOSIT = 150n * ONE;
export const MAX_OUTSTANDING = 400n * ONE;
export const USER_WND = 50_000_000_000n;
export const USER_ETH = 10n ** 16n;
export const FRONT_TIMEOUT_MS = 120_000;
export const FRONTED_WITHIN_MS = 60_000;
export const DELIVERY_TIMEOUT_MS = 10 * 60_000;

export const erc20 = (value: bigint) => formatUnits(value, 18);
export const seconds = (ms: number | undefined) => (ms === undefined ? "-" : (ms / 1000).toFixed(1));
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type Ctx = {
  dep: E2eDeployment;
  keys: Keys;
  api: Api;
  watcher: PoolWatcher;
  abi: Abi;
  runId: string;
  runDir: string;
  triggerUrl: string;
  payoutUrl: string;
  triggerEnvFile: string;
  trigger: ManagedProcess;
  payout: ManagedProcess;
  payerAccount: Hex;
};

export type Deposit = {
  name: string;
  amount: bigint;
  user: User;
  ss58: string;
  account: Hex;
  forwarder: Address;
  depositId: bigint;
  submittedAt: number;
  transferTx: Hex;
  ethBlock: bigint;
  nonce?: bigint;
  triggerTx?: Hex;
};

// Every use of the deployer key goes through here: two transactions with one nonce would collide.
let deployerQueue: Promise<unknown> = Promise.resolve();
export function withDeployer<T>(job: () => Promise<T>): Promise<T> {
  const run = deployerQueue.then(job, job);
  deployerQueue = run.catch(() => undefined);
  return run;
}

export const triggerEnvText = (key: Hex) => `TRIGGER_KEY=${key}\n`;

// Starts the Asset Hub watcher and both services from source. The trigger key lives only in an env file the trigger service
// re-reads on SIGHUP; the payout service gets neither the key nor a default env file.
export async function createContext(runId: string, runDir: string): Promise<Ctx> {
  mkdirSync(runDir, { recursive: true });
  const dep = readDeployment();
  const keys = readKeys();
  const api = await connect(ASSET_HUB_WS);
  const abi = poolAbi();
  const watcher = new PoolWatcher(api, dep.pool, abi);
  const triggerEnvFile = join(runDir, "trigger.env");
  writeFileSync(triggerEnvFile, triggerEnvText(keys.triggerKey), { mode: 0o600 });
  const noEnvFile = join(runDir, "no-env-file");
  const triggerPort = await freePort();
  const payoutPort = await freePort();
  const trigger = await startService(
    "trigger",
    "src/trigger/main.ts",
    {
      ENV_FILE: triggerEnvFile,
      RPC_URL: ETHEREUM_RPC,
      ASSET_HUB_WS,
      FACTORY_ADDRESS: dep.factory,
      TOKEN_ALLOWLIST: dep.token,
      EXECUTION_FEE_WEI: dep.executionFeeWei,
      RELAYER_FEE_WEI: "0",
      POLL_INTERVAL_MS: "1000",
      STATE_FILE: join(runDir, "trigger-state.json"),
      HTTP_PORT: String(triggerPort),
    },
    join(runDir, "trigger.log"),
    /trigger service listening/,
  );
  const payout = await startService(
    "payout",
    "src/payout/main.ts",
    {
      PAYOUT_ENV_FILE: noEnvFile,
      START_BLOCK: (await publicClient.getBlockNumber()).toString(),
      ETHEREUM_RPC_URL: ETHEREUM_RPC,
      ASSET_HUB_WS,
      ROUTER_ADDRESS: dep.router,
      POOL_ADDRESS: dep.pool,
      TOKEN_ADDRESS: dep.token,
      PAYER_SEED: keys.payerSeed,
      CONFIRMATIONS: "2",
      FRONT_FEE_BPS: FRONT_FEE_BPS.toString(),
      MAX_PER_DEPOSIT: MAX_PER_DEPOSIT.toString(),
      MAX_OUTSTANDING: MAX_OUTSTANDING.toString(),
      POLL_INTERVAL_MS: "1000",
      STATE_FILE: join(runDir, "payout-state.json"),
      HTTP_PORT: String(payoutPort),
    },
    join(runDir, "payout.log"),
    /payout service listening/,
  ).catch(async (error: unknown) => {
    await trigger.stop();
    throw error;
  });
  await watcher.start();
  return {
    dep,
    keys,
    api,
    watcher,
    abi,
    runId,
    runDir,
    triggerUrl: `http://127.0.0.1:${triggerPort}`,
    payoutUrl: `http://127.0.0.1:${payoutPort}`,
    triggerEnvFile,
    trigger,
    payout,
    payerAccount: identities(keys).payer.account,
  };
}

export async function closeContext(ctx: Ctx): Promise<void> {
  await ctx.watcher.stop();
  await Promise.all([ctx.trigger.stop(), ctx.payout.stop()]);
  await ctx.api.disconnect();
}

async function view<T>(ctx: Ctx, functionName: string, args: unknown[]): Promise<T> {
  const data = encodeFunctionData({ abi: ctx.abi, functionName, args } as never);
  return BigInt(await callView(ctx.api, ctx.payerAccount, ctx.dep.pool, data)) as T;
}
export const poolFunds = (ctx: Ctx, holder: Address = ctx.dep.payer.h160) => view<bigint>(ctx, "funds", [holder, ctx.dep.token]);
export const poolOwed = (ctx: Ctx, account: Hex) => view<bigint>(ctx, "owed", [account, ctx.dep.token]);
export const balanceOf = (ctx: Ctx, ss58: string) => foreignBalance(ctx.api, ctx.dep.token, ss58);

// The pool's own record of a deposit: 0 none, 1 fronted, 2 settled, and whoever fronted exactly these parameters.
export async function poolState(ctx: Ctx, depositId: bigint, account: Hex, amount: bigint): Promise<{ status: number; payer: Address }> {
  const data = encodeFunctionData({ abi: ctx.abi, functionName: "state", args: [depositId, account, ctx.dep.token, amount] } as never);
  const output = await callView(ctx.api, ctx.payerAccount, ctx.dep.pool, data);
  return { status: Number(BigInt(`0x${output.slice(2, 66)}`)), payer: `0x${output.slice(90, 130)}` as Address };
}

export async function payoutRecord(ctx: Ctx, depositId: bigint): Promise<DepositRecord | undefined> {
  const response = await fetch(`${ctx.payoutUrl}/deposits/${depositId}`);
  return response.ok ? ((await response.json()) as DepositRecord) : undefined;
}

export async function payoutStatus(ctx: Ctx) {
  return (await (await fetch(`${ctx.payoutUrl}/status`)).json()) as { counts: Record<string, number>; caps: { outstanding: string }; unrepaid: unknown[]; payerFunds?: string };
}

export async function triggerStatus(ctx: Ctx) {
  return (await (await fetch(`${ctx.triggerUrl}/status`)).json()) as { state: string; triggerAddress: Address; registryRelayer?: Address; lastTickAt?: string; lastError?: string };
}

// The service only reports "running" after a tick has read the registry and found its key to be registry.relayer().
export async function awaitTriggerRunning(ctx: Ctx, s: Scenario, expected: Address): Promise<void> {
  const status = await waitFor("the trigger service to check its key", async () => {
    const current = await triggerStatus(ctx);
    return current.state === "running" && current.lastTickAt !== undefined && current;
  }, 30_000, 250);
  s.check("the trigger service runs with the registry's relayer key", same(status.triggerAddress, expected) && same(status.registryRelayer ?? "", expected), `${status.state}, key ${status.triggerAddress}`);
}

// The phone stand-in derives the user and the deposit address and registers it; the user's token transfer is the only thing sent to the chain from it.
export async function startDeposit(ctx: Ctx, name: string, amount: bigint, options: { accountExists?: boolean; register?: boolean } = {}): Promise<Deposit> {
  const { accountExists = true, register = true } = options;
  const user = deriveUser(`e2e-${ctx.runId}-${name}`);
  if (accountExists) await signWithRetry(ctx.api, () => ctx.api.tx.balances.transferKeepAlive(user.assetHubAddress, USER_WND), devKeyring("//Alice"));

  const forwarder = predictDepositAddress({ factory: ctx.dep.factory, account: user.assetHubAccount, owner: user.owner.address, creationCode: loadForwarderCreationCode() });
  if (register) await registerDeposit(ctx.triggerUrl, { account: user.assetHubAccount, owner: user.owner.address, address: forwarder });
  await fundOwner(ctx, user.owner.address, amount);

  const connection = await connectEthereum(ETHEREUM_RPC, user.owner);
  const submittedAt = Date.now();
  const transferTx = await sendTokens(connection, ctx.dep.token, forwarder, amount);
  const receipt = await publicClient.getTransactionReceipt({ hash: transferTx });
  const depositId = BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [forwarder, 1n])));
  console.log(`  ${name}: user ${user.assetHubAddress}, deposit address ${forwarder}, ${erc20(amount)} TEST sent (tx ${transferTx}, block ${receipt.blockNumber}), deposit id ${depositId}`);
  return { name, amount, user, ss58: user.assetHubAddress, account: user.assetHubAccount, forwarder, depositId, submittedAt, transferTx, ethBlock: receipt.blockNumber };
}

// Gives an Ethereum account gas money and `amount` TEST, both from the deployer, which is the token's minter.
export async function fundOwner(ctx: Ctx, owner: Address, amount: bigint): Promise<void> {
  await withDeployer(async () => {
    const { wallet } = deployerClient();
    await sendEth(wallet, owner, USER_ETH);
    if (amount === 0n) return;
    const minted = await wallet.writeContract({ address: ctx.dep.token, abi: tokenAbi, functionName: "mint", args: [owner, amount] } as never);
    await publicClient.waitForTransactionReceipt({ hash: minted });
  });
}

export async function awaitTrigger(ctx: Ctx, s: Scenario, d: Deposit): Promise<void> {
  const record = await waitFor(`the trigger of ${d.name}`, async () => (await getDeposits(ctx.triggerUrl, d.forwarder)).deposits[0], 90_000, 300);
  s.time(`${d.name}: trigger sent`, new Date(record.triggeredAt).getTime() - d.submittedAt);
  s.ref(`${d.name}: trigger tx`, record.txHash);
  s.ref(`${d.name}: trigger Ethereum block`, record.blockNumber);
  s.check(`${d.name}: the trigger service recorded the expected deposit id`, record.depositId === d.depositId.toString(), record.depositId);

  const accepted = acceptedIn(await publicClient.getTransactionReceipt({ hash: record.txHash }), ctx.dep.gateway);
  d.nonce = accepted.nonce;
  d.triggerTx = record.txHash;
  s.ref(`${d.name}: Gateway nonce`, accepted.nonce);
  s.check(`${d.name}: the Gateway message has the router as origin and relayer fee 0`, same(accepted.origin, ctx.dep.router) && accepted.relayerFee === 0n, `origin ${accepted.origin}, relayer fee ${accepted.relayerFee}`);
}

export async function awaitSettled(ctx: Ctx, s: Scenario, d: Deposit): Promise<PoolEvent> {
  const settled = await ctx.watcher.waitFor("Settled", d.depositId, DELIVERY_TIMEOUT_MS);
  s.time(`${d.name}: settled`, settled.blockTime - d.submittedAt);
  s.ref(`${d.name}: Settled Asset Hub block`, settled.blockNumber);
  s.ref(`${d.name}: Settled block hash`, settled.blockHash);
  return settled;
}

export async function userBalanceAbove(ctx: Ctx, ss58: string, floor: bigint, timeoutMs: number): Promise<bigint> {
  return waitFor(`the balance of ${ss58}`, async () => {
    const held = await balanceOf(ctx, ss58);
    return held > floor && held;
  }, timeoutMs, 250);
}
