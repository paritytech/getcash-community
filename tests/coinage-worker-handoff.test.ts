// The surface half of the worker-driven purchase, offline, with a scripted worker manager.

import { describe, expect, it, vi } from "vitest";
import { runFundingViaWorker } from "../lib/coinage";
import { WorkerCallError } from "../lib/worker-rpc";

type Call = { api: string; payload?: unknown };

/** A worker manager whose fundingStatus answers are scripted and other calls recorded.
 *  `refuseStart` makes the hand-off throw. */
function fakeWorker(
  statuses: unknown[],
  opts: { refuseStart?: "always" | "resend"; available?: () => boolean } = {},
) {
  const calls: Call[] = [];
  let reads = 0;
  return {
    calls,
    manager: {
      isAvailable: opts.available ?? (() => true),
      call: vi.fn(async <T>(api: string, payload?: unknown): Promise<T> => {
        calls.push({ api, payload });
        if (api === "startFunding") {
          const starts = calls.filter((c) => c.api === "startFunding").length;
          if (opts.refuseStart === "always" || (opts.refuseStart === "resend" && starts > 1)) {
            throw new WorkerCallError("invalid", "settleAmount must be a positive amount");
          }
        }
        if (api === "fundingStatus") {
          const next = statuses[Math.min(reads, statuses.length - 1)];
          reads += 1;
          return next as T;
        }
        return {} as T;
      }),
    },
  };
}

const INPUT = {
  sessionId: "dot-assethub:7",
  handoff: { label: "onramp:eph:dot-assethub:7", settleAmount: "20000000" },
  pollMs: 1,
};

const SWAP_TX = `0x${"5a".repeat(32)}`;
const CLAIMED = { phase: "done", done: true, claim: { phase: "claimed", amount: "20400000" } };

describe("runFundingViaWorker", () => {
  it("hands off once, maps phases onto onStep, emits each tx once, ends on the claim", async () => {
    const onStep = vi.fn();
    const onTx = vi.fn();
    const onClaimed = vi.fn();
    const tx = { call: "swap", txHash: SWAP_TX, block: 7 };
    const { manager, calls } = fakeWorker([
      { phase: "starting", done: false, txs: [] },
      { phase: "swap", done: false, txs: [tx] },
      { phase: "await-arrival", done: false, txs: [tx] }, // tx repeats; the hook must not
      // The funding leg is done but the claim is mid-call: not over yet.
      { phase: "done", done: true, txs: [tx], claim: { phase: "claiming", amount: "20400000" } },
      { ...CLAIMED, txs: [tx] },
    ]);
    await runFundingViaWorker({
      worker: manager,
      ...INPUT,
      stop: { aborted: false },
      hooks: { onStep, onTx, onClaimed },
    });
    expect(calls.filter((c) => c.api === "startFunding")).toHaveLength(1);
    // "starting" is the worker's pre-flight, not a pipeline step the UI knows.
    expect(onStep.mock.calls.map((c) => c[0])).toEqual(["swap", "await-arrival", "done"]);
    expect(onTx).toHaveBeenCalledExactlyOnceWith(tx);
    // The purchase is complete when the claim is, with the amount the worker took.
    expect(onClaimed).toHaveBeenCalledExactlyOnceWith(20_400_000n);
    // A tickAllFunding nudge goes out alongside the reads.
    expect(calls.some((c) => c.api === "tickAllFunding")).toBe(true);
  });

  it("waits for the worker to come up, then hands off", async () => {
    let up = false;
    setTimeout(() => {
      up = true;
    }, 5);
    const { manager, calls } = fakeWorker([CLAIMED], { available: () => up });
    await runFundingViaWorker({ worker: manager, ...INPUT, stop: { aborted: false }, hooks: {} });
    expect(calls.filter((c) => c.api === "startFunding")).toHaveLength(1);
  });

  it("fails plainly when no worker appears: there is no other driver", async () => {
    const { manager, calls } = fakeWorker([], { available: () => false });
    await expect(
      runFundingViaWorker({
        worker: manager,
        ...INPUT,
        readyMs: 10,
        stop: { aborted: false },
        hooks: {},
      }),
    ).rejects.toThrow("not running on this host");
    expect(calls).toHaveLength(0);
  });

  it("fails when the worker refuses the hand-off, reason intact", async () => {
    const { manager } = fakeWorker([], { refuseStart: "always" });
    await expect(
      runFundingViaWorker({ worker: manager, ...INPUT, stop: { aborted: false }, hooks: {} }),
    ).rejects.toThrow("invalid: settleAmount must be a positive amount");
  });

  it("takes a landed claim as the truth even on a record that also says failed", async () => {
    const onClaimed = vi.fn();
    const { manager } = fakeWorker([
      { ...CLAIMED, phase: "failed", lastError: "cancelled by the surface" },
    ]);
    await runFundingViaWorker({
      worker: manager,
      ...INPUT,
      stop: { aborted: false },
      hooks: { onClaimed },
    });
    expect(onClaimed).toHaveBeenCalledExactlyOnceWith(20_400_000n);
  });

  it("turns a failed job into the run's failure, message intact", async () => {
    const { manager } = fakeWorker([
      { phase: "failed", done: false, lastError: "shortfall: deposit under target" },
    ]);
    await expect(
      runFundingViaWorker({ worker: manager, ...INPUT, stop: { aborted: false }, hooks: {} }),
    ).rejects.toThrow("shortfall: deposit under target");
  });

  it("stops quietly on dispose", async () => {
    const stop = { aborted: false };
    const onClaimed = vi.fn();
    const { manager } = fakeWorker([{ phase: "swap", done: false }]);
    setTimeout(() => {
      stop.aborted = true;
    }, 5);
    await runFundingViaWorker({ worker: manager, ...INPUT, stop, hooks: { onClaimed } });
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it("re-sends the idempotent hand-off when the worker's store forgot the job", async () => {
    const { manager, calls } = fakeWorker([{ sessionId: "dot-assethub:7", known: false }, CLAIMED]);
    await runFundingViaWorker({ worker: manager, ...INPUT, stop: { aborted: false }, hooks: {} });
    expect(calls.filter((c) => c.api === "startFunding")).toHaveLength(2);
  });

  it("gives up when the re-sent hand-off is refused: the same hand-off would be refused again", async () => {
    const onTransientError = vi.fn();
    const { manager, calls } = fakeWorker([{ sessionId: "dot-assethub:7", known: false }], {
      refuseStart: "resend",
    });
    await expect(
      runFundingViaWorker({
        worker: manager,
        ...INPUT,
        stop: { aborted: false },
        hooks: { onTransientError },
      }),
    ).rejects.toThrow("invalid");
    expect(calls.filter((c) => c.api === "startFunding")).toHaveLength(2);
    expect(onTransientError).not.toHaveBeenCalled();
  });
});
