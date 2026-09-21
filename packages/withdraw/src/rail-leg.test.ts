// The provider leg over a scripted provider: one move per tick, a channel opened once, the
// payment persisted before it leaves, and the provider's verdict ending the leg either way.

import { describe, expect, it } from "vitest";
import type { SwapStatusResult } from "@getsome/core";
import {
  freshRailLegState,
  RailFailedError,
  railTickOnce,
  readingFailed,
  type RailClient,
  type RailHandoff,
  type RailLegInput,
} from "./rail-leg";

const reading = (status: SwapStatusResult["status"], extra: Partial<SwapStatusResult> = {}) =>
  ({ status, ...extra }) as SwapStatusResult;

/** A provider that answers status reads from a script and counts what it was asked. */
function scripted(statuses: SwapStatusResult[]) {
  let opens = 0;
  const asked: string[] = [];
  const rail: RailClient = {
    open: async () => {
      opens += 1;
      return { id: `ch-${opens}`, address: "5Channel" };
    },
    status: async (id) => {
      asked.push(id);
      return statuses.shift() ?? reading("sending");
    },
  };
  return { rail, opens: () => opens, asked };
}

function world(rail: RailClient, overrides: Partial<RailLegInput> = {}) {
  const paid: RailHandoff[] = [];
  const persisted: RailHandoff[] = [];
  const input: RailLegInput = {
    rail,
    pay: async (handoff) => {
      paid.push(handoff);
    },
    tickTimeoutMs: 1_000,
    payTimeoutMs: 1_000,
    now: () => 1_700_000_000_000,
    onBeforePay: (handoff) => {
      persisted.push(handoff);
    },
    ...overrides,
  };
  return { input, paid, persisted };
}

describe("the provider leg", () => {
  it("opens once, pays once with the channel persisted first, then follows to delivered", async () => {
    const provider = scripted([reading("waiting"), reading("swapping"), reading("complete")]);
    const { input, paid, persisted } = world(provider.rail);
    const state = freshRailLegState();

    expect(await railTickOnce(input, state)).toEqual({ step: "handoff", reading: null });
    expect(state.handoff).toMatchObject({ id: "ch-1", address: "5Channel" });
    expect(paid).toEqual([]);

    expect(await railTickOnce(input, state)).toEqual({ step: "handoff", reading: null });
    expect(persisted).toEqual([state.handoff]);
    expect(paid).toEqual([state.handoff]);
    expect(state.paid).toBe(true);

    expect((await railTickOnce(input, state)).step).toBe("follow");
    expect((await railTickOnce(input, state)).step).toBe("follow");
    const last = await railTickOnce(input, state);
    expect(last.step).toBe("done");
    expect(last.reading?.status).toBe("complete");
    expect(state.reading?.status).toBe("complete");
    expect(provider.opens()).toBe(1);
    expect(provider.asked).toEqual(["ch-1", "ch-1", "ch-1"]);
  });

  it("does not pay again when the payment's answer was lost", async () => {
    const provider = scripted([]);
    const { input, paid } = world(provider.rail);
    const state = freshRailLegState();
    await railTickOnce(input, state);
    await railTickOnce(input, state);
    expect(paid).toHaveLength(1);
    // A reload restores the state as persisted: paid stands, the next tick only reads.
    const restored = { ...state };
    expect((await railTickOnce(input, restored)).step).toBe("follow");
    expect(paid).toHaveLength(1);
  });

  it("leaves a thrown open or payment for the next tick, without moving the state", async () => {
    const failing: RailClient = {
      open: async () => {
        throw new Error("provider down");
      },
      status: async () => reading("waiting"),
    };
    const { input } = world(failing);
    const state = freshRailLegState();
    await expect(railTickOnce(input, state)).rejects.toThrow("provider down");
    expect(state.handoff).toBeNull();

    const provider = scripted([]);
    const stuck = world(provider.rail, {
      pay: async () => {
        throw new Error("no fee");
      },
    });
    await railTickOnce(stuck.input, state);
    await expect(railTickOnce(stuck.input, state)).rejects.toThrow("no fee");
    expect(state.paid).toBe(false);
  });

  it("ends with the provider's verdict when the swap fails, keeping the reading", async () => {
    const refund = reading("failed", { refundEgress: { amount: "1" } as never });
    const provider = scripted([reading("receiving"), refund]);
    const { input } = world(provider.rail);
    const state = freshRailLegState();
    await railTickOnce(input, state);
    await railTickOnce(input, state);
    expect((await railTickOnce(input, state)).step).toBe("follow");
    await expect(railTickOnce(input, state)).rejects.toBeInstanceOf(RailFailedError);
    expect(state.reading).toBe(refund);
  });

  it("reads a failure off the SDK's side fields as well as its status", () => {
    expect(readingFailed(reading("swapping"))).toBe(false);
    expect(readingFailed(reading("failed"))).toBe(true);
    expect(readingFailed(reading("sending", { swapEgressFailure: {} }))).toBe(true);
    expect(readingFailed(reading("complete", { fallbackEgress: {} as never }))).toBe(true);
  });

  it("bounds a provider that never answers", async () => {
    const silent: RailClient = {
      open: () => new Promise(() => {}),
      status: async () => reading("waiting"),
    };
    const { input } = world(silent, { tickTimeoutMs: 5 });
    await expect(railTickOnce(input, freshRailLegState())).rejects.toThrow(/timed out/);
  });
});
