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

const DESTINATION = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
/** The provider's record of the channel, as it really has it. */
const RECORD: RailChannelRecord = {
  depositAddress: CHANNEL.address,
  destinationAddress: DESTINATION,
  expired: false,
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
    destinationAddress: DESTINATION,
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

  it("refuses when the provider would pay out to another address", async () => {
    const wrong = world(checking({ ...RECORD, destinationAddress: "bc1qsomeoneelse" }).rail);
    await expect(railTickOnce(wrong.input, seeded())).rejects.toThrow(/pays out to/);
    expect(wrong.paid).toEqual([]);
  });

  it("takes the provider's word that a channel is closed, whatever our clock says", async () => {
    const closed = world(checking({ ...RECORD, expired: true }).rail);
    await expect(railTickOnce(closed.input, seeded())).rejects.toBeInstanceOf(ChannelExpiredError);
    expect(closed.paid).toEqual([]);
  });

  it("reads the payout address back in any casing, where the format allows both", async () => {
    // Ethereum's checksum is casing and bech32 is specified in both, so an address the user gave
    // in one form and the provider hands back in another is the same address.
    for (const address of [DESTINATION, "0x52908400098527886E0F7030069857D2E4169EE7"]) {
      const cased = checking({ ...RECORD, destinationAddress: address.toUpperCase() }, [
        reading("swapping"),
      ]);
      const { input, paid } = world(cased.rail, { destinationAddress: address });
      await railTickOnce(input, seeded());
      expect(paid).toHaveLength(1);
    }
  });

  it("holds a base58 payout address to its exact spelling, since a case variant is another account", async () => {
    // Solana addresses are bare public keys with no checksum, so nothing rejects a case variant
    // for us: the comparison has to.
    const solana = "4Nd1mYQx3sABznWXpq2mV3G7iC6nnZq6dvGnHLm2rrDF";
    const variant = solana.toLowerCase();
    const provider = checking({ ...RECORD, destinationAddress: variant });
    const { input, paid } = world(provider.rail, { destinationAddress: solana });
    await expect(railTickOnce(input, seeded())).rejects.toBeInstanceOf(ChannelMismatchError);
    expect(paid).toEqual([]);
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
    // The same Asset Hub account under the Polkadot, Kusama and generic prefixes. The address is
    // issued by one Chainflip endpoint and read back from another, so the two must not have to
    // agree on how to write it.
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

  it("refuses when either side cannot name the payout address", async () => {
    const silentProvider = world(checking({ ...RECORD, destinationAddress: "" }).rail);
    await expect(railTickOnce(silentProvider.input, seeded())).rejects.toBeInstanceOf(
      ChannelMismatchError,
    );
    expect(silentProvider.paid).toEqual([]);

    // A driver that names no destination does not get a free pass: the check is the only thing
    // between a hand-off and an irreversible transfer.
    const silentDriver = world(checking(RECORD).rail, { destinationAddress: "" });
    await expect(railTickOnce(silentDriver.input, seeded())).rejects.toThrow(/cannot be checked/);
    expect(silentDriver.paid).toEqual([]);
  });
});
