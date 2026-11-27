import { describe, expect, it } from "vitest";
import { ONE, STRANGER, TRIGGER_KEY, confirmedDeposit, startService } from "./helpers/payout";

describe("payout service: only deposits our trigger key sent", () => {
  it("leaves a deposit a stranger triggered with their own key unfronted, and never asks the pool about it", async () => {
    const { service, ethereum, assetHub, log } = await startService();
    ethereum.sent(1n, 100n * ONE, { signer: STRANGER });
    ethereum.sent(2n, 100n * ONE);
    ethereum.mine(2);

    await service.tick();

    expect(service.record("1")).toMatchObject({ status: "skipped", reason: "not triggered by our key" });
    expect(service.record("2")?.status).toBe("fronted");
    expect(assetHub.frontCalls.map((call) => call.depositId)).toEqual([2n]);
    expect(assetHub.depositQueries.map((query) => query.depositId)).toEqual([2n]);
    expect(service.outstanding()).toBe(100n * ONE - ONE / 1000n - ONE / 10n);
    expect(log.lines.some((line) => line.level === "warn" && line.message.includes("not triggered by the registry relayer"))).toBe(true);
    expect(log.errors()).toHaveLength(0);
  });

  it("does not let strangers fill the outstanding cap", async () => {
    const { service, ethereum, assetHub } = await startService({ maxOutstanding: 150n * ONE });
    for (let id = 1n; id <= 5n; id++) ethereum.sent(id, 100n * ONE, { signer: STRANGER });
    ethereum.sent(6n, 100n * ONE);
    ethereum.mine(2);

    await service.tick();

    expect(["1", "2", "3", "4", "5"].map((id) => service.record(id)?.status)).toEqual(Array(5).fill("skipped"));
    expect(service.record("6")?.status).toBe("fronted");
    expect(assetHub.frontCalls).toHaveLength(1);
  });

  it("fronts when the key that signed was the relayer at that time, even though the registry has rotated since", async () => {
    const { service, ethereum, assetHub } = await startService();
    ethereum.sent(1n, 100n * ONE);
    ethereum.authorities.set("0x0000000000000000000000000000000000000000000000000000000000000001", { signer: STRANGER, relayer: STRANGER });
    ethereum.mine(2);

    await service.tick();

    expect(service.record("1")?.status).toBe("fronted");
    expect(assetHub.frontCalls).toHaveLength(1);
  });

  it("compares the signer with the relayer of that time, so a key that only became relayer later is not ours", async () => {
    const { service, ethereum, assetHub } = await startService();
    ethereum.sent(1n, 100n * ONE);
    ethereum.authorities.set("0x0000000000000000000000000000000000000000000000000000000000000001", { signer: TRIGGER_KEY, relayer: STRANGER });
    ethereum.mine(2);

    await service.tick();

    expect(service.record("1")).toMatchObject({ status: "skipped", reason: "not triggered by our key" });
    expect(assetHub.frontCalls).toHaveLength(0);
  });

  it("does not front while it cannot tell who triggered, and fronts after the node answers", async () => {
    const { service, ethereum, assetHub } = await startService();
    ethereum.authorityFailures = 1;
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();
    expect(service.record("1")).toMatchObject({ status: "queued", attempts: 1 });
    expect(assetHub.frontCalls).toHaveLength(0);

    await service.tick();
    expect(service.record("1")?.status).toBe("fronted");
  });

  it("never fronts a deposit whose trigger cannot be verified, however often it asks", async () => {
    const { service, ethereum, assetHub, log } = await startService({ maxAttempts: 2 });
    ethereum.authorityFailures = 100;
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    for (let pass = 0; pass < 4; pass++) await service.tick();

    expect(assetHub.frontCalls).toHaveLength(0);
    expect(service.record("1")?.status).toBe("failed");
    expect(log.errors().map((line) => line.message)).toEqual(["deposit left unfronted after repeated failures"]);
  });
});
