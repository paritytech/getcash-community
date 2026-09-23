// The withdrawal row's state: pinned here for the one thing this step adds -- a failed or
// expired row's reason grows the return's own note when the worker has one to report, so a
// seller scanning the list is not left wondering whether the money is simply gone.

import { describe, expect, it } from "vitest";
import type { WithdrawalRecord } from "../app/funding/requests/model";
import { withdrawalRowStateOf } from "../app/withdraw/rows";

const STARTED = Date.UTC(2026, 8, 17, 10, 0, 0);

function record(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  return {
    schema: 3,
    kind: "withdrawal",
    ref: { sourceId: "wd:pas-assethub", tradeN: 1 },
    rev: 0,
    updatedAt: STARTED,
    startedAt: STARTED,
    amountHuman: "21",
    route: "crypto",
    destination: { chain: "Asset Hub", asset: "PAS", address: "addr" },
    key: { label: "l", address: "addr", publicKeyHex: `0x${"00".repeat(32)}` },
    payment: { attempt: 0 },
    deadline: { paymentExpiresAt: STARTED },
    handoff: {
      label: "l",
      keyAddress: "addr",
      keyPublicKeyHex: `0x${"00".repeat(32)}`,
      amount: "21000000",
      destination: { chain: "Asset Hub", asset: "PAS", address: "addr" },
      landingHex: `0x${"00".repeat(32)}`,
      rail: "direct",
      assetHubGenesis: "0xah",
      peopleGenesis: "0xpe",
      peopleParaId: 1004,
      assetHubParaId: 1000,
      poolAccount: "pool",
      slippagePct: 5,
      paymentExpiresAt: STARTED,
    },
    status: { kind: "failed", at: STARTED, recoverable: true },
    rail: { provider: "direct", stage: "waiting", updatedAt: STARTED },
    failure: { kind: "timeout", step: "convert", message: "took too long", recoverable: true },
    witnesses: {},
    ...overrides,
  };
}

describe("withdrawalRowStateOf", () => {
  it("reads a plain failure with no return to add", () => {
    const state = withdrawalRowStateOf(record(), "Failed");
    expect(state).toMatchObject({
      kind: "failed",
      reason: "The conversion is taking longer than expected. You can try again.",
    });
    expect(state.kind === "failed" ? state.reason : "").not.toContain("balance");
  });

  it("appends the return's own note once the worker has one to report", () => {
    const state = withdrawalRowStateOf(
      record({
        return: {
          reason: "unwind",
          phase: "done",
          returned: true,
          returnedAmount: "21000000",
          nativeSeen: null,
          claim: null,
          txs: [],
        },
      }),
      "Failed",
    );
    expect(state.kind).toBe("failed");
    const reason = state.kind === "failed" ? (state.reason ?? "") : "";
    expect(reason).toContain("taking longer than expected");
    expect(reason).toContain("came back to your balance");
  });

  it("adds the return's note to a cancelled row too", () => {
    const state = withdrawalRowStateOf(
      record({
        status: { kind: "cancelled", at: STARTED },
        failure: undefined,
        return: {
          reason: "unwind",
          phase: "await-native",
          returned: false,
          returnedAmount: null,
          nativeSeen: null,
          claim: null,
          txs: [],
        },
      }),
      "Cancelled",
    );
    const reason = state.kind === "failed" ? (state.reason ?? "") : "";
    expect(reason).toContain("Cancelled");
    expect(reason).toContain("moving your funds back");
  });
});
