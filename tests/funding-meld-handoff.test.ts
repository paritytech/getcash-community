// The Meld rail's handoff predicate: the widget shows while this is true, and the moment it turns
// false the package hands the request to the shell's journey.

import { describe, expect, it } from "vitest";
import { meldDepositPending } from "../app/funding/meld-handoff";

const waiting = {
  fundsSeen: false,
  meldHandedOff: false,
  meldStage: "waiting" as const,
  awaitingDeposit: true,
  awaitingBuyer: false,
};

describe("meldDepositPending", () => {
  it("waits while the buyer is still inside the widget", () => {
    expect(meldDepositPending(waiting)).toBe(true);
    expect(meldDepositPending({ ...waiting, meldStage: null })).toBe(true);
  });

  it("ends the wait once the provider approved the payment or the buyer left the widget", () => {
    expect(meldDepositPending({ ...waiting, meldHandedOff: true, meldStage: "receiving" })).toBe(
      false,
    );
    expect(meldDepositPending({ ...waiting, meldStage: "complete" })).toBe(false);
  });

  it("ends the wait once the native token landed, whatever the provider says", () => {
    expect(meldDepositPending({ ...waiting, fundsSeen: true })).toBe(false);
  });

  it("ends the wait on a failure, so the journey can say why", () => {
    expect(meldDepositPending({ ...waiting, meldStage: "failed" })).toBe(false);
  });

  it("ends the wait once the request left its deposit", () => {
    expect(meldDepositPending({ ...waiting, awaitingDeposit: false })).toBe(false);
  });

  it("keeps waiting while the rail has filed a transaction the buyer has not paid", () => {
    // A provider filing its transaction as the card form loads moves the request off its deposit
    // before the buyer has typed a card number.
    const filed = { ...waiting, awaitingDeposit: false, awaitingBuyer: true };
    expect(meldDepositPending(filed)).toBe(true);
    expect(meldDepositPending({ ...filed, meldHandedOff: true })).toBe(false);
    expect(meldDepositPending({ ...filed, fundsSeen: true })).toBe(false);
    expect(meldDepositPending({ ...filed, meldStage: "complete" })).toBe(false);
    expect(meldDepositPending({ ...filed, meldStage: "failed" })).toBe(false);
  });
});
