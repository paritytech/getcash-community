import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getAbiItem, parseEventLogs, type Address } from "viem";
import { factoryAbi, routerAbi } from "../src/common/abi";
import { describeConfig } from "../src/trigger/config";
import { Store } from "../src/trigger/store";
import { getDeposits } from "../src/user";
import { startAnvil, type Anvil } from "./helpers/anvil";
import { newDepositor } from "./helpers/depositor";
import { startHarness, type Harness } from "./helpers/harness";
import {
  EXECUTION_FEE,
  callRegistry,
  CLAIMER_HEAD,
  deployStack,
  expectedDepositId,
  expectedXcm,
  gatewayCalls,
  mintTo,
  tokenBalance,
  waitFor,
  type Stack,
} from "./helpers/stack";

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

async function setup(overrides: Parameters<typeof startHarness>[1] = {}) {
  const stack = await deployStack(anvil.url);
  const harness = await startHarness(stack, overrides);
  open.push(harness);
  return { stack, harness };
}

const triggerTxCount = (stack: Stack) => stack.publicClient.getTransactionCount({ address: stack.trigger.account.address });
const errorsContaining = (harness: Harness, text: string) =>
  harness.logs.filter((line) => line.level === "error" && line.message.includes(text));

describe("trigger service", () => {
  it("detects a deposit, deploys the forwarder, triggers it and records the deposit id", async () => {
    const { stack, harness } = await setup();
    const alice = newDepositor(stack, "alice");
    await alice.register(harness.baseUrl);
    await alice.send(stack.token, 25_000_000n);
    expect(await stack.publicClient.getCode({ address: alice.deposit })).toBeUndefined();

    await harness.service.tick();

    expect(await stack.publicClient.getCode({ address: alice.deposit })).toBeDefined();
    expect(await tokenBalance(stack, stack.token, alice.deposit)).toBe(0n);

    const depositId = expectedDepositId(alice.deposit, 1n);
    const [call, ...rest] = await gatewayCalls(stack);
    expect(rest).toHaveLength(0);
    expect(call).toMatchObject({
      sender: stack.router,
      token: stack.token,
      amount: 25_000_000n,
      executionFee: EXECUTION_FEE,
      relayerFee: 0n,
      value: EXECUTION_FEE,
    });
    expect(call?.xcm).toBe(expectedXcm(depositId, alice.user.assetHubAccount, stack.token, 25_000_000n));
    expect(call?.claimer).toBe(`${CLAIMER_HEAD}${alice.user.assetHubAccount.slice(2)}`);

    const view = await getDeposits(harness.baseUrl, alice.deposit);
    expect(view.deposits).toHaveLength(1);
    expect(view.deposits[0]).toMatchObject({
      depositId: depositId.toString(),
      forwarder: alice.deposit,
      account: alice.user.assetHubAccount,
      token: stack.token,
      amount: "25000000",
    });

    const receipt = await stack.publicClient.getTransactionReceipt({ hash: view.deposits[0]!.txHash });
    const [sent] = parseEventLogs({ abi: routerAbi, eventName: "Sent", logs: receipt.logs });
    expect(sent?.args.depositId).toBe(depositId);
    expect(receipt.from.toLowerCase()).toBe(stack.trigger.account.address.toLowerCase());
  });

  it("never triggers a token that is not allowlisted", async () => {
    const { stack, harness } = await setup();
    const bob = newDepositor(stack, "bob");
    await bob.register(harness.baseUrl);
    const other = await stack.deployNamed("Mocks", "MockERC20", ["OTHER"]);
    const hook = await stack.deployNamed("Mocks", "HookToken");
    await mintTo(stack, other, bob.deposit, 5_000_000n);
    await mintTo(stack, hook, bob.deposit, 5_000_000n);
    const before = await triggerTxCount(stack);

    await harness.service.tick();

    expect(await triggerTxCount(stack)).toBe(before);
    expect(await stack.publicClient.getCode({ address: bob.deposit })).toBeUndefined();
    expect(await gatewayCalls(stack)).toHaveLength(0);
    const registration = harness.store.get(bob.deposit)!;
    await expect(harness.service.processToken(registration, other)).rejects.toThrow("not allowlisted");
    await expect(harness.service.processToken(registration, hook)).rejects.toThrow("not allowlisted");

    await bob.send(stack.token, 1_000_000n);
    await harness.service.tick();

    const [call, ...rest] = await gatewayCalls(stack);
    expect(rest).toHaveLength(0);
    expect(call?.token).toBe(stack.token);
    expect(await tokenBalance(stack, other, bob.deposit)).toBe(5_000_000n);
    expect(await tokenBalance(stack, hook, bob.deposit)).toBe(5_000_000n);
  });

  it("gives a second deposit to the same forwarder the next id, without deploying again", async () => {
    const { stack, harness } = await setup();
    const carol = newDepositor(stack, "carol");
    const dave = newDepositor(stack, "dave");
    await carol.register(harness.baseUrl);
    await dave.register(harness.baseUrl);

    await carol.send(stack.token, 10_000_000n);
    await dave.send(stack.token, 7_000_000n);
    await harness.service.tick();
    await carol.send(stack.token, 3_000_000n);
    await harness.service.tick();

    const carolDeposits = (await getDeposits(harness.baseUrl, carol.deposit)).deposits;
    expect(carolDeposits.map((deposit) => deposit.depositId)).toEqual([
      expectedDepositId(carol.deposit, 1n).toString(),
      expectedDepositId(carol.deposit, 2n).toString(),
    ]);
    expect(carolDeposits.map((deposit) => deposit.amount)).toEqual(["10000000", "3000000"]);
    const daveDeposits = (await getDeposits(harness.baseUrl, dave.deposit)).deposits;
    expect(daveDeposits.map((deposit) => deposit.depositId)).toEqual([expectedDepositId(dave.deposit, 1n).toString()]);

    expect(await gatewayCalls(stack)).toHaveLength(3);
    const deployed = await stack.publicClient.getLogs({
      address: stack.factory,
      event: getAbiItem({ abi: factoryAbi, name: "ForwarderDeployed" }),
      fromBlock: 0n,
    });
    expect(deployed).toHaveLength(2);
  });

  it("stops instead of reverting when the registry relayer is rotated, and resumes with the new key", async () => {
    const { stack, harness } = await setup();
    const erin = newDepositor(stack, "erin");
    await erin.register(harness.baseUrl);
    await erin.send(stack.token, 4_000_000n);
    await harness.service.tick();
    expect(harness.service.status().state).toBe("running");

    const newKey = await stack.newWallet();
    await callRegistry(stack, stack.admin, "setRelayer", newKey.account.address);
    await erin.send(stack.token, 6_000_000n);
    const before = await triggerTxCount(stack);

    // A trigger already past the registry check is caught by the simulation.
    await harness.service.processToken(harness.store.get(erin.deposit)!, stack.token);
    expect(harness.service.status().state).toBe("stopped");

    for (let round = 0; round < 3; round++) await harness.service.tick();
    expect(await triggerTxCount(stack)).toBe(before);
    expect(await tokenBalance(stack, stack.token, erin.deposit)).toBe(6_000_000n);
    expect(errorsContaining(harness, "not registry.relayer()")).toHaveLength(1);
    expect(harness.logs.some((line) => line.message === "registry relayer changed")).toBe(true);

    harness.service.setKey(newKey.key);
    await harness.service.tick();

    expect(harness.service.status().state).toBe("running");
    expect(harness.service.triggerAddress).toBe(newKey.account.address);
    const deposits = (await getDeposits(harness.baseUrl, erin.deposit)).deposits;
    expect(deposits.map((deposit) => deposit.depositId)).toEqual([
      expectedDepositId(erin.deposit, 1n).toString(),
      expectedDepositId(erin.deposit, 2n).toString(),
    ]);
    expect(await tokenBalance(stack, stack.token, erin.deposit)).toBe(0n);
  });

  it("stops at the tick when the key is no longer the relayer and resumes when the registry sets it back", async () => {
    const { stack, harness } = await setup();
    const frank = newDepositor(stack, "frank");
    await frank.register(harness.baseUrl);
    const stranger = await stack.newWallet();
    await callRegistry(stack, stack.admin, "setRelayer", stranger.account.address);
    await frank.send(stack.token, 2_000_000n);
    const before = await triggerTxCount(stack);

    await harness.service.tick();
    await harness.service.tick();

    expect(harness.service.status()).toMatchObject({ state: "stopped", registryRelayer: stranger.account.address });
    expect(await triggerTxCount(stack)).toBe(before);
    expect(errorsContaining(harness, "not registry.relayer()")).toHaveLength(1);

    await callRegistry(stack, stack.admin, "setRelayer", stack.trigger.account.address);
    await harness.service.tick();

    expect(harness.service.status().state).toBe("running");
    expect(await gatewayCalls(stack)).toHaveLength(1);
  });

  it("backs off while the registry is paused and triggers again once it is not", async () => {
    const { stack, harness } = await setup();
    const grace = newDepositor(stack, "grace");
    await grace.register(harness.baseUrl);
    await grace.send(stack.token, 1_000_000n);
    await harness.service.tick();
    expect(await gatewayCalls(stack)).toHaveLength(1);

    await callRegistry(stack, stack.guardian, "setPaused", true);
    await grace.send(stack.token, 2_000_000n);
    const before = await triggerTxCount(stack);

    const delays: number[] = [];
    for (let round = 0; round < 4; round++) {
      await harness.service.tick();
      delays.push(harness.service.nextDelayMs());
    }
    expect(harness.service.status().state).toBe("paused");
    expect(delays).toEqual([100, 200, 400, 400]);
    expect(await triggerTxCount(stack)).toBe(before);
    expect(await tokenBalance(stack, stack.token, grace.deposit)).toBe(2_000_000n);

    await callRegistry(stack, stack.guardian, "setPaused", false);
    await harness.service.tick();

    expect(harness.service.status().state).toBe("running");
    expect(harness.service.nextDelayMs()).toBe(harness.config.pollIntervalMs);
    expect(await gatewayCalls(stack)).toHaveLength(2);
  });

  it("backs off when the simulation hits IsPaused", async () => {
    const { stack, harness } = await setup();
    const heidi = newDepositor(stack, "heidi");
    await heidi.register(harness.baseUrl);
    await heidi.send(stack.token, 1_000_000n);
    await harness.service.tick();
    await heidi.send(stack.token, 1_000_000n);
    await callRegistry(stack, stack.guardian, "setPaused", true);
    const before = await triggerTxCount(stack);

    await harness.service.processToken(harness.store.get(heidi.deposit)!, stack.token);

    expect(harness.service.status().state).toBe("paused");
    expect(harness.service.nextDelayMs()).toBeGreaterThan(harness.config.pollIntervalMs);
    expect(await triggerTxCount(stack)).toBe(before);
  });

  it("picks deposits up on its own when started", async () => {
    const { stack, harness } = await setup();
    const ivan = newDepositor(stack, "ivan");
    await ivan.register(harness.baseUrl);
    harness.service.start();

    await ivan.send(stack.token, 9_000_000n);
    const view = await waitFor(async () => {
      const current = await getDeposits(harness.baseUrl, ivan.deposit);
      return current.deposits.length > 0 && current;
    });

    expect(view.deposits[0]?.depositId).toBe(expectedDepositId(ivan.deposit, 1n).toString());
    await harness.service.stop();
  });

  it("does not retry a failing trigger on every tick", async () => {
    const stack = await deployStack(anvil.url);
    // The registry's relayer has no ether, so deploying the forwarder fails.
    const broke = await stack.newWallet("0");
    await callRegistry(stack, stack.admin, "setRelayer", broke.account.address);
    const harness = await startHarness(stack, { pollIntervalMs: 10_000, maxBackoffMs: 60_000 }, broke.key);
    open.push(harness);
    const judy = newDepositor(stack, "judy");
    await judy.register(harness.baseUrl);
    await judy.send(stack.token, 1_000_000n);

    await harness.service.tick();
    await harness.service.tick();

    expect(harness.logs.filter((line) => line.message === "trigger failed")).toHaveLength(1);
    expect(await tokenBalance(stack, stack.token, judy.deposit)).toBe(1_000_000n);
  });

  it("never writes the trigger key to its logs, status or described config", async () => {
    const { stack, harness } = await setup();
    const kim = newDepositor(stack, "kim");
    await kim.register(harness.baseUrl);
    await kim.send(stack.token, 1_000_000n);
    await harness.service.tick();
    await callRegistry(stack, stack.admin, "setRelayer", stack.guardian.account.address);
    await harness.service.tick();

    const everything = JSON.stringify([harness.logs, harness.service.status(), describeConfig(harness.config)], (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(everything).not.toContain(stack.trigger.key.slice(2));
    expect(everything).toContain(harness.service.triggerAddress);
  });
});

describe("trigger service api", () => {
  it("validates registrations and answers for unknown addresses", async () => {
    const { stack, harness } = await setup();
    const leo = newDepositor(stack, "leo");
    const post = (body: unknown) =>
      fetch(`${harness.baseUrl}/deposits`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
    const valid = { account: leo.user.assetHubAccount, owner: leo.user.owner.address, address: leo.deposit };

    expect((await post(valid)).status).toBe(201);
    expect((await post(valid)).status).toBe(200);
    expect((await post({ ...valid, address: newDepositor(stack, "mallory").deposit })).status).toBe(422);
    expect((await post({ ...valid, account: "0x1234" })).status).toBe(400);
    expect((await post({ ...valid, owner: "nope" })).status).toBe(400);
    expect((await post("{")).status).toBe(400);
    expect((await post({ ...valid, padding: "x".repeat(5000) })).status).toBe(413);
    expect((await fetch(`${harness.baseUrl}/deposits/${newDepositor(stack, "nobody").deposit}`)).status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/deposits/not-an-address`)).status).toBe(400);
    expect((await fetch(`${harness.baseUrl}/elsewhere`)).status).toBe(404);
    expect(harness.store.list()).toHaveLength(1);

    const status = (await (await fetch(`${harness.baseUrl}/status`)).json()) as { registrations: number; triggerAddress: Address };
    expect(status).toMatchObject({ registrations: 1, triggerAddress: stack.trigger.account.address });
  });

  it("keeps registrations and deposit records across a restart", async () => {
    const { stack, harness } = await setup();
    const mia = newDepositor(stack, "mia");
    await mia.register(harness.baseUrl);
    await mia.send(stack.token, 1_000_000n);
    await harness.service.tick();

    const reopened = new Store(harness.config.stateFile);
    expect(reopened.list().map((registration) => registration.address)).toEqual([mia.deposit]);
    expect(reopened.deposits(mia.deposit).map((deposit) => deposit.depositId)).toEqual([expectedDepositId(mia.deposit, 1n).toString()]);
  });
});
