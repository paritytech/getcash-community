import { readFileSync, writeFileSync } from "node:fs";
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deployerClient } from "../../../assethub/src/ethereum";
import { factoryAbi, forwarderAbi, triggerAbi } from "../../../services/src/common/abi";
import { getDeposits, registerDeposit } from "../../../services/src/user";
import { publicClient, sendEth, sleep, waitFor, walletFor } from "../chains";
import { ONE, awaitSettled, awaitTrigger, balanceOf, erc20, same, startDeposit, triggerEnvText, triggerStatus, withDeployer, type Ctx, type Deposit } from "../harness";
import { RELAYER_CONFIG, ethereumRelayers } from "../relayer";
import type { Scenario } from "../report";
import { oursEvidence, type M3 } from "./evidence";

const setRelayerAbi = parseAbi(["function setRelayer(address relayer)"]);
const K2_ETH = 10n ** 18n;

export type Rotated = { key: Hex; address: Address };

export async function setRegistryRelayer(ctx: Ctx, relayer: Address): Promise<{ hash: Hex; block: bigint }> {
  const admin = walletFor(privateKeyToAccount(ctx.keys.adminKey));
  const hash = await admin.writeContract({ address: ctx.dep.registry, abi: setRelayerAbi, functionName: "setRelayer", args: [relayer] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("setRelayer reverted");
  return { hash, block: receipt.blockNumber };
}

// Points the trigger service at a key through its env file and SIGHUP, and waits until it reports that key as registry.relayer().
export async function switchServiceKey(ctx: Ctx, key: Hex, address: Address): Promise<void> {
  writeFileSync(ctx.triggerEnvFile, triggerEnvText(key), { mode: 0o600 });
  ctx.trigger.signal("SIGHUP");
  await waitFor("the trigger service to run with the new key", async () => {
    const status = await triggerStatus(ctx);
    return status.state === "running" && same(status.triggerAddress, address) && status;
  }, 30_000, 250);
}

async function triggerRevertName(ctx: Ctx, key: Hex, forwarder: Address): Promise<string | undefined> {
  const fee = BigInt(ctx.dep.executionFeeWei);
  try {
    await publicClient.simulateContract({ account: privateKeyToAccount(key), address: forwarder, abi: triggerAbi, functionName: "trigger", args: [ctx.dep.token, fee, 0n], value: fee });
    return undefined;
  } catch (error) {
    const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : undefined;
    return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : String(error);
  }
}

// A trigger sent anyway, with a fixed gas limit so it is mined and reverts on chain.
async function minedRevert(ctx: Ctx, key: Hex, forwarder: Address): Promise<{ hash: Hex; status: string }> {
  const fee = BigInt(ctx.dep.executionFeeWei);
  const data = encodeFunctionData({ abi: forwarderAbi, functionName: "trigger", args: [ctx.dep.token, fee, 0n] });
  const hash = await walletFor(privateKeyToAccount(key)).sendTransaction({ to: forwarder, data, value: fee, gas: 600_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status };
}

// `out.rotated` is set the moment the registry points at K2, so a later failed check cannot hide the rotation from the next scenario.
export async function rotationInFlight(m: M3, s: Scenario, out: { rotated?: Rotated }): Promise<void> {
  const { ctx } = m;
  const k1 = ctx.keys.triggerKey;
  const k2Key = generatePrivateKey();
  const k2 = privateKeyToAccount(k2Key).address;
  const relayersBefore = ethereumRelayers().map((relayer) => relayer.pid).join(",");
  const configBefore = readFileSync(RELAYER_CONFIG, "utf8");
  s.ref("trigger key K1", ctx.dep.trigger);
  s.ref("trigger key K2", k2);

  await withDeployer(async () => void (await sendEth(deployerClient().wallet, k2, K2_ETH)));
  const after = await startDeposit(ctx, "rotation-after", 40n * ONE, { register: false });
  const deployed = await walletFor(privateKeyToAccount(ctx.keys.adminKey)).writeContract({ address: ctx.dep.factory, abi: factoryAbi, functionName: "deploy", args: [after.account, after.user.owner.address] });
  await publicClient.waitForTransactionReceipt({ hash: deployed });

  const inflight = await startDeposit(ctx, "rotation-in-flight", 40n * ONE);
  await awaitTrigger(ctx, s, inflight);
  const sent = (await getDeposits(ctx.triggerUrl, inflight.forwarder)).deposits[0]!;
  const firstSigner = (await publicClient.getTransaction({ hash: inflight.triggerTx! })).from;
  s.check("rotation-in-flight: the first deposit was triggered by K1", same(firstSigner, ctx.dep.trigger), firstSigner);

  const rotation = await setRegistryRelayer(ctx, k2);
  out.rotated = { key: k2Key, address: k2 };
  s.ref("setRelayer(K2) tx", rotation.hash);
  s.ref("setRelayer(K2) Ethereum block", rotation.block);
  s.time("setRelayer after the K1 trigger", Date.now() - new Date(sent.triggeredAt).getTime());
  s.check(
    "the admin rotated to K2 after K1's message was sent and before it was delivered",
    rotation.block > BigInt(sent.blockNumber) && !ctx.watcher.find("Settled", inflight.depositId),
    `trigger block ${sent.blockNumber}, setRelayer block ${rotation.block}`,
  );

  const name = await triggerRevertName(ctx, k1, after.forwarder);
  s.check("a trigger by K1 after the rotation reverts NotRelayerOrOwner", name === "NotRelayerOrOwner", String(name));
  const mined = await minedRevert(ctx, k1, after.forwarder);
  s.ref("K1 trigger after rotation (reverted)", mined.hash);
  s.check("the same trigger, sent anyway, was mined and reverted", mined.status === "reverted", mined.status);

  const stopped = await waitFor("the trigger service to stop", async () => {
    const status = await triggerStatus(ctx);
    return status.state === "stopped" && status;
  }, 30_000, 250);
  s.check("the trigger service stopped on its own, because its key is no longer registry.relayer()", same(stopped.registryRelayer ?? "", k2) && same(stopped.triggerAddress, ctx.dep.trigger), `${stopped.state}, registry relayer ${stopped.registryRelayer}`);
  await registerDeposit(ctx.triggerUrl, { account: after.account, owner: after.user.owner.address, address: after.forwarder });
  await sleep(8_000);
  const idle = (await getDeposits(ctx.triggerUrl, after.forwarder)).deposits.length === 0;
  const held = await balanceOf(ctx, after.ss58);
  s.check("while stopped the service triggered nothing: the registered deposit is still unsent", idle && held === 0n);

  await switchServiceKey(ctx, k2Key, k2);
  s.ref("service resumed with K2", k2);
  await awaitTrigger(ctx, s, after);
  const secondSigner = (await publicClient.getTransaction({ hash: after.triggerTx! })).from;
  s.check("rotation-after: the deposit was triggered by K2 once the service reloaded its key on SIGHUP", same(secondSigner, k2), secondSigner);

  await Promise.all([settleChecks(m, s, inflight), settleChecks(m, s, after)]);
  s.check(
    "the relayer process and its config were untouched during the rotation: no restart, no config change",
    ethereumRelayers().map((relayer) => relayer.pid).join(",") === relayersBefore && readFileSync(RELAYER_CONFIG, "utf8") === configBefore,
    `pid ${relayersBefore}`,
  );
}

async function settleChecks(m: M3, s: Scenario, d: Deposit): Promise<void> {
  const { ctx } = m;
  const bridgeFee = BigInt(ctx.dep.bridgeFee);
  const settled = await awaitSettled(ctx, s, d);
  s.check(`${d.name}: delivered by our relayer, Settled for amount minus bridge fee`, settled.args.amount === d.amount - bridgeFee, `Settled{repaid:${settled.args.repaid}}, Asset Hub block ${settled.blockNumber}`);
  const held = await waitFor(`the user's balance of ${d.name}`, async () => (await balanceOf(ctx, d.ss58)) > 0n && (await balanceOf(ctx, d.ss58)), 30_000);
  s.check(`${d.name}: the user holds the payout`, held > 0n && held <= d.amount - bridgeFee, `${erc20(held)} TEST`);
  await oursEvidence(m, s, d.name, d.nonce!);
  m.delivered.push(d);
}
