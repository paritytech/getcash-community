// The provider leg over a scripted provider: one move per tick, the payment persisted before it
// leaves and never made twice, and the provider's verdict ending the leg either way.

import { describe, expect, it } from "vitest";
import type { SwapStatusResult } from "@getsome/core";
import { DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS, DEFAULT_WITHDRAW_TICK_TIMEOUT_MS } from "./tick";
import {
  CHANNEL_EXPIRY_MARGIN_MS,
  ChannelExpiredError,
  ChannelMismatchError,
  freshRailLegState,
  RailFailedError,
  railTickOnce,
  readingFailed,
  type RailChannelRecord,
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

const AMOUNT = 20_000_000_000n;
/** The provider's record of the channel, as it really has it: a sale's, with no payout address
 *  and an exact figure instead. */
const RECORD: RailChannelRecord = {
  depositAddress: CHANNEL.address,
  payout: "off-chain",
  expired: false,
  expectedAmount: AMOUNT,
};

/** A provider that also answers the channel read, from a fixed record. */
function checking(record: RailChannelRecord | null, statuses: SwapStatusResult[] = []) {
  const base = scripted(statuses);
  const asked: string[] = [];
  const rail: RailClient = {
    status: base.rail.status,
    channel: async (id) => {
      asked.push(id);
      return record;
    },
  };
  return { rail, asked };
}

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
    amount: AMOUNT,
    onBeforePay: (handoff) => {
      persisted.push(handoff);
    },
    ...overrides,
  };
  return { input, paid, persisted };
}

