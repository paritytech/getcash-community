// The provider leg over a scripted provider: one move per tick, the payment persisted before it
// leaves and never made twice, and the provider's verdict ending the leg either way.

import { describe, expect, it } from "vitest";
import type { SwapStatusResult } from "@getsome/core";
import { DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS, DEFAULT_WITHDRAW_TICK_TIMEOUT_MS } from "./tick";
import {
  CHANNEL_EXPIRY_MARGIN_MS,
  ChannelExpiredError,
  freshRailLegState,
  RailFailedError,
  railTickOnce,
  readingFailed,
  type RailClient,
  type RailHandoff,
  type RailLegInput,
  type RailLegState,
} from "./rail-leg";

const OPENED = 1_700_000_000_000;
const DAY = 86_400_000;
const CHANNEL: RailHandoff = {
  id: "ch-1",
  address: "5Channel",
  openedAt: OPENED,
  expiresAt: OPENED + DAY,
};
/** A moment the channel is comfortably open. */
const NOW = OPENED + 60_000;

const reading = (status: SwapStatusResult["status"], extra: Partial<SwapStatusResult> = {}) =>
  ({ status, ...extra }) as SwapStatusResult;

/** A leg whose channel the hand-off already named. */
const seeded = (): RailLegState => ({ ...freshRailLegState(), handoff: CHANNEL });

/** A provider that answers status reads from a script and records what it was asked. */
function scripted(statuses: SwapStatusResult[]) {
  const asked: string[] = [];
  const rail: RailClient = {
    status: async (id) => {
      asked.push(id);
      return statuses.shift() ?? reading("sending");
    },
  };
  return { rail, asked };
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
    now: () => NOW,
    onBeforePay: (handoff) => {
      persisted.push(handoff);
    },
    ...overrides,
  };
  return { input, paid, persisted };
}

