import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { registryAbi } from "../src/common/abi";
import { loadArtifact } from "../src/common/artifacts";
import { viemEthereumClient } from "../src/payout/ethereum";
import { PayoutService } from "../src/payout/service";
import { PayoutStore } from "../src/payout/store";
import { startAnvil, type Anvil } from "./helpers/anvil";
import { newDepositor } from "./helpers/depositor";
import { fundedForwarder, sendTrigger } from "./helpers/forwarders";
import { startHarness, type Harness } from "./helpers/harness";
import { MockAssetHub, ONE, defaultOptions, recordingLogger } from "./helpers/payout";
import { callRegistry, deployStack, type Stack } from "./helpers/stack";

let anvil: Anvil;
const open: Harness[] = [];

beforeAll(async () => {
  anvil = await startAnvil();
});

afterAll(async () => {
  await anvil.stop();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

async function payoutOver(stack: Stack) {
  const ethereum = viemEthereumClient(stack.rpcUrl, stack.router);
  const assetHub = new MockAssetHub();
  const log = recordingLogger();
  const service = await PayoutService.create({ ...defaultOptions, token: stack.token, startBlock: 0n, confirmations: 1 }, new PayoutStore(), ethereum, assetHub, log.logger);
  const settle = async () => {
    await stack.testClient.mine({ blocks: 2 });
    await service.tick();
  };
  return { ethereum, assetHub, log, service, settle };
}

const sentIn = async (stack: Stack) => {
  const client = viemEthereumClient(stack.rpcUrl, stack.router);
  return client.sentEvents(0n, await client.blockNumber());
};

describe("payout against real contracts: who triggered", () => {
  it("fronts a deposit the trigger service sent and leaves a stranger's own forwarder, triggered with their own key, unfronted", async () => {
    const stack = await deployStack(anvil.url);
    const harness = await startHarness(stack);
    open.push(harness);
    const alice = newDepositor(stack, "authority-alice");
    await alice.register(harness.baseUrl);
    await alice.send(stack.token, 25n * ONE);
    await harness.service.tick();

    const stranger = await stack.newWallet();
    const forwarder = await fundedForwarder(stack, stranger, stranger.account.address, "stranger-forwarder", 40n * ONE);
    await sendTrigger(stack, stranger, forwarder);
    const [honest, other] = await sentIn(stack);
    const { ethereum, assetHub, service, settle } = await payoutOver(stack);

    expect(await ethereum.triggerAuthority(honest!)).toEqual({ signer: stack.trigger.account.address, relayer: stack.trigger.account.address });
    expect(await ethereum.triggerAuthority(other!)).toEqual({ signer: stranger.account.address, relayer: stack.trigger.account.address });

    await settle();

    expect(service.record(honest!.depositId.toString())?.status).toBe("fronted");
    expect(service.record(other!.depositId.toString())).toMatchObject({ status: "skipped", reason: "not triggered by our key" });
    expect(assetHub.frontCalls.map((call) => call.depositId)).toEqual([honest!.depositId]);
  });

  it("still fronts a deposit whose key has been rotated out since, because the key was the relayer when it signed", async () => {
    const stack = await deployStack(anvil.url);
    const harness = await startHarness(stack);
    open.push(harness);
    const bob = newDepositor(stack, "authority-bob");
    await bob.register(harness.baseUrl);
    await bob.send(stack.token, 10n * ONE);
    await harness.service.tick();
    const next = await stack.newWallet();
    await callRegistry(stack, stack.admin, "setRelayer", next.account.address);
    const { ethereum, assetHub, service, settle } = await payoutOver(stack);
    const [sent] = await sentIn(stack);

    expect(await stack.publicClient.readContract({ address: stack.registry, abi: registryAbi, functionName: "relayer" })).toBe(next.account.address);
    expect(await ethereum.triggerAuthority(sent!)).toEqual({ signer: stack.trigger.account.address, relayer: stack.trigger.account.address });
    await settle();

    expect(service.record(sent!.depositId.toString())?.status).toBe("fronted");
    expect(assetHub.frontCalls).toHaveLength(1);
  });

  it("does not take an owner who only became the relayer later for the relayer of the time it triggered", async () => {
    const stack = await deployStack(anvil.url);
    const owner = await stack.newWallet();
    const forwarder = await fundedForwarder(stack, owner, owner.account.address, "owner-first", 10n * ONE);
    await sendTrigger(stack, owner, forwarder);
    await callRegistry(stack, stack.admin, "setRelayer", owner.account.address);
    const { ethereum, assetHub, service, settle } = await payoutOver(stack);
    const [sent] = await sentIn(stack);

    expect(await ethereum.triggerAuthority(sent!)).toEqual({ signer: owner.account.address, relayer: stack.trigger.account.address });
    await settle();

    expect(service.record(sent!.depositId.toString())).toMatchObject({ status: "skipped", reason: "not triggered by our key" });
    expect(assetHub.frontCalls).toHaveLength(0);
  });

  it("orders a rotation and a trigger in the same block by transaction index, as the relayer does", async () => {
    const stack = await deployStack(anvil.url);
    const next = await stack.newWallet();
    const third = await stack.newWallet();
    const owner = await stack.newWallet();
    const first = await fundedForwarder(stack, owner, owner.account.address, "block-a", 10n * ONE);
    const second = await fundedForwarder(stack, owner, owner.account.address, "block-b", 10n * ONE);
    const rotate = (to: Address) =>
      stack.clientFor(stack.admin).writeContract({ address: stack.registry, abi: loadArtifact("Registry", "Registry").abi, functionName: "setRelayer", args: [to], gas: 200_000n });

    await stack.testClient.setAutomine(false);
    let sent: Hex[];
    try {
      // Block one: the old key triggers, and only afterwards is the key rotated, so the old key is the one that counts.
      const triggerOne = await sendTrigger(stack, stack.trigger, first, { wait: false });
      const rotateOne = await rotate(next.account.address);
      await stack.testClient.mine({ blocks: 1 });
      // Block two: the key is rotated first, and the new key triggers after it, so the new key is the one that counts.
      const rotateTwo = await rotate(third.account.address);
      const triggerTwo = await sendTrigger(stack, third, second, { wait: false });
      await stack.testClient.mine({ blocks: 1 });
      sent = [triggerOne, rotateOne, rotateTwo, triggerTwo];
    } finally {
      await stack.testClient.setAutomine(true);
    }
    const receipts = await Promise.all(sent.map((hash) => stack.publicClient.getTransactionReceipt({ hash })));
    expect(receipts.map((receipt) => receipt.status)).toEqual(["success", "success", "success", "success"]);
    expect([receipts[0]!.blockNumber === receipts[1]!.blockNumber, receipts[2]!.blockNumber === receipts[3]!.blockNumber]).toEqual([true, true]);
    expect([receipts[0]!.transactionIndex < receipts[1]!.transactionIndex, receipts[2]!.transactionIndex < receipts[3]!.transactionIndex]).toEqual([true, true]);

    const { ethereum } = await payoutOver(stack);
    const [sentOne, sentTwo] = await sentIn(stack);

    expect(await ethereum.triggerAuthority(sentOne!)).toEqual({ signer: stack.trigger.account.address, relayer: stack.trigger.account.address });
    expect(await ethereum.triggerAuthority(sentTwo!)).toEqual({ signer: third.account.address, relayer: third.account.address });
  });

  it("refuses to answer for a transaction that is not in the block the log names, or that does not exist", async () => {
    const stack = await deployStack(anvil.url);
    const owner = await stack.newWallet();
    const forwarder = await fundedForwarder(stack, owner, owner.account.address, "wrong-block", 10n * ONE);
    await sendTrigger(stack, owner, forwarder);
    const { ethereum } = await payoutOver(stack);
    const [sent] = await sentIn(stack);

    await expect(ethereum.triggerAuthority({ txHash: sent!.txHash, blockNumber: sent!.blockNumber + 1n })).rejects.toThrow("is not in block");
    await expect(ethereum.triggerAuthority({ txHash: `0x${"12".repeat(32)}`, blockNumber: sent!.blockNumber })).rejects.toThrow();
  });

  it("reads the finalized block from the node", async () => {
    const stack = await deployStack(anvil.url);
    const ethereum = viemEthereumClient(stack.rpcUrl, stack.router);

    expect(await ethereum.finalizedBlock()).toBeLessThanOrEqual(await ethereum.blockNumber());
  });
});
