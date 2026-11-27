import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { Store } from "../src/trigger/store";
import { startAnvil, type Anvil } from "./helpers/anvil";
import { newDepositor } from "./helpers/depositor";
import { startHarness, type Harness, type HarnessOptions } from "./helpers/harness";
import { EXECUTION_FEE, deployStack, gatewayCalls, mintTo, tokenBalance, type Stack } from "./helpers/stack";

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

async function setup(overrides: Parameters<typeof startHarness>[1] = {}, options: HarnessOptions = {}) {
  const stack = await deployStack(anvil.url);
  const harness = await startHarness(stack, overrides, stack.trigger.key, options);
  open.push(harness);
  return { stack, harness };
}

const triggerTxCount = (stack: Stack) => stack.publicClient.getTransactionCount({ address: stack.trigger.account.address });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("minimum trigger amount", () => {
  it("leaves dust in the forwarder, with no deploy and no trigger, and sends it once the balance reaches one token", async () => {
    const { stack, harness } = await setup();
    const dusty = newDepositor(stack, "dusty");
    await dusty.register(harness.baseUrl);
    await dusty.send(stack.token, 999_999n);
    const before = await triggerTxCount(stack);

    await harness.service.tick();
    await harness.service.tick();

    expect(await triggerTxCount(stack)).toBe(before);
    expect(await stack.publicClient.getCode({ address: dusty.deposit })).toBeUndefined();
    expect(await gatewayCalls(stack)).toHaveLength(0);
    expect(harness.source.calls).toHaveLength(1);
    expect(harness.logs.filter((line) => line.message.includes("below the minimum trigger amount"))).toHaveLength(1);

    await dusty.send(stack.token, 1n);
    await harness.service.tick();

    const [call, ...rest] = await gatewayCalls(stack);
    expect(rest).toHaveLength(0);
    expect(call?.amount).toBe(1_000_000n);
  });

  it("takes a configured minimum for all tokens", async () => {
    const { stack, harness } = await setup({ minTriggerAmount: { all: 5_000_000n, perToken: {} } });
    const erin = newDepositor(stack, "min-all");
    await erin.register(harness.baseUrl);
    await erin.send(stack.token, 4_999_999n);

    await harness.service.tick();
    expect(await gatewayCalls(stack)).toHaveLength(0);

    await erin.send(stack.token, 1n);
    await harness.service.tick();
    expect(await gatewayCalls(stack)).toHaveLength(1);
  });

  it("takes a minimum for one token by address, which may be below one token", async () => {
    const stack = await deployStack(anvil.url);
    const harness = await startHarness(stack, { minTriggerAmount: { perToken: { [stack.token.toLowerCase()]: 100n } } });
    open.push(harness);
    const grace = newDepositor(stack, "min-small");
    await grace.register(harness.baseUrl);
    await grace.send(stack.token, 99n);

    await harness.service.tick();
    expect(await gatewayCalls(stack)).toHaveLength(0);

    await grace.send(stack.token, 1n);
    await harness.service.tick();
    expect(await gatewayCalls(stack)).toHaveLength(1);
  });
});

