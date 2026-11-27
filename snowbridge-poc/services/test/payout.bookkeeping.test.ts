import { describe, expect, it } from "vitest";
import { DepositStatus } from "../src/payout/abi";
import { BRIDGE_FEE, ONE, OTHER_PAYER, PAYER, confirmedDeposit, startService } from "./helpers/payout";

const fee100 = BRIDGE_FEE + ONE / 10n;
const net = (amount: bigint) => amount - BRIDGE_FEE;
const NOBODY = "0x0000000000000000000000000000000000000000";

describe("payout service: a front that was already there", () => {
  it("records its own earlier front as fronted when the pool refuses the repeat, not as someone else's", async () => {
    const { service, ethereum, assetHub, log } = await startService();
    assetHub.frontOutcome = { kind: "reverted", reason: "AlreadyFronted", error: "AlreadyFronted" };
    assetHub.onFront = ({ depositId }) => void assetHub.onChain.set(depositId, { status: DepositStatus.Fronted, payer: PAYER });
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    for (let pass = 0; pass < 3; pass++) await service.tick();

    expect(assetHub.frontCalls).toHaveLength(1);
    expect(service.record("1")).toMatchObject({ status: "fronted", fee: fee100.toString(), payout: (100n * ONE - fee100).toString() });
    expect(service.record("1")?.reason).toBeUndefined();
    expect(service.outstanding()).toBe(100n * ONE - fee100);
    expect(log.errors()).toHaveLength(0);
  });

  it("treats a refusal as already settled and repaid when the pool says this payer fronted it", async () => {
    const { service, ethereum, assetHub } = await startService();
    assetHub.frontOutcome = { kind: "reverted", reason: "AlreadySettled", error: "AlreadySettled" };
    assetHub.onFront = ({ depositId }) => void assetHub.onChain.set(depositId, { status: DepositStatus.Settled, payer: PAYER });
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();

    expect(service.record("1")).toMatchObject({ status: "repaid", settled: { repaid: true, to: PAYER, amount: net(100n * ONE).toString() } });
    expect(service.outstanding()).toBe(0n);
  });

  it("retries instead of guessing when the pool refuses a front it holds no record of", async () => {
    const { service, ethereum, assetHub } = await startService();
    assetHub.frontOutcome = { kind: "reverted", reason: "AlreadyFronted", error: "AlreadyFronted" };
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();

    expect(service.record("1")).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("reads a deposit that settled while the payer was the one that fronted it as repaid", async () => {
    const { service, ethereum, assetHub } = await startService();
    assetHub.onChain.set(1n, { status: DepositStatus.Settled, payer: PAYER });
    confirmedDeposit(ethereum, 1n, 100n * ONE);

    await service.tick();

    expect(assetHub.frontCalls).toHaveLength(0);
    expect(service.record("1")?.status).toBe("repaid");
  });
});

describe("payout service: settlements that do not repay this payer", () => {
  it("raises the unrepaid alert when a front of ours settles with repayment to another payer", async () => {
    const { service, ethereum, assetHub, log } = await startService();
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    await service.tick();

    assetHub.settle(1n, true, net(100n * ONE), undefined, OTHER_PAYER);
    await service.tick();

    expect(service.record("1")?.status).toBe("unrepaid");
    expect(service.outstanding()).toBe(0n);
    const [alert, ...rest] = log.errors();
    expect(rest).toHaveLength(0);
    expect(alert?.fields).toMatchObject({ alert: "unrepaid", depositId: "1", reason: `repaid to ${OTHER_PAYER}, not to this payer` });
    expect((await service.status()).unrepaid.map((record) => record.depositId)).toEqual(["1"]);
  });

  it("only annotates a repayment to another payer for a deposit this payer left alone", async () => {
    const { service, ethereum, assetHub, log } = await startService({ maxPerDeposit: 1n });
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    await service.tick();

    assetHub.settle(1n, true, net(100n * ONE), undefined, OTHER_PAYER);
    await service.tick();

    expect(service.record("1")).toMatchObject({ status: "skipped", settled: { repaid: true, to: OTHER_PAYER } });
    expect(log.errors()).toHaveLength(0);
  });

  it("counts a repayment to this payer as repaid whatever the record said, since the money came back", async () => {
    for (const setup of ["skipped", "queued", "reverted"] as const) {
      const { service, ethereum, assetHub, store } = await startService();
      confirmedDeposit(ethereum, 1n, 100n * ONE);
      await service.tick();
      store.update("1", { status: setup, reason: "fronted by someone else first", payout: undefined });

      assetHub.settle(1n, true, net(100n * ONE), undefined, PAYER);
      await service.tick();

      expect(service.record("1"), setup).toMatchObject({ status: "repaid", settled: { repaid: true, to: PAYER } });
      expect(service.record("1")?.reason).toBeUndefined();
    }
  });

  it("does not report a repaid deposit again when it scans the same settlement twice", async () => {
    const { service, ethereum, assetHub, log, store } = await startService();
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    await service.tick();
    assetHub.settle(1n, true, net(100n * ONE));
    await service.tick();
    const lines = log.lines.length;

    store.setAssetHubCursor(store.assetHubCursor! - 1);
    await service.tick();

    expect(log.lines.slice(lines).filter((line) => line.message === "fronted deposit repaid")).toHaveLength(0);
    expect(service.record("1")?.status).toBe("repaid");
  });
});

describe("payout service: settlement events lost to pruning", () => {
  async function pruned() {
    const started = await startService({}, undefined, { assetHub: 500 });
    confirmedDeposit(started.ethereum, 1n, 100n * ONE);
    confirmedDeposit(started.ethereum, 2n, 100n * ONE);
    confirmedDeposit(started.ethereum, 3n, 100n * ONE);
    await started.service.tick();
    expect(["fronted", "fronted", "fronted"]).toEqual([1, 2, 3].map((id) => started.service.record(String(id))?.status));
    started.assetHub.head = 520;
    started.assetHub.prunedBlocks = [505, 506, 507];
    return started;
  }

  it("alerts, then decides every fronted deposit from the pool's own record: repaid for this payer, an alert for anything else", async () => {
    const { service, assetHub, log, store } = await pruned();
    assetHub.onChain.set(1n, { status: DepositStatus.Settled, payer: PAYER });
    assetHub.onChain.set(2n, { status: DepositStatus.Settled, payer: NOBODY });

    await service.tick();

    const lost = log.errors().find((line) => line.message.includes("pruned"));
    expect(lost?.fields).toMatchObject({ alert: "events-lost", blocks: 3, firstBlock: 505, lastBlock: 507 });
    expect(service.record("1")).toMatchObject({ status: "repaid", settled: { repaid: true, to: PAYER, amount: net(100n * ONE).toString() } });
    expect(service.record("2")?.status).toBe("unrepaid");
    expect(service.record("3")?.status).toBe("fronted");
    expect(log.errors().filter((line) => line.fields.alert === "unrepaid")).toHaveLength(1);
    expect(service.outstanding()).toBe(100n * ONE - fee100);
    expect(store.needsReconcile).toBe(false);
    expect((await service.status()).reconcilePending).toBe(false);
  });

  it("keeps the reconciliation pending until every deposit could be read, across a restart of the pass", async () => {
    const { service, assetHub, store } = await pruned();
    assetHub.onChain.set(1n, { status: DepositStatus.Settled, payer: PAYER });
    assetHub.failures.deposit = 1;

    await service.tick();
    expect(store.needsReconcile).toBe(true);
    expect((await service.status()).reconcilePending).toBe(true);
    expect(service.record("1")?.status).toBe("fronted");

    await service.tick();
    expect(store.needsReconcile).toBe(false);
    expect(service.record("1")?.status).toBe("repaid");
  });

  it("does not read the pool again for fronted deposits when no event was lost", async () => {
    const { service, ethereum, assetHub, store } = await startService();
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    await service.tick();
    const queries = assetHub.depositQueries.length;
    assetHub.head = 520;

    await service.tick();

    expect(assetHub.depositQueries).toHaveLength(queries);
    expect(store.needsReconcile).toBe(false);
  });
});