describe("the provider leg", () => {
  it("pays once, persisted first, then follows the swap to delivered", async () => {
    const provider = scripted([reading("waiting"), reading("swapping"), reading("complete")]);
    const { input, paid, persisted } = world(provider.rail);
    const state = seeded();

    expect(await railTickOnce(input, state)).toEqual({ step: "handoff", reading: null });
    expect(persisted).toEqual([CHANNEL]);
    expect(paid).toEqual([CHANNEL]);
    expect(state.paid).toBe(true);

    expect((await railTickOnce(input, state)).step).toBe("follow");
    expect((await railTickOnce(input, state)).step).toBe("follow");
    const last = await railTickOnce(input, state);
    expect(last.step).toBe("done");
    expect(last.reading?.status).toBe("complete");
    expect(state.reading?.status).toBe("complete");
    expect(paid).toHaveLength(1);
    expect(provider.asked).toEqual(["ch-1", "ch-1", "ch-1"]);
  });

  it("does not pay again when the payment's answer was lost", async () => {
    const { input, paid } = world(scripted([]).rail);
    const state = seeded();
    await railTickOnce(input, state);
    expect(paid).toHaveLength(1);
    // A reload restores the state as persisted: paid stands, the next tick only reads.
    const restored = { ...state };
    expect((await railTickOnce(input, restored)).step).toBe("follow");
    expect(paid).toHaveLength(1);
  });

  it("refuses to move without a channel, and leaves a thrown payment for the next tick", async () => {
    const { input } = world(scripted([]).rail);
    await expect(railTickOnce(input, freshRailLegState())).rejects.toThrow("no channel");

    const stuck = world(scripted([]).rail, {
      pay: async () => {
        throw new Error("no fee");
      },
    });
    const state = seeded();
    await expect(railTickOnce(stuck.input, state)).rejects.toThrow("no fee");
    expect(state.paid).toBe(false);
  });

  it("ends with the provider's verdict when the swap fails, keeping the reading", async () => {
    const refund = reading("failed", { refundEgress: { amount: "1" } });
    const provider = scripted([reading("receiving"), refund]);
    const { input } = world(provider.rail);
    const state = seeded();
    await railTickOnce(input, state);
    expect((await railTickOnce(input, state)).step).toBe("follow");
    await expect(railTickOnce(input, state)).rejects.toBeInstanceOf(RailFailedError);
    expect(state.reading).toBe(refund);
  });

  it("reads a failure off the SDK's side fields as well as its status", () => {
    expect(readingFailed(reading("swapping"))).toBe(false);
    expect(readingFailed(reading("failed"))).toBe(true);
    expect(readingFailed(reading("sending", { swapEgressFailure: {} }))).toBe(true);
    expect(readingFailed(reading("complete", { fallbackEgress: {} }))).toBe(true);
  });

  it("bounds a provider that never answers", async () => {
    const silent: RailClient = { status: () => new Promise(() => {}) };
    const { input } = world(silent, { tickTimeoutMs: 5 });
    const state = seeded();
    state.paid = true;
    await expect(railTickOnce(input, state)).rejects.toThrow(/timed out/);
  });

  it("refuses to pay a channel at or past its expiry, and moves nothing", async () => {
    const provider = scripted([]);
    // Inside the margin: what lands might not be witnessed before the channel closes.
    const closing = world(provider.rail, {
      now: () => CHANNEL.expiresAt - CHANNEL_EXPIRY_MARGIN_MS,
    });
    const state = seeded();
    await expect(railTickOnce(closing.input, state)).rejects.toBeInstanceOf(ChannelExpiredError);
    expect(closing.paid).toEqual([]);
    expect(closing.persisted).toEqual([]);
    expect(state.paid).toBe(false);

    const past = world(provider.rail, { now: () => CHANNEL.expiresAt + 1 });
    await expect(railTickOnce(past.input, seeded())).rejects.toBeInstanceOf(ChannelExpiredError);
    expect(past.paid).toEqual([]);
  });

  it("pays a channel still short of the margin, and never re-checks once paid", async () => {
    const provider = scripted([reading("swapping")]);
    const { input, paid } = world(provider.rail, {
      now: () => CHANNEL.expiresAt - CHANNEL_EXPIRY_MARGIN_MS - 1,
    });
    const state = seeded();
    expect((await railTickOnce(input, state)).step).toBe("handoff");
    expect(paid).toHaveLength(1);

    // A channel that expires while the swap runs is the provider's business, not ours: the
    // deposit is already in and the leg must keep following it.
    const later = world(provider.rail, { now: () => CHANNEL.expiresAt + DAY });
    expect((await railTickOnce(later.input, state)).step).toBe("follow");
  });

  it("takes a channel that named no expiry as open", async () => {
    const provider = scripted([]);
    const { input, paid } = world(provider.rail, { now: () => OPENED + 10 * DAY });
    const state: RailLegState = { ...freshRailLegState(), handoff: { ...CHANNEL, expiresAt: 0 } };
    await railTickOnce(input, state);
    expect(paid).toHaveLength(1);
  });

  it("leaves the payment room to be submitted, included and witnessed", () => {
    // The margin has to outlast this leg's own bounds, or a payment that starts inside it is
    // still in flight when the channel closes.
    expect(CHANNEL_EXPIRY_MARGIN_MS).toBeGreaterThan(
      DEFAULT_WITHDRAW_TICK_TIMEOUT_MS + DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
    );
  });

  it("says when the channel closes without ever throwing on a nonsense time", () => {
    const sane = new ChannelExpiredError(CHANNEL, NOW);
    expect(sane.message).toContain(new Date(CHANNEL.expiresAt).toISOString());
    // Beyond what Date can represent: the message falls back to the raw milliseconds rather
    // than throwing, which the driver would otherwise retry forever as a transient error.
    const absurd = new ChannelExpiredError({ ...CHANNEL, expiresAt: 1e20 }, NOW);
    expect(absurd.message).toContain(`${1e20}ms`);
  });
});
