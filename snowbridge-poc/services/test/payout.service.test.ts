import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DepositStatus } from "../src/payout/abi";
import { PayoutStore } from "../src/payout/store";
import { ACCOUNT, BRIDGE_FEE, confirmedDeposit, ONE, OTHER_PAYER, PAYER, startService, TOKEN } from "./helpers/payout";

const fee100 = BRIDGE_FEE + ONE / 10n;

describe("payout service: fronting", () => {
  it("does not act before the deposit has the configured confirmations", async () => {
    const { service, ethereum, assetHub } = await startService({ confirmations: 2 });
    ethereum.sent(1n, 100n * ONE);

    await service.tick();
    ethereum.mine(1);
    await service.tick();
    expect(service.records()).toHaveLength(0);
    expect(assetHub.frontCalls).toHaveLength(0);

    ethereum.mine(1);
    await service.tick();
    expect(assetHub.frontCalls).toHaveLength(1);
  });

  it("fronts with the bridge fee plus the front fee, inside the pool's cap, and records what it fronted", async () => {
    const { service, ethereum, assetHub } = await startService({ frontFeeBps: 10 });
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();

    expect(assetHub.frontCalls).toEqual([{ depositId: 1n, account: ACCOUNT, token: TOKEN, amount: 100n * ONE, fee: fee100 }]);
    expect(service.record("1")).toMatchObject({
      status: "fronted",
      fee: fee100.toString(),
      payout: (100n * ONE - fee100).toString(),
      front: { extrinsicHash: `0x${"ef".repeat(32)}` },
    });
    expect(service.outstanding()).toBe(100n * ONE - fee100);
  });

  it("clamps a front fee above the pool's cap", async () => {
    const { service, ethereum, assetHub } = await startService({ frontFeeBps: 900 });
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();

    expect(assetHub.frontCalls[0]?.fee).toBe(BRIDGE_FEE + ONE);
  });

  it("leaves a deposit that does not exceed the bridge fee to settle unfronted", async () => {
    const { service, ethereum, assetHub } = await startService();
    confirmedDeposit(ethereum, 1n, BRIDGE_FEE);

    await service.tick();

    expect(assetHub.frontCalls).toHaveLength(0);
    expect(service.record("1")).toMatchObject({ status: "skipped", reason: "deposit does not exceed the bridge fee" });
  });

  it("ignores a token the pool does not carry", async () => {
    const { service, ethereum, assetHub } = await startService();
    ethereum.sent(1n, 100n * ONE, { token: "0x3333333333333333333333333333333333333333" });
    ethereum.mine(2);

    await service.tick();

    expect(assetHub.frontCalls).toHaveLength(0);
    expect(service.record("1")?.status).toBe("skipped");
  });
});