describe("the provider leg", () => {
  it("pays once, persisted first, then follows the sale to delivered", async () => {
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

  it("ends with the provider's verdict when the sale fails, keeping the reading", async () => {
    const ended = reading("failed", { depositFailure: { reason: { message: "declined" } } });
    const provider = scripted([reading("receiving"), ended]);
    const { input } = world(provider.rail);
    const state = seeded();
    await railTickOnce(input, state);
    expect((await railTickOnce(input, state)).step).toBe("follow");
    await expect(railTickOnce(input, state)).rejects.toBeInstanceOf(RailFailedError);
    expect(state.reading).toBe(ended);
  });

  it("reads a failure off the rail's named failure as well as its status", () => {
    expect(readingFailed(reading("swapping"))).toBe(false);
    expect(readingFailed(reading("failed"))).toBe(true);
    expect(readingFailed(reading("sending", { depositFailure: {} }))).toBe(true);
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

    // A channel that expires while the sale runs is the provider's business, not ours: the
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
  it("holds the channel against the provider's own record before paying", async () => {
    const provider = checking(RECORD, [reading("swapping")]);
    const { input, paid } = world(provider.rail);
    const state = seeded();
    expect((await railTickOnce(input, state)).step).toBe("handoff");
    expect(provider.asked).toEqual(["ch-1"]);
    expect(paid).toEqual([CHANNEL]);

    // Checked before the payment only; the follow never asks again.
    expect((await railTickOnce(input, state)).step).toBe("follow");
    expect(provider.asked).toEqual(["ch-1"]);
  });

  it("refuses when the provider cannot name the channel, or names another deposit address", async () => {
    const unknown = world(checking(null).rail);
    await expect(railTickOnce(unknown.input, seeded())).rejects.toBeInstanceOf(
      ChannelMismatchError,
    );
    expect(unknown.paid).toEqual([]);
    expect(unknown.persisted).toEqual([]);

    const elsewhere = world(checking({ ...RECORD, depositAddress: "5Elsewhere" }).rail);
    await expect(railTickOnce(elsewhere.input, seeded())).rejects.toThrow(/takes deposits at/);
    expect(elsewhere.paid).toEqual([]);
  });

  it("takes the provider's word that a channel is closed, whatever our clock says", async () => {
    const closed = world(checking({ ...RECORD, expired: true }).rail);
    await expect(railTickOnce(closed.input, seeded())).rejects.toBeInstanceOf(ChannelExpiredError);
    expect(closed.paid).toEqual([]);
  });

  it("leaves a provider that cannot be reached for the next tick, unpaid", async () => {
    const down: RailClient = {
      status: async () => reading("waiting"),
      channel: async () => {
        throw new Error("provider unreachable");
      },
    };
    const { input, paid } = world(down);
    const state = seeded();
    await expect(railTickOnce(input, state)).rejects.toThrow("provider unreachable");
    expect(paid).toEqual([]);
    expect(state.paid).toBe(false);
  });
  it("reads the channel's own address as an account, whatever prefix it is written with", async () => {
    // The same Asset Hub account under the Polkadot, Kusama and generic prefixes. The address the
    // hand-off carries and the one the provider reads back must not have to agree on how to
    // write it.
    const polkadot = "1ADRXEpxCcHPze36zV1imej5DNcGZ8puqopyUhbppXyGuhP";
    const kusama = "CjXwWKdinMji7Sxv4F4UaBaNBfCNvPsHiv6CqzCkXiwqerR";
    const generic = "5CDvHBym6RLoxTdX9MS1acpaDbNxaFagqM5LpBiFGjWT6o1n";
    const handoff: RailHandoff = { ...CHANNEL, address: polkadot };

    for (const written of [polkadot, kusama, generic]) {
      const provider = checking({ ...RECORD, depositAddress: written }, [reading("swapping")]);
      const { input, paid } = world(provider.rail);
      await railTickOnce(input, { ...freshRailLegState(), handoff });
      expect(paid).toEqual([handoff]);
    }

    // A different account is still refused, in any prefix.
    const other = world(checking({ ...RECORD, depositAddress: generic.replace(/.$/, "2") }).rail);
    await expect(
      railTickOnce(other.input, { ...freshRailLegState(), handoff }),
    ).rejects.toBeInstanceOf(ChannelMismatchError);
    expect(other.paid).toEqual([]);
  });
});

describe("the rail leg's exact figure", () => {
  const SALE = RECORD;

  it("pays a sale whose provider expects exactly the figure the key pays", async () => {
    const provider = checking(SALE);
    const { input, paid } = world(provider.rail);
    await railTickOnce(input, seeded());
    expect(paid).toEqual([CHANNEL]);
  });

  it("refuses a provider that expects another figure, or none", async () => {
    for (const record of [
      { ...SALE, expectedAmount: AMOUNT + 1n },
      { ...SALE, expectedAmount: undefined },
    ]) {
      const { input, paid } = world(checking(record).rail);
      await expect(railTickOnce(input, seeded())).rejects.toBeInstanceOf(ChannelMismatchError);
      expect(paid).toEqual([]);
    }
  });

  it("refuses when the leg names no amount of its own", async () => {
    const { input, paid } = world(checking(SALE).rail, {
      amount: undefined as unknown as bigint,
    });
    await expect(railTickOnce(input, seeded())).rejects.toThrow(/cannot be checked/);
    expect(paid).toEqual([]);
  });

  it("refuses a record that pays out on chain", async () => {
    const { payout: _payout, ...onChain } = RECORD;
    const { input, paid } = world(checking(onChain).rail);
    await expect(railTickOnce(input, seeded())).rejects.toThrow(/pays out on chain/);
    expect(paid).toEqual([]);
  });

  it("still refuses a sale the provider has closed", async () => {
    const { input, paid } = world(checking({ ...SALE, expired: true }).rail);
    await expect(railTickOnce(input, seeded())).rejects.toBeInstanceOf(ChannelExpiredError);
    expect(paid).toEqual([]);
  });

  it("takes a payment the chain shows as landed, before the provider or the clock is asked", async () => {
    // The answer to the payment was lost and the provider has since closed the order it filled:
    // its record would read as unpaid, and the channel is past its expiry too. The chain decides.
    const provider = checking(null);
    const { input, paid } = world(provider.rail, {
      landed: async () => true,
      now: () => CHANNEL.expiresAt + DAY,
    });
    const state = seeded();
    expect(await railTickOnce(input, state)).toEqual({ step: "handoff", reading: null });
    expect(state.paid).toBe(true);
    expect(provider.asked).toEqual([]);
    expect(paid).toEqual([]);
  });

  it("checks the provider and pays as usual while the chain shows nothing landed", async () => {
    const provider = checking(SALE);
    const { input, paid } = world(provider.rail, { landed: async () => false });
    await railTickOnce(input, seeded());
    expect(provider.asked).toEqual(["ch-1"]);
    expect(paid).toEqual([CHANNEL]);
  });

  it("stops on what the chain cannot tell, and bounds the read", async () => {
    const unresolved = world(checking(SALE).rail, {
      landed: async () => {
        throw new Error("the key moved on");
      },
    });
    await expect(railTickOnce(unresolved.input, seeded())).rejects.toThrow(/moved on/);
    expect(unresolved.paid).toEqual([]);

    const hung = world(checking(SALE).rail, {
      payTimeoutMs: 5,
      landed: () => new Promise<boolean>(() => {}),
    });
    await expect(railTickOnce(hung.input, seeded())).rejects.toThrow(/earlier payment read/);
    expect(hung.paid).toEqual([]);
  });
});
