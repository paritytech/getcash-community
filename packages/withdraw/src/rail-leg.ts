// The provider leg of a withdrawal to a bank or a card. Once the sale's token sits on the key's
// own Asset Hub account, the provider of the sale carries it to the seller. Two moves, at most one
// per tick: pay the provider's channel the exact figure it was quoted, then read the sale until
// the provider says it is delivered or that it failed. What the sale landed above the figure
// stays on the key.
//
// THE CHANNEL IS OPENED ELSEWHERE. The page opens it at confirm, while the user is there and
// with the quote they were shown, and the hand-off carries it here. This leg never opens one.
//
// THE KEY PAYS, THE MESSAGE DOES NOT. What the message lands moves with the price, and the
// provider is owed an exact figure, paid only once its order has been checked. So the message
// lands the sale's token on the key, and the key pays the channel with a transfer.
//
// PROVIDER AGNOSTIC. The provider is a client with two calls, status and channel, and the payment
// is a hand the driver supplies. Nothing here knows which provider it is talking to.
//
// THE HAND-OFF IS NOT TRUSTED FOR THE PAYMENT. The channel was opened by the page and has been
// through storage since, and the transfer it names cannot be undone. So before the key pays, the
// provider is asked what it holds for that channel id and the answer is checked against the
// withdrawal: the address about to be paid, the exact amount the payout to a bank or a card is
// held to, and whether the channel is still open. A provider with no such read is trusted as the
// hand-off describes it.
//
// RE-ENTRANT, like the message leg. The state is the driver's to persist; a tick that throws is
// retried on the next tick. Terminal is the provider's own verdict: delivered, or a failure it
// names.

import type { SwapStatusResult } from "@getsome/core";
import { AccountId } from "polkadot-api";
import { bounded } from "./bounded";
import { DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS, DEFAULT_WITHDRAW_TICK_TIMEOUT_MS } from "./tick";

/** Decodes an Asset Hub address to the account it names, whatever prefix it was written with. */
const accountId = AccountId();

/** 'handoff' pays the channel; 'follow' holds while the provider works. */
export type RailStep = "handoff" | "follow" | "done";

/** The channel the provider opened for this withdrawal. */
export interface RailHandoff {
  id: string;
  /** The Asset Hub account the key pays. */
  address: string;
  openedAt: number;
  /** When the provider closes the channel (ms); 0 when it named none. */
  expiresAt: number;
}

/**
 * How close to a channel's expiry the key may still pay it. The payment has to be read, submitted,
 * included and then witnessed by the provider before the channel closes, and a deposit into a
 * closed one is not paid out. So the margin is a tick, a submit and ten minutes,
 * which outlasts the driver's whole bound on a payment and still leaves the provider minutes to
 * see the transfer.
 *
 * Erring long is cheap: refusing early sends the key home with nothing moved. Erring short costs
 * the whole withdrawal.
 */
export const CHANNEL_EXPIRY_MARGIN_MS =
  DEFAULT_WITHDRAW_TICK_TIMEOUT_MS + DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS + 600_000;

/** Cross-tick memory for the leg. The driver persists it; `railTickOnce` mutates it. */
export interface RailLegState {
  /** Seeded by the driver from the hand-off; null means there is nothing to pay yet. */
  handoff: RailHandoff | null;
  /** The key paid the channel. */
  paid: boolean;
  /** The provider's latest word on the sale. */
  reading: SwapStatusResult | null;
}

export const freshRailLegState = (): RailLegState => ({
  handoff: null,
  paid: false,
  reading: null,
});

/** The provider's own record of a channel, read back by its id. */
export interface RailChannelRecord {
  /** Where the provider expects the deposit. */
  depositAddress: string;
  /** `off-chain` for a payout to a bank or a card, which has no address to compare. */
  payout?: "off-chain";
  /** The provider's own word on the channel being closed. */
  expired: boolean;
  /** What the provider expects to receive, base units, for a provider that holds the key to an
   *  exact figure. */
  expectedAmount?: bigint;
}