describe("payout service: idempotency", () => {
  it("fronts a deposit once however many passes see it", async () => {
    const { service, ethereum, assetHub } = await startService();
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await Promise.all([service.tick(), service.tick()]);
    await service.tick();
    await service.tick();

    expect(assetHub.frontCalls).toHaveLength(1);
  });

  it("does not front again after a restart on the same state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payout-test-"));
    try {
      const path = join(dir, "state.json");
      const first = await startService({}, new PayoutStore(path));
      confirmedDeposit(first.ethereum, 1n, 100n * ONE);
      await first.service.tick();
      expect(first.assetHub.frontCalls).toHaveLength(1);

      const store = new PayoutStore(path);
      const second = await startService({}, store, { ethereum: first.ethereum.head });
      second.assetHub.onChain = first.assetHub.onChain;
      second.ethereum.sent(1n, 100n * ONE, { blockNumber: 100n });
      store.setEthereumCursor(99n);
      await second.service.tick();

      expect(second.assetHub.frontCalls).toHaveLength(0);
      expect(second.service.record("1")?.status).toBe("fronted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks the pool about exactly the deposit it is about to front, not only its id", async () => {
    const { service, ethereum, assetHub } = await startService();
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();

    expect(assetHub.depositQueries).toEqual([{ depositId: 1n, account: ACCOUNT, token: TOKEN, amount: 100n * ONE }]);
  });

  it("adopts a deposit this payer already fronted when its own state is lost", async () => {
    const { service, ethereum, assetHub } = await startService();
    assetHub.onChain.set(1n, { status: DepositStatus.Fronted, payer: PAYER });
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();

    expect(assetHub.frontCalls).toHaveLength(0);
    expect(service.record("1")?.status).toBe("fronted");
    expect(service.outstanding()).toBe(100n * ONE - fee100);
  });

  it("skips a deposit another payer already fronted", async () => {
    const { service, ethereum, assetHub } = await startService();
    assetHub.onChain.set(1n, { status: DepositStatus.Fronted, payer: OTHER_PAYER });
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();

    expect(assetHub.frontCalls).toHaveLength(0);
    expect(service.record("1")).toMatchObject({ status: "skipped", reason: `already fronted by ${OTHER_PAYER}` });
    expect(service.outstanding()).toBe(0n);
  });

  it("treats losing the race to a stranger's front as someone else fronted, with no retry and no error", async () => {
    const { service, ethereum, assetHub, log } = await startService();
    assetHub.frontOutcome = { kind: "reverted", reason: "AlreadyFronted", error: "AlreadyFronted" };
    assetHub.onFront = ({ depositId }) => void assetHub.onChain.set(depositId, { status: DepositStatus.Fronted, payer: OTHER_PAYER });
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    for (let pass = 0; pass < 4; pass++) await service.tick();

    expect(assetHub.frontCalls).toHaveLength(1);
    expect(service.record("1")).toMatchObject({ status: "skipped", reason: "fronted by someone else first" });
    expect(service.outstanding()).toBe(0n);
    expect(log.errors()).toHaveLength(0);
    expect(log.lines.filter((line) => line.level === "warn")).toHaveLength(0);
  });

  it("skips a deposit that already settled", async () => {
    const { service, ethereum, assetHub } = await startService();
    assetHub.onChain.set(1n, { status: DepositStatus.Settled, payer: OTHER_PAYER });
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();

    expect(assetHub.frontCalls).toHaveLength(0);
    expect(service.record("1")).toMatchObject({ status: "skipped", reason: "already settled" });
  });

  it("reads the chain again before a retry, so a front that landed is not repeated", async () => {
    const { service, ethereum, assetHub } = await startService();
    assetHub.failures.frontAfterApply = 1;
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();
    expect(service.record("1")).toMatchObject({ status: "queued", attempts: 1 });
    await service.tick();

    expect(assetHub.frontCalls).toHaveLength(1);
    expect(service.record("1")?.status).toBe("fronted");
  });
});

describe("payout service: exposure caps", () => {
  it("leaves a deposit above the per-deposit cap unfronted", async () => {
    const { service, ethereum, assetHub } = await startService({ maxPerDeposit: 50n * ONE });
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    ethereum.sent(2n, 40n * ONE);
    ethereum.mine(2);

    await service.tick();

    expect(service.record("1")?.status).toBe("skipped");
    expect(service.record("1")?.reason).toContain("per-deposit cap");
    expect(service.record("2")?.status).toBe("fronted");
    expect(assetHub.frontCalls.map((call) => call.depositId)).toEqual([2n]);
  });

  it("stops fronting at the outstanding cap and resumes when a settlement frees it", async () => {
    const { service, ethereum, assetHub } = await startService({ maxOutstanding: 250n * ONE });
    ethereum.sent(1n, 100n * ONE);
    ethereum.sent(2n, 100n * ONE);
    ethereum.sent(3n, 100n * ONE);
    ethereum.mine(2);

    await service.tick();

    expect(["fronted", "fronted", "skipped"]).toEqual([1n, 2n, 3n].map((id) => service.record(id.toString())?.status));
    expect(service.record("3")?.reason).toContain("outstanding");
    expect(assetHub.frontCalls).toHaveLength(2);

    assetHub.settle(1n, true, 100n * ONE - BRIDGE_FEE);
    ethereum.sent(4n, 100n * ONE);
    ethereum.mine(2);
    await service.tick();

    expect(service.record("1")?.status).toBe("repaid");
    expect(service.record("4")?.status).toBe("fronted");
    expect(service.outstanding()).toBe(2n * (100n * ONE - fee100));
  });

  it("does not front when the payer's pool funds are short", async () => {
    const { service, ethereum, assetHub } = await startService();
    assetHub.funds_ = 10n * ONE;
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();
    await service.tick();

    expect(assetHub.frontCalls).toHaveLength(0);
    expect(service.record("1")).toMatchObject({ status: "skipped" });
    expect(service.record("1")?.reason).toContain("pool funds");
  });
});

