import { describe, expect, it } from "vitest";
import { PayoutService } from "../src/payout/service";
import { PayoutStore } from "../src/payout/store";
import { DepositStatus } from "../src/payout/abi";
import { FakeApi, dispatchFailed, included, newClient, revertData, silent } from "./helpers/fakeApi";
import { MockEthereum, ONE, TOKEN, confirmedDeposit, defaultOptions, recordingLogger } from "./helpers/payout";

// The real Asset Hub client over a scripted node, under the real service: what a dropped or stalled socket does to a front.
async function setup(submitTimeoutMs = 40) {
  const api = new FakeApi();
  const client = await newClient(api, { submitTimeoutMs });
  const ethereum = new MockEthereum();
  const log = recordingLogger();
  const service = await PayoutService.create({ ...defaultOptions, token: TOKEN, pollIntervalMs: 5 }, new PayoutStore(), ethereum, client, log.logger);
  confirmedDeposit(ethereum, 1n, 100n * ONE);
  return { api, client, ethereum, log, service };
}

describe("a front that hangs", () => {
  it("times out with a transport error and, when the extrinsic landed meanwhile, adopts it from pool state without signing again", async () => {
    const { api, client, service, log } = await setup();
    api.submissions.push(silent);

    await service.tick();

    expect(service.record("1")).toMatchObject({ status: "queued", attempts: 1 });
    expect(service.record("1")?.reason).toContain("timed out after 40 ms");

    api.state = { status: DepositStatus.Fronted, payer: client.payer };
    await service.tick();

    expect(service.record("1")?.status).toBe("fronted");
    expect(api.submitted).toBe(1);
    expect(log.errors()).toHaveLength(0);
  });

  it("times out and, when the extrinsic never landed, fronts again on the next pass", async () => {
    const { api, service } = await setup();
    api.submissions.push(silent, included());

    await service.tick();
    expect(service.record("1")?.status).toBe("queued");
    await service.tick();

    expect(service.record("1")?.status).toBe("fronted");
    expect(service.record("1")?.front).toBeDefined();
    expect(api.submitted).toBe(2);
  });

  it("recovers when the late extrinsic lands between the second simulation and its inclusion, as fronted by this payer", async () => {
    const { api, client, service, log } = await setup();
    api.submissions.push(silent, dispatchFailed("ContractReverted"));
    await service.tick();
    expect(service.record("1")?.status).toBe("queued");

    api.frontDryRuns.push({}, { reverted: true, output: revertData("AlreadyFronted") });
    api.onSubmit = () => void (api.state = { status: DepositStatus.Fronted, payer: client.payer });
    await service.tick();

    expect(service.record("1")).toMatchObject({ status: "fronted" });
    expect(service.record("1")?.reason).toBeUndefined();
    expect(service.outstanding()).toBeGreaterThan(0n);
    expect(log.errors()).toHaveLength(0);
  });

  it("fails at once when the socket drops mid-front, and reads the chain again on the next pass", async () => {
    const { api, service } = await setup(60_000);
    api.submissions.push(silent, included());
    const first = service.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    api.emit("disconnected");
    await first;

    expect(service.record("1")).toMatchObject({ status: "queued", attempts: 1 });
    expect(service.record("1")?.reason).toContain("connection dropped");

    await service.tick();
    expect(service.record("1")?.status).toBe("fronted");
  });

  it("does not hold the shutdown: stop returns while a front is still waiting for inclusion", async () => {
    const { api, service } = await setup(60_000);
    api.submissions.push(silent);
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.submitted).toBe(1);

    const outcome = await Promise.race([service.stop().then(() => "stopped"), new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000))]);

    expect(outcome).toBe("stopped");
    expect(service.record("1")).toMatchObject({ status: "queued", attempts: 0 });
  });
});