/** A provider, bound to one network: the sale behind a channel, as it stands. */
export interface RailClient {
  status(id: string): Promise<SwapStatusResult>;
  /**
   * The provider's record of the channel, checked before the key pays. Optional: a provider with
   * no such read is trusted as the hand-off describes it.
   *
   * Null means the provider answered but could not name the channel, or gave it up. Anything
   * else throws, a not-found included: a channel opened seconds ago may not be visible yet.
   */
  channel?(id: string): Promise<RailChannelRecord | null>;
}

/**
 * The provider's record of the channel does not match the withdrawal, or the provider does not
 * know the channel at all. Nothing has moved. Terminal: a sale has its one order, and its key
 * goes home.
 */
export class ChannelMismatchError extends Error {
  constructor(readonly detail: string) {
    super(`the provider's channel does not match this withdrawal: ${detail}`);
    this.name = "ChannelMismatchError";
  }
}

/**
 * The Asset Hub account two addresses name, compared as accounts rather than as text. The channel
 * address is read back from a different endpoint than the one that issued it, and the same account
 * encodes differently under different network prefixes, so comparing the strings would refuse every
 * withdrawal if those two ever disagreed on the prefix. Anything that does not decode falls back to
 * the text, which can only be stricter.
 */
function sameAccount(a: string, b: string): boolean {
  try {
    const left = accountId.enc(a.trim());
    const right = accountId.enc(b.trim());
    return left.length === right.length && left.every((byte, i) => byte === right[i]);
  } catch {
    return a.trim() === b.trim();
  }
}

export interface RailLegInput {
  rail: RailClient;
  /** Pays the channel the exact `amount` from the key on Asset Hub. Resolves once the payment is
   *  on chain. The payment keeps its own memory with the driver. */
  pay: (handoff: RailHandoff) => Promise<void>;
  /** Bound on a provider call. */
  tickTimeoutMs: number;
  /** Bound on the payment's resolution. */
  payTimeoutMs: number;
  /** Read once per tick, to judge the channel against its expiry. */
  now: () => number;
  /** The exact amount the key pays, base units. The provider's record must expect exactly this,
   *  for a payout off chain. The driver is not always typed against this, so a missing one is
   *  refused at run time too. */
  amount: bigint;
  /** For a payment that keeps its own memory of an attempt that may have left (the exact
   *  payment's nonce): whether that attempt landed, from the chain alone. Asked before anything
   *  else while the key is unpaid, since a provider that saw the funds may already have closed the
   *  order and its record would read as unpaid. Bound by `payTimeoutMs`. */
  landed?: () => Promise<boolean>;
  /** Runs before the payment leaves, so the driver can persist what it is about to pay. */
  onBeforePay?: (handoff: RailHandoff) => Promise<void> | void;
}

export interface RailLegOutcome {
  step: RailStep;
  reading: SwapStatusResult | null;
}

/**
 * The channel is at or past its expiry, so the key must not pay it: the provider does not witness
 * a deposit into a closed channel, and what lands there is not paid out. Terminal. Nothing has
 * moved: the sale, whose order cannot be opened again, sends the key home.
 */
export class ChannelExpiredError extends Error {
  constructor(
    readonly handoff: RailHandoff,
    readonly nowMs: number,
  ) {
    super(
      `the provider's channel ${handoff.id} closes at ${stamp(handoff.expiresAt)}, too soon to pay it at ${stamp(nowMs)}`,
    );
    this.name = "ChannelExpiredError";
  }
}

/** The provider reported an ending that is not a delivery. Terminal for this channel. */
export class RailFailedError extends Error {
  constructor(readonly reading: SwapStatusResult) {
    super(`the provider reported the sale failed: ${describeFailure(reading)}`);
    this.name = "RailFailedError";
  }
}

/** The provider's ending, in a line; mirrors how the surface reads a status. */
export function describeFailure(reading: SwapStatusResult): string {
  return reading.depositFailure?.reason?.message ?? "the provider named no reason";
}

/** An ms instant for a message. Never throws: a nonsense time must not turn a refusal to pay
 *  into an error the driver reads as transient and retries forever. */
function stamp(ms: number): string {
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? `${ms}ms` : at.toISOString();
}