describe("payout service: a front that fails", () => {
  it("records a revert once and leaves the deposit to settle unfronted", async () => {
    const { service, ethereum, assetHub, log } = await startService();
    assetHub.frontOutcome = { kind: "reverted", reason: "TransferFailed" };
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    for (let pass = 0; pass < 5; pass++) await service.tick();

    expect(assetHub.frontCalls).toHaveLength(1);
    expect(service.record("1")).toMatchObject({ status: "reverted", reason: "TransferFailed" });
    expect(service.outstanding()).toBe(0n);
    expect(log.errors()).toHaveLength(0);

    assetHub.settle(1n, false, 100n * ONE - BRIDGE_FEE);
    await service.tick();
    expect(service.record("1")).toMatchObject({ status: "reverted", settled: { repaid: false } });
    expect(log.errors()).toHaveLength(0);
  });

  it("gives up after the configured attempts on a transport error", async () => {
    const { service, ethereum, assetHub, log } = await startService({ maxAttempts: 3 });
    assetHub.failures.deposit = 10;
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    for (let pass = 0; pass < 6; pass++) await service.tick();

    expect(assetHub.frontCalls).toHaveLength(0);
    expect(assetHub.failures.deposit).toBe(7);
    expect(service.record("1")).toMatchObject({ status: "failed", attempts: 3 });
    expect(service.record("1")?.reason).toContain("gave up after 3 attempts");
    expect(log.errors().map((line) => line.message)).toEqual(["deposit left unfronted after repeated failures"]);
  });

  it("waits the retry delay between attempts", async () => {
    const { service, ethereum, assetHub } = await startService({ retryDelayMs: 60_000 });
    assetHub.failures.deposit = 1;
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();
    await service.tick();

    expect(service.record("1")).toMatchObject({ status: "queued", attempts: 1 });
    expect(assetHub.failures.deposit).toBe(0);
  });
});

describe("payout service: settlement", () => {
  it("marks a fronted deposit repaid when it settles with repaid true", async () => {
    const { service, ethereum, assetHub, log } = await startService();
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    await service.tick();

    assetHub.settle(1n, true, 100n * ONE - BRIDGE_FEE);
    await service.tick();

    expect(service.record("1")).toMatchObject({ status: "repaid", settled: { repaid: true, to: PAYER, amount: (100n * ONE - BRIDGE_FEE).toString() } });
    expect(service.outstanding()).toBe(0n);
    expect(log.errors()).toHaveLength(0);
    expect((await service.status()).unrepaid).toHaveLength(0);
  });

  it("raises an error-level alert when a fronted deposit settles with repaid false", async () => {
    const { service, ethereum, assetHub, log } = await startService();
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    await service.tick();

    assetHub.settle(1n, false, 100n * ONE - BRIDGE_FEE);
    await service.tick();

    expect(service.record("1")?.status).toBe("unrepaid");
    expect(service.outstanding()).toBe(0n);
    const [alert, ...rest] = log.errors();
    expect(rest).toHaveLength(0);
    expect(alert).toMatchObject({ message: "fronted deposit settled without repayment", fields: { alert: "unrepaid", depositId: "1", amount: (100n * ONE).toString() } });
    expect((await service.status()).unrepaid.map((record) => record.depositId)).toEqual(["1"]);
  });

  it("only annotates a settlement of a deposit it did not front", async () => {
    const { service, ethereum, assetHub, log } = await startService({ maxPerDeposit: 1n });
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    await service.tick();

    assetHub.settle(1n, false, 100n * ONE - BRIDGE_FEE);
    assetHub.settle(99n, false, 5n);
    await service.tick();

    expect(service.record("1")).toMatchObject({ status: "skipped", settled: { repaid: false } });
    expect(service.record("99")).toBeUndefined();
    expect(log.errors()).toHaveLength(0);
  });

  it("recognises a repayment of a front whose result was lost", async () => {
    const { service, ethereum, assetHub } = await startService({ maxAttempts: 1 });
    assetHub.failures.frontAfterApply = 1;
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    await service.tick();
    expect(service.record("1")?.status).toBe("failed");

    assetHub.settle(1n, true, 100n * ONE - BRIDGE_FEE);
    await service.tick();

    expect(service.record("1")?.status).toBe("repaid");
  });

  it("keeps its cursors, so a settlement that happened while it was down is still seen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payout-test-"));
    try {
      const path = join(dir, "state.json");
      const first = await startService({}, new PayoutStore(path));
      confirmedDeposit(first.ethereum, 1n, 100n * ONE);
      await first.service.tick();

      const second = await startService({}, new PayoutStore(path), { assetHub: 520 });
      second.assetHub.settle(1n, true, 100n * ONE - BRIDGE_FEE, 510);
      second.assetHub.head = 520;
      await second.service.tick();

      expect(second.service.record("1")?.status).toBe("repaid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
