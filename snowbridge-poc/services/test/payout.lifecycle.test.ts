import { describe, expect, it } from "vitest";
import { HttpRequestError } from "viem";
import { BRIDGE_FEE, ONE, confirmedDeposit, startService } from "./helpers/payout";

const net = (amount: bigint) => amount - BRIDGE_FEE;

describe("payout service: reused deposit ids, gave-up deposits, long unsettled fronts", () => {
  it("logs a deposit id that comes back with other fields and keeps the first record", async () => {
    const { service, ethereum, log } = await startService();
    ethereum.sent(1n, 100n * ONE);
    ethereum.mine(1);
    ethereum.sent(1n, 90n * ONE, { txHash: `0x${"99".repeat(32)}` });
    ethereum.mine(2);

    await service.tick();

    expect(service.record("1")?.amount).toBe((100n * ONE).toString());
    const [alert, ...rest] = log.errors();
    expect(rest).toHaveLength(0);
    expect(alert).toMatchObject({ message: "a deposit id was reused with different fields; the first record is kept", fields: { alert: "deposit-id-reused", depositId: "1" } });
    expect(alert?.fields).toMatchObject({ known: { amount: (100n * ONE).toString() }, seen: { amount: (90n * ONE).toString(), ethTx: `0x${"99".repeat(32)}` } });
  });

  it("stays quiet about a deposit it sees again unchanged", async () => {
    const { service, ethereum, log, store } = await startService();
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    await service.tick();

    store.setEthereumCursor(99n);
    await service.tick();

    expect(log.errors()).toHaveLength(0);
    expect(service.records()).toHaveLength(1);
  });

  it("queues a deposit that gave up again on the next healthy pass, and fronts it", async () => {
    const { service, ethereum, assetHub, log } = await startService({ maxAttempts: 2, failedRetryMs: 0 });
    assetHub.failures.deposit = 2;
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();
    await service.tick();
    expect(service.record("1")?.status).toBe("failed");
    expect(log.errors()).toHaveLength(1);

    await service.tick();

    expect(service.record("1")).toMatchObject({ status: "fronted", attempts: 0 });
    expect(assetHub.frontCalls).toHaveLength(1);
    expect(log.lines.some((line) => line.message === "deposit that gave up is queued again")).toBe(true);
  });

  it("does not queue a deposit that gave up again before its wait is over, or while a pass is failing", async () => {
    const { service, ethereum, assetHub } = await startService({ maxAttempts: 1, failedRetryMs: 0 });
    assetHub.failures.deposit = 1;
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    await service.tick();
    expect(service.record("1")?.status).toBe("failed");

    assetHub.failures.blockNumber = 1;
    await service.tick();
    expect(service.record("1")?.status).toBe("failed");
    expect((await service.status()).lastError).toContain("ws connection lost");

    await service.tick();
    expect(service.record("1")?.status).toBe("fronted");

    const waiting = await startService({ maxAttempts: 1, failedRetryMs: 60_000 });
    waiting.assetHub.failures.deposit = 1;
    confirmedDeposit(waiting.ethereum, 1n, 100n * ONE);
    await waiting.service.tick();
    await waiting.service.tick();
    expect(waiting.service.record("1")?.status).toBe("failed");
  });

  describe("unsettled alert", () => {
    const MINUTE = 60_000;

    async function frontedWithClock(minutes = 30) {
      const clock = { now: 1_000_000 };
      const started = await startService({ unsettledAlertMinutes: minutes }, undefined, {}, () => clock.now);
      confirmedDeposit(started.ethereum, 1n, 100n * ONE);
      await started.service.tick();
      return { ...started, clock };
    }
    const alerts = (log: { errors(): { fields: Record<string, unknown> }[] }) => log.errors().filter((line) => line.fields.alert === "unsettled");

    it("raises an error alert once a front is still unsettled the configured minutes after its block was finalized, and repeats it that often", async () => {
      const { service, ethereum, clock, log } = await frontedWithClock(30);
      ethereum.finalized = 50n;
      await service.tick();
      clock.now += 60 * MINUTE;
      await service.tick();
      expect(alerts(log)).toHaveLength(0);

      ethereum.finalized = 200n;
      await service.tick();
      clock.now += 29 * MINUTE;
      await service.tick();
      expect(alerts(log)).toHaveLength(0);

      clock.now += 1 * MINUTE;
      await service.tick();
      expect(alerts(log)).toHaveLength(1);
      expect(alerts(log)[0]?.fields).toMatchObject({ depositId: "1", minutes: 30 });

      clock.now += 10 * MINUTE;
      await service.tick();
      expect(alerts(log)).toHaveLength(1);

      clock.now += 20 * MINUTE;
      await service.tick();
      expect(alerts(log)).toHaveLength(2);
    });

    it("stops once the deposit settles, and is off at zero minutes", async () => {
      const { service, ethereum, assetHub, clock, log } = await frontedWithClock(30);
      ethereum.finalized = 200n;
      await service.tick();
      assetHub.settle(1n, true, net(100n * ONE));
      clock.now += 120 * MINUTE;
      await service.tick();
      expect(alerts(log)).toHaveLength(0);

      const off = await frontedWithClock(0);
      off.ethereum.finalized = 200n;
      await off.service.tick();
      off.clock.now += 600 * MINUTE;
      await off.service.tick();
      expect(alerts(off.log)).toHaveLength(0);
    });
  });
});

describe("payout service: what it reports", () => {
  it("leaves the RPC URL out of a failed attempt's reason and out of the status, using viem's short message", async () => {
    const { service, ethereum, assetHub, log } = await startService();
    assetHub.failWith = new HttpRequestError({ url: "https://rpc.example/v3/secret-key", body: {}, details: "upstream said no" });
    assetHub.failures.deposit = 1;
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();

    expect(service.record("1")?.reason).toBe("HTTP request failed.");
    const everything = JSON.stringify([service.records(), log.lines, await service.status()], (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    expect(everything).not.toContain("secret-key");
  });

  it("puts a URL in a plain error message through the same cut", async () => {
    const { service, ethereum, assetHub } = await startService();
    assetHub.failWith = new Error("socket closed by wss://ah.example/secret-key");
    assetHub.failures.deposit = 1;
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();

    expect(service.record("1")?.reason).toBe("socket closed by wss://ah.example");
  });
});

describe("payout service: shutting down", () => {
  it("does not wait for a front that never completes, and does not count that as a failed attempt", async () => {
    const { service, ethereum, assetHub } = await startService({ pollIntervalMs: 5 });
    assetHub.hangFront = true;
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(assetHub.frontCalls).toHaveLength(1);

    const stopped = await Promise.race([service.stop().then(() => "stopped"), new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000))]);

    expect(stopped).toBe("stopped");
    expect(service.record("1")).toMatchObject({ status: "queued", attempts: 0 });
  });
});
