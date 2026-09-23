// The provider leg of a withdrawal. Once the PAS sits on the key's own Asset Hub account, a
// provider carries it to the destination the user named. Two moves, at most one per tick: pay
// the provider's channel with everything the key holds, then read the swap until the provider
// says it is delivered or that it failed.
//
// THE CHANNEL IS OPENED ELSEWHERE. The page opens it at confirm, while the user is there and
// with the quote they were shown, and the hand-off carries it here. This leg never opens one.
//
// THE KEY PAYS, THE MESSAGE DOES NOT. Chainflip credits a deposit on Asset Hub only from a
// balance transfer event inside an extrinsic. The message lands the native by XCM, which mints
// it without such an event, so native landed in the channel that way is never witnessed and is
// lost. The message therefore lands on the key, and the key pays the channel with a transfer.
//
// PROVIDER AGNOSTIC. The provider is a client with one call, status, and the payment is a hand
// the driver supplies, the sweep of the key. Chainflip and Meld each plug in behind that shape;
// nothing here knows which one it is talking to.
//
// RE-ENTRANT, like the message leg. The state is the driver's to persist; a tick that throws is
// retried on the next tick. Terminal is the provider's own verdict: delivered, or a failure it
// names.

import type { SwapStatusResult } from "@getsome/core";
import { bounded } from "./bounded";
import { freshSweepState, type SweepState } from "./sweep";
import { DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS, DEFAULT_WITHDRAW_TICK_TIMEOUT_MS } from "./tick";

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
 * closed one is neither swapped nor refunded. So the margin covers this leg's own bounds and
 * leaves the provider time to see the transfer.
 *
 * Erring long is cheap: refusing early costs a retry on a fresh channel, with nothing moved.
 * Erring short costs the whole withdrawal.
 */
export const CHANNEL_EXPIRY_MARGIN_MS =
  DEFAULT_WITHDRAW_TICK_TIMEOUT_MS + DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS + 600_000;

/** Cross-tick memory for the leg. The driver persists it; `railTickOnce` mutates it. */
export interface RailLegState {
  /** Seeded by the driver from the hand-off; null means there is nothing to pay yet. */
  handoff: RailHandoff | null;
  /** The key paid the channel. */
  paid: boolean;
  /** The sweep's own memory, for the hand that pays. */
  sweep: SweepState;
  /** The provider's latest word on the swap. */
  reading: SwapStatusResult | null;
}

export const freshRailLegState = (): RailLegState => ({
  handoff: null,
  paid: false,
  sweep: freshSweepState(),
  reading: null,
});

/** A provider, bound to one network: the swap behind a channel, as it stands. */
export interface RailClient {
  status(id: string): Promise<SwapStatusResult>;
}

export interface RailLegInput {
  rail: RailClient;
  /** Moves everything the key holds on Asset Hub to the channel; resolves once the key is
   *  empty. The sweep state is its to keep across ticks. */
  pay: (handoff: RailHandoff, sweep: SweepState) => Promise<void>;
  /** Bound on a provider call. */
  tickTimeoutMs: number;
  /** Bound on the payment's resolution. */
  payTimeoutMs: number;
  /** Read once per tick, to judge the channel against its expiry. */
  now: () => number;
  /** Runs before the payment leaves, so the driver can persist what it is about to pay. */
  onBeforePay?: (handoff: RailHandoff) => Promise<void> | void;
}

export interface RailLegOutcome {
  step: RailStep;
  reading: SwapStatusResult | null;
}

/**
 * The channel is at or past its expiry, so the key must not pay it: the provider does not witness
 * a deposit into a closed channel, and what lands there is neither swapped nor refunded. Terminal
 * for this channel, and recoverable through a fresh one, since nothing has moved.
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
    super(`the provider reported the swap failed: ${describeFailure(reading)}`);
    this.name = "RailFailedError";
  }
}

/** The provider's ending, in a line; mirrors how the surface reads a status. */
export function describeFailure(reading: SwapStatusResult): string {
  const failure = reading.depositFailure ?? reading.swapEgressFailure;
  if (failure?.reason?.message) return failure.reason.message;
  if (reading.fallbackEgress) return "the funds were routed to a fallback";
  return "the deposit is being refunded";
}

/** An ms instant for a message. Never throws: a nonsense time must not turn a refusal to pay
 *  into an error the driver reads as transient and retries forever. */
function stamp(ms: number): string {
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? `${ms}ms` : at.toISOString();
}

export const readingFailed = (reading: SwapStatusResult): boolean =>
  reading.status === "failed" ||
  reading.depositFailure !== undefined ||
  reading.swapEgressFailure !== undefined ||
  reading.fallbackEgress !== undefined;

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
    // Checked before the money moves, not on the way in: every path here pays the same way, and a
    // channel can go stale between the hand-off and the tick that acts on it.
    const { expiresAt } = state.handoff;
    const nowMs = input.now();
    if (expiresAt > 0 && nowMs >= expiresAt - CHANNEL_EXPIRY_MARGIN_MS) {
      throw new ChannelExpiredError(state.handoff, nowMs);
    }
    await input.onBeforePay?.(state.handoff);
    await bounded(input.pay(state.handoff, state.sweep), input.payTimeoutMs, "channel payment");
    state.paid = true;
    return { step: "handoff", reading: null };
  }
  const reading = await bounded(
    input.rail.status(state.handoff.id),
    input.tickTimeoutMs,
    "swap status read",
  );
  state.reading = reading;
  if (readingFailed(reading)) throw new RailFailedError(reading);
  return { step: reading.status === "complete" ? "done" : "follow", reading };
}