describe("execution fee against the Asset Hub quote", () => {
  it("refuses to deploy or trigger while the configured fee is below the quote plus the margin, and goes ahead once it is not", async () => {
    const { stack, harness } = await setup();
    harness.source.quoteWei = EXECUTION_FEE;
    const heidi = newDepositor(stack, "fee-low");
    await heidi.register(harness.baseUrl);
    await heidi.send(stack.token, 2_000_000n);
    const before = await triggerTxCount(stack);

    await harness.service.tick();

    expect(await triggerTxCount(stack)).toBe(before);
    expect(await stack.publicClient.getCode({ address: heidi.deposit })).toBeUndefined();
    expect(await tokenBalance(stack, stack.token, heidi.deposit)).toBe(2_000_000n);
    const alert = harness.logs.find((line) => line.level === "error" && line.message.includes("execution fee refused"));
    expect(alert?.fields).toMatchObject({ alert: "execution-fee", forwarder: heidi.deposit });
    expect(String(alert?.fields.error)).toContain("below the Asset Hub quote");
    expect(harness.service.status().executionFee).toMatchObject({ configured: EXECUTION_FEE.toString(), quote: EXECUTION_FEE.toString(), required: ((EXECUTION_FEE * 12n) / 10n).toString() });

    harness.source.quoteWei = 300_000_000_000_000n;
    await sleep(150);
    await harness.service.tick();

    expect(await gatewayCalls(stack)).toHaveLength(1);
    expect(await tokenBalance(stack, stack.token, heidi.deposit)).toBe(0n);
  });

  it("keeps triggering on the last good quote for a bounded time while Asset Hub is unreachable, then refuses", async () => {
    const clock = { now: 1_000_000 };
    const { stack, harness } = await setup({ quoteMaxAgeMs: 60_000 }, { now: () => clock.now });
    const people = ["ivan", "judy", "kim"].map((name) => newDepositor(stack, `outage-${name}`));
    for (const person of people) {
      await person.register(harness.baseUrl);
      await person.send(stack.token, 2_000_000n);
    }
    const [first, second, third] = people;

    await harness.service.processToken(harness.store.get(first!.deposit)!, stack.token);
    expect(await gatewayCalls(stack)).toHaveLength(1);

    harness.source.failing = true;
    clock.now += 60_000;
    await harness.service.processToken(harness.store.get(second!.deposit)!, stack.token);
    expect(await gatewayCalls(stack)).toHaveLength(2);

    clock.now += 1;
    await harness.service.processToken(harness.store.get(third!.deposit)!, stack.token);

    expect(await gatewayCalls(stack)).toHaveLength(2);
    expect(await tokenBalance(stack, stack.token, third!.deposit)).toBe(2_000_000n);
    expect(harness.logs.some((line) => line.level === "error" && String(line.fields.error).includes("no execution fee quote from Asset Hub"))).toBe(true);
    expect(harness.service.status().executionFee.quoteError).toBe("asset hub unreachable");
  });

  it("asks for a quote with the deposit's own account, token and amount", async () => {
    const { stack, harness } = await setup();
    const leo = newDepositor(stack, "quote-sample");
    await leo.register(harness.baseUrl);
    await leo.send(stack.token, 7_000_000n);

    await harness.service.tick();

    expect(harness.source.calls.at(-1)).toEqual({ account: leo.user.assetHubAccount, token: stack.token, amount: 7_000_000n });
  });

  it("re-quotes on a schedule even when nothing is deposited", async () => {
    const { harness } = await setup({ quoteIntervalMs: 0 });

    await harness.service.tick();
    await harness.service.tick();

    expect(harness.source.calls).toHaveLength(2);
    expect(harness.service.status().executionFee.quote).toBe(harness.source.quoteWei.toString());
  });

  it("closes the quote source when it stops", async () => {
    const { harness } = await setup();

    await harness.service.stop();

    expect(harness.source.closed).toBe(true);
  });
});

describe("startup checks", () => {
  it("refuses an allowlist entry that is not the router's token", async () => {
    const stack = await deployStack(anvil.url);
    const other = await stack.deployNamed("Mocks", "MockERC20", ["OTHER"]);

    await expect(startHarness(stack, { tokens: [other] })).rejects.toThrow(`TOKEN_ALLOWLIST entry ${other} is not the router's token ${stack.token}`);
    await expect(startHarness(stack, { tokens: [stack.token, other] })).rejects.toThrow("is not the router's token");
  });

  it("refuses to start when it cannot read the token's decimals and no minimum is set", async () => {
    const stack = await deployStack(anvil.url);
    const tether = await stack.deployNamed("Mocks", "MockTether");

    await expect(startHarness(stack, { tokens: [getAddress(tether)] })).rejects.toThrow();
  });

  it("keeps a stored registration that does not match the factory's predict out of the loop and says so", async () => {
    const stack = await deployStack(anvil.url);
    const honest = newDepositor(stack, "honest");
    const lost = newDepositor(stack, "lost");
    const elsewhere = newDepositor(stack, "elsewhere");
    const seed = (file: string) => {
      const store = new Store(file);
      store.register({ account: honest.user.assetHubAccount, owner: honest.user.owner.address, address: honest.deposit });
      store.register({ account: lost.user.assetHubAccount, owner: lost.user.owner.address, address: elsewhere.deposit });
      return store;
    };
    const harness = await startHarness(stack, {}, stack.trigger.key, { store: seed });
    open.push(harness);
    await mintTo(stack, stack.token, elsewhere.deposit, 5_000_000n);
    await honest.send(stack.token, 3_000_000n);

    await harness.service.tick();

    expect(await tokenBalance(stack, stack.token, elsewhere.deposit)).toBe(5_000_000n);
    expect(await stack.publicClient.getCode({ address: lost.deposit })).toBeUndefined();
    const calls = await gatewayCalls(stack);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.amount).toBe(3_000_000n);
    const alert = harness.logs.find((line) => line.level === "error" && line.message.includes("does not match factory.predict"));
    expect(alert?.fields).toMatchObject({ alert: "registration-mismatch", address: elsewhere.deposit, predicted: lost.deposit });
    expect(harness.service.status()).toMatchObject({ registrations: 1, quarantined: 1 });
  });
});