export const readingFailed = (reading: SwapStatusResult): boolean =>
  reading.status === "failed" || reading.depositFailure !== undefined;

/**
 * Holds the channel against the provider's own record of it, before the key pays. A provider with
 * no such read is trusted as the hand-off describes it. Refuses when the provider cannot name the
 * channel, has closed it, takes deposits at another address, or does not expect the exact figure
 * off chain. A read that did not answer throws on its own and the tick retries.
 */
async function checkAgainstProvider(input: RailLegInput, handoff: RailHandoff): Promise<void> {
  if (input.rail.channel === undefined) return;
  const record = await bounded(
    input.rail.channel(handoff.id),
    input.tickTimeoutMs,
    "channel record read",
  );
  if (record === null) {
    throw new ChannelMismatchError(`the provider cannot name channel ${handoff.id}`);
  }
  // The deposit lands on Asset Hub, so this pair is compared as accounts, not as text.
  if (!sameAccount(record.depositAddress, handoff.address)) {
    throw new ChannelMismatchError(
      `channel ${handoff.id} takes deposits at ${record.depositAddress}, not ${handoff.address}`,
    );
  }
  checkOffChainPayout(input, handoff, record);
  // The provider's own word outranks our stored clock.
  if (record.expired) throw new ChannelExpiredError(handoff, input.now());
}

/**
 * A payout to a bank or a card has no address to compare, so the amount stands in for it: the
 * provider holds the key to an exact figure, and a record that expects another one, or none, is
 * not this withdrawal's. The provider's record must say the payout is off chain.
 */
function checkOffChainPayout(
  input: RailLegInput,
  handoff: RailHandoff,
  record: RailChannelRecord,
): void {
  if (record.payout !== "off-chain") {
    throw new ChannelMismatchError(
      `channel ${handoff.id} pays out on chain, and the withdrawal pays out to a bank or a card`,
    );
  }
  if (input.amount === undefined || record.expectedAmount === undefined) {
    throw new ChannelMismatchError(
      `channel ${handoff.id} cannot be checked: the amount is not known on both sides`,
    );
  }
  if (record.expectedAmount !== input.amount) {
    throw new ChannelMismatchError(
      `channel ${handoff.id} expects ${record.expectedAmount}, and the key would pay ${input.amount}`,
    );
  }
}

/**
 * One move on the provider leg. Retryable by calling again; the terminal signals are the
 * returned "done" and a thrown RailFailedError.
 */
export async function railTickOnce(
  input: RailLegInput,
  state: RailLegState,
): Promise<RailLegOutcome> {
  if (state.handoff === null) throw new Error("the rail leg has no channel to pay");
  if (!state.paid) {
    // A payment whose answer was lost is settled by the chain before the provider or the clock is
    // asked: once the funds are out, neither has a say.
    if (
      input.landed !== undefined &&
      (await bounded(input.landed(), input.payTimeoutMs, "earlier payment read"))
    ) {
      state.paid = true;
      return { step: "handoff", reading: null };
    }
    // Checked before the money moves, not on the way in: every path here pays the same way, and a
    // channel can go stale between the hand-off and the tick that acts on it.
    const { expiresAt } = state.handoff;
    const nowMs = input.now();
    if (expiresAt > 0 && nowMs >= expiresAt - CHANNEL_EXPIRY_MARGIN_MS) {
      throw new ChannelExpiredError(state.handoff, nowMs);
    }
    // The last look before an irreversible transfer, and the only one that does not trust the
    // hand-off: the provider is asked what it has for this channel id. A read that fails is left
    // to throw, so the next tick retries rather than paying unchecked.
    await checkAgainstProvider(input, state.handoff);
    await input.onBeforePay?.(state.handoff);
    await bounded(input.pay(state.handoff), input.payTimeoutMs, "channel payment");
    state.paid = true;
    return { step: "handoff", reading: null };
  }
  const reading = await bounded(
    input.rail.status(state.handoff.id),
    input.tickTimeoutMs,
    "sale status read",
  );
  state.reading = reading;
  if (readingFailed(reading)) throw new RailFailedError(reading);
  return { step: reading.status === "complete" ? "done" : "follow", reading };
}
