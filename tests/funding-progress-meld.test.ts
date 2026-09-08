// The Meld rail as progress: one provider stage ahead of the shared CASH stages.

import { describe, expect, it } from "vitest";
import {
  MELD_PAYMENT_STAGE,
  fundingProgressRegistry,
  fundingProgressSignalForPaymentState,
  meldProgressProvider,
  observeMeldProgress,
} from "../app/funding/progress";
import type { PaymentState } from "@getsome/core";

describe("Meld progress provider", () => {
  it("is registered next to the crypto rail's", () => {
    expect(
      fundingProgressRegistry
        .list()
        .map(({ id }) => id)
        .sort(),
    ).toEqual(["chainflip", "meld"]);
  });

  it("composes one payment stage ahead of the shared CASH stages, in the buyer's words", () => {
    const profile = meldProgressProvider.createProfile();
    expect(profile.stages.map(({ key }) => key)).toEqual([
      MELD_PAYMENT_STAGE,
      "cash-conversion",
      "cash-teleport",
      "cash-top-up",
    ]);
    expect(profile.routeStageCount).toBe(1);
    expect(profile.waitingLabel).toBe("Waiting for your payment");
    expect(profile.routeCompletedLabel).toBe("Payment confirmed");
    expect(profile.startedNodeLabel).toBe("Payment started");
  });

  it("scales the payment stage to the rail: minutes for a card, a day for a bank transfer", () => {
    const card = meldProgressProvider.createProfile({ ingressDurationMs: 5 * 60_000 });
    const bank = meldProgressProvider.createProfile({ ingressDurationMs: 24 * 60 * 60_000 });
    expect(card.stages[0]!.nominalMs).toBe(5 * 60_000);
    expect(bank.stages[0]!.nominalMs).toBe(24 * 60 * 60_000);
    expect(bank.stages[1]!.nominalMs).toBe(card.stages[1]!.nominalMs); // shared stages untouched
  });

  it("maps the normalized statuses and holds on anything else", () => {
    expect(observeMeldProgress("waiting")).toEqual({ kind: "waiting" });
    expect(observeMeldProgress("receiving")).toEqual({
      kind: "stage",
      stageKey: MELD_PAYMENT_STAGE,
    });
    expect(observeMeldProgress("complete")).toEqual({ kind: "route-complete" });
    expect(observeMeldProgress("swapping")).toEqual({ kind: "hold" });
    expect(observeMeldProgress("session_opened")).toEqual({ kind: "hold" });
  });

  it("reaches the provider through the session's swapping phase", () => {
    const receiving = {
      phase: "swapping",
      sourceId: "meld-card",
      swap: "receiving",
    } as PaymentState;
    const complete = { phase: "swapping", sourceId: "meld-card", swap: "complete" } as PaymentState;
    expect(fundingProgressSignalForPaymentState(meldProgressProvider, receiving)).toEqual({
      observation: { kind: "stage", stageKey: MELD_PAYMENT_STAGE },
      routeStatus: "receiving",
    });
    expect(fundingProgressSignalForPaymentState(meldProgressProvider, complete)).toEqual({
      observation: { kind: "route-complete" },
      routeStatus: "complete",
    });
  });
});
