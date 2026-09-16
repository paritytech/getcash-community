// The rail leg: both providers' normalised statuses onto the generic stage, and the monotonic
// merge. The statuses come from the real adapters over fake backends.

import { describe, expect, it } from "vitest";
import { getSwapStatus } from "@getsome/chainflip";
import type { FailureKind, SwapStatusResult } from "@getsome/core";
import { getMeldStatus } from "@getsome/meld";
import type { RailState } from "../app/funding/requests/model";
import { mergeRail, railFromSwapStatus } from "../app/funding/requests/rail";

const AT = 1_700_000_000_000;

type Stage = RailState["stage"];
interface Expected {
  status: RailState["status"];
  stage: Stage;
  failure?: { kind: FailureKind; message: string; code?: string };
  delayed?: boolean;
}

/** A Chainflip status as the SDK's v2 status endpoint reports it. */
const chainflip = (raw: Record<string, unknown>) =>
  getSwapStatus({ getStatusV2: async () => raw }, "123-Bitcoin-45");

/** A Meld status as the adapter reports it. */
const meld = (status: string) =>
  getMeldStatus(
    {
      getQuote: () => Promise.reject(new Error("not under test")),
      createSession: () => Promise.reject(new Error("not under test")),
      getStatus: async () => ({ status, sourceAmount: "52.06", fiat: "USD" }),
    },
    "mfr-1",
  );

