// The surface's handoff with the worker as the only claimer: settle waits for the worker's
// verdict and records it, isSettled answers from that record or from the worker's marker.
// Timers are faked: settle sleeps between reads of the marker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoinageHandoff, type WorkerClaim } from "../lib/coinage";

const KEY = "flow-key";
const RECORD = `coinage:settle:${KEY}`;
const CTX = { secretKey: new Uint8Array(64).fill(7), address: "5Burner", amount: 1_000_000n };

function surface(claims: (WorkerClaim | null)[] = [null]) {
  const store = new Map<string, string>();
  let reads = 0;
  const onProgress = vi.fn();
  const handoff = createCoinageHandoff({
    storage: {
      read: async (k: string) => store.get(k) ?? null,
      write: async (k: string, v: string) => void store.set(k, v),
      clear: async (k: string) => void store.delete(k),
    },
    burnerAddress: CTX.address,
    readWorkerClaim: async () => {
      const next = claims[Math.min(reads, claims.length - 1)] ?? null;
      reads += 1;
      return next;
    },
    onProgress,
  });
  const record = () => {
    const raw = store.get(RECORD);
    return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
  };
  return { handoff, store, record, onProgress, readCount: () => reads };
}

const CLAIMED: WorkerClaim = { phase: "claimed", amount: "1020000", at: 1 };
const CLAIMING: WorkerClaim = { phase: "claiming", amount: "1020000", at: 1 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("settle", () => {
  it("records the worker's claim as this session's settle, with the amount the worker took", async () => {
    const s = surface([CLAIMED]);
    await s.handoff.settle(CTX, KEY);
    expect(s.record()).toMatchObject({ burner: CTX.address, amount: "1020000", settled: true });
    expect(s.onProgress).toHaveBeenCalledWith("crediting", 1_020_000n);
  });

  it("waits for a claim that is mid-call rather than acting itself", async () => {
    const s = surface([CLAIMING, CLAIMING, CLAIMED]);
    const settled = s.handoff.settle(CTX, KEY);
    await vi.advanceTimersByTimeAsync(4_100);
    await settled;
    expect(s.record()).toMatchObject({ settled: true });
    expect(s.readCount()).toBe(3);
  });

  it("throws recoverably when the worker has not claimed within the wait", async () => {
    const s = surface([null]);
    const settled = s.handoff.settle(CTX, KEY);
    const outcome = settled.then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(201_000);
    expect(await outcome).toContain("has not completed yet");
    expect(s.record()).toBeNull();
  });
});

describe("isSettled", () => {
  it("returns null before any claim exists, without writing", async () => {
    const s = surface([null]);
    expect(await s.handoff.isSettled(KEY)).toBeNull();
    expect(s.record()).toBeNull();
  });

  it("does not settle on a claim still in flight", async () => {
    const s = surface([CLAIMING]);
    expect(await s.handoff.isSettled(KEY)).toBeNull();
  });

  it("settles on the worker's claim and records it, so later probes are a storage read", async () => {
    const s = surface([CLAIMED, null]);
    expect(await s.handoff.isSettled(KEY)).toEqual({ id: KEY });
    expect(s.record()).toMatchObject({ amount: "1020000", settled: true });
    // The marker is gone (a wiped worker store): the record alone answers.
    expect(await s.handoff.isSettled(KEY)).toEqual({ id: KEY });
    expect(s.readCount()).toBe(1);
  });

  it("answers from a record written by an earlier version of this surface", async () => {
    const s = surface([null]);
    s.store.set(
      RECORD,
      JSON.stringify({ amount: "1000000", baseline: null, burnerBefore: null, settled: true }),
    );
    expect(await s.handoff.isSettled(KEY)).toEqual({ id: KEY });
  });
});