describe("rail mapping", () => {
  it("maps every Chainflip and Meld status to the design's stage", async () => {
    const chainflipCases: [Record<string, unknown>, Expected][] = [
      [{ state: "WAITING" }, { status: "waiting", stage: "waiting" }],
      [{ state: "SOMETHING_NEW" }, { status: "waiting", stage: "waiting" }],
      [{ state: "RECEIVING" }, { status: "receiving", stage: "received" }],
      [{ state: "SWAPPING" }, { status: "swapping", stage: "processing" }],
      [{ state: "SENDING" }, { status: "sending", stage: "processing" }],
      [{ state: "SENT" }, { status: "sending", stage: "processing" }],
      [{ state: "COMPLETED" }, { status: "complete", stage: "delivered" }],
      [
        { state: "FAILED" },
        {
          status: "failed",
          stage: "failed",
          failure: {
            kind: "refunded",
            message:
              "The deposit didn't go through. It is being returned to your recovery address.",
          },
        },
      ],
      // Implicit failures: the SDK's top-level state stays on the happy path.
      [
        { state: "RECEIVING", deposit: { failure: { reason: { message: "Below minimum" } } } },
        {
          status: "receiving",
          stage: "failed",
          failure: { kind: "deposit-rejected", message: "Below minimum" },
        },
      ],
      [
        { state: "SWAPPING", deposit: { failure: { mode: "DEPOSIT_TOO_SMALL" } } },
        {
          status: "swapping",
          stage: "failed",
          failure: {
            kind: "deposit-rejected",
            message: "Deposit rejected by Chainflip; funds not recoverable",
          },
        },
      ],
      [
        { state: "SENDING", swapEgress: { failure: { reason: { message: "Egress stalled" } } } },
        {
          status: "sending",
          stage: "failed",
          failure: { kind: "egress-failed", message: "Egress stalled" },
        },
      ],
      [
        { state: "COMPLETED", fallbackEgress: { amount: "1" } },
        {
          status: "complete",
          stage: "failed",
          failure: {
            kind: "fallback-egress",
            message: "Funds routed to a fallback chain. Contact support",
          },
        },
      ],
    ];
    for (const [raw, want] of chainflipCases) {
      const result = await chainflip(raw);
      expect(railFromSwapStatus("chainflip", result, AT), JSON.stringify(raw)).toEqual({
        provider: "chainflip",
        updatedAt: AT,
        ...want,
      });
    }

    // Every Meld ending carries the adapter's own code, which the record keeps: it is what tells
    // a refund from a decline, and an unobserved payment from either.
    const meldCases: [string, Expected][] = [
      ["created", { status: "waiting", stage: "waiting" }],
      ["session_opened", { status: "waiting", stage: "waiting" }],
      ["a_state_added_later", { status: "waiting", stage: "waiting" }],
      ["transaction_seen", { status: "receiving", stage: "received" }],
      ["crypto_failed", { status: "receiving", stage: "received", delayed: true }],
      ["transaction_crypto_failed", { status: "receiving", stage: "received", delayed: true }],
      ["settled", { status: "complete", stage: "delivered" }],
      [
        "failed",
        {
          status: "failed",
          stage: "failed",
          failure: {
            kind: "deposit-rejected",
            message: "Top-up didn't go through. No money was taken.",
            code: "failed",
          },
        },
      ],
      [
        "expired",
        {
          status: "failed",
          stage: "failed",
          failure: {
            kind: "expired",
            message: "The payment window closed before the payment arrived.",
            code: "expired",
          },
        },
      ],
      [
        "refused",
        {
          status: "failed",
          stage: "failed",
          failure: {
            kind: "deposit-rejected",
            message: "The payment was declined before it started.",
            code: "refused",
          },
        },
      ],
      [
        "declined",
        {
          status: "failed",
          stage: "failed",
          failure: {
            kind: "deposit-rejected",
            message: "Your bank declined the payment. Check your card details or try another card.",
            code: "declined",
          },
        },
      ],
      [
        "refunded",
        {
          status: "failed",
          stage: "failed",
          failure: {
            kind: "deposit-rejected",
            message:
              "Your top-up didn't go through. Your 52.06 USD has been returned to your card.",
            code: "refunded",
          },
        },
      ],
      [
        "unobserved",
        {
          status: "failed",
          stage: "failed",
          failure: {
            kind: "unknown",
            message: "We could not confirm this payment. Contact support before trying again.",
            code: "unobserved",
          },
        },
      ],
    ];
    for (const [status, want] of meldCases) {
      const result = await meld(status);
      expect(railFromSwapStatus("meld", result, AT, result.delayed), status).toEqual({
        provider: "meld",
        updatedAt: AT,
        ...want,
      });
    }
  });

  it("mergeRail never moves a stage backwards except to failed", () => {
    const rail = (
      stage: Stage,
      status: RailState["status"],
      updatedAt: number,
      delayed?: boolean,
    ): RailState => ({
      provider: "meld",
      status,
      stage,
      ...(delayed === undefined ? {} : { delayed }),
      updatedAt,
    });
    const failure: SwapStatusResult = {
      status: "failed",
      depositFailure: { reason: { message: "declined" }, kind: "deposit-rejected" },
    };
    const waiting = rail("waiting", "waiting", 1);
    const received = rail("received", "receiving", 2);
    const processing = rail("processing", "swapping", 3);
    const delivered = rail("delivered", "complete", 4);
    const failed = railFromSwapStatus("meld", failure, 5);

    // Forward, and a same-stage read with another status is the newer one.
    expect(mergeRail(waiting, received)).toBe(received);
    expect(mergeRail(received, processing)).toBe(processing);
    expect(mergeRail(processing, delivered)).toBe(delivered);
    const sending = rail("processing", "sending", 6);
    expect(mergeRail(processing, sending)).toBe(sending);

    // An identical status is the very same rail: a repeated read is not a change.
    expect(mergeRail(received, rail("received", "receiving", 6))).toBe(received);
    expect(mergeRail(delivered, rail("received", "receiving", 7))).toBe(delivered);

    // Backwards keeps the stage; only a delay marker that changed follows the latest read, with
    // its time.
    expect(mergeRail(delivered, rail("received", "receiving", 8, true))).toEqual(
      rail("delivered", "complete", 8, true),
    );
    expect(
      mergeRail(rail("delivered", "complete", 8, true), rail("waiting", "waiting", 9)),
    ).toEqual(rail("delivered", "complete", 9));
    const delayedReceived = rail("received", "receiving", 9, true);
    expect(mergeRail(received, delayedReceived)).toBe(delayedReceived);
    const undelayed = rail("received", "receiving", 9, false);
    expect(mergeRail(undelayed, received)).toBe(undelayed);

    // Failed is reached from any stage and is not left by a later happy-path read.
    expect(mergeRail(waiting, failed)).toBe(failed);
    expect(mergeRail(delivered, failed)).toBe(failed);
    expect(mergeRail(failed, rail("delivered", "complete", 10))).toBe(failed);
  });
});
