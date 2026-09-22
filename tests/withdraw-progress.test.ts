// The withdrawal's journey projection and its list rows, read from a record's status.

import { describe, expect, it } from "vitest";
import { PAYMENT_WINDOW_MS, type WithdrawalRecord } from "../app/funding/requests/model";
import { requestRefOf } from "../app/utils/request-index";
import {
  WITHDRAWAL_JOURNEY_LABELS,
  withdrawalJourneyDone,
  withdrawalProgress,
} from "../app/withdraw/progress";
import { projectWithdrawalTopUps, withdrawalRequestRef } from "../app/withdraw/rows";

const MINUTE = 60_000;
const STARTED = Date.UTC(2026, 8, 17, 10, 0, 0);
const at = (minutes: number) => STARTED + minutes * MINUTE;
const REF = requestRefOf("wd:dot-assethub", 3);

function record(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  return {
    schema: 2,
    kind: "withdrawal",
    ref: REF,
    rev: 0,
    updatedAt: STARTED,
    startedAt: STARTED,
    amountHuman: "25",
    route: "crypto",
    destination: {
      chain: "Asset Hub",
      asset: "DOT",
      address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
    },
    key: { label: "wd:eph:dot-assethub:3", address: "1key", publicKeyHex: `0x${"07".repeat(32)}` },
    payment: { attempt: 0, requestedAt: STARTED, id: `0x${"07".repeat(32)}` },
    deadline: { paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS },
    handoff: {
      label: "wd:eph:dot-assethub:3",
      keyAddress: "1key",
      keyPublicKeyHex: `0x${"07".repeat(32)}`,
      amount: "25000000",
      destination: {
        chain: "Asset Hub",
        asset: "DOT",
        address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
      },
      landingHex: `0x${"aa".repeat(32)}`,
      rail: "direct",
      assetHubGenesis: "0xah",
      peopleGenesis: "0xpe",
      peopleParaId: 1004,
      assetHubParaId: 1000,
      poolAccount: "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B",
      slippagePct: 5,
      paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS,
    },
    status: { kind: "awaiting-payment" },
    rail: { provider: "direct", stage: "waiting", updatedAt: STARTED },
    witnesses: {},
    ...overrides,
  };
}

describe("withdrawal progress", () => {
  it("names the three markers Started, Conversion and Sent", () => {
    expect(WITHDRAWAL_JOURNEY_LABELS).toEqual(["Started", "Conversion", "Sent"]);
    const view = withdrawalProgress(record(), at(1)).view;
    expect(view.nodes.map((node) => node.label)).toEqual(["Started", "Conversion", "Sent"]);
  });

  it("waits for the payment, then counts the markers the status completed", () => {
    const waiting = withdrawalProgress(record(), at(1));
    expect(waiting.view.kind).toBe("waiting");
    expect(waiting.view.label).toBe("Waiting for your payment");
    expect(waiting.estimateText).toBe("≈5 min after you pay");
    expect(withdrawalJourneyDone(record())).toBe(0);

    const paid = record({ status: { kind: "paid", at: at(2), via: "host" } });
    expect(withdrawalProgress(paid, at(3)).view.label).toBe("Converting your $CASH");
    expect(withdrawalJourneyDone(paid)).toBe(1);

    const converting = record({ status: { kind: "converting", at: at(3), step: "await-arrival" } });
    expect(withdrawalJourneyDone(converting)).toBe(1);

    const sending = record({
      status: { kind: "sending", at: at(5) },
      rail: { provider: "chainflip", stage: "delivering", updatedAt: at(5) },
    });
    expect(withdrawalProgress(sending, at(6)).view.label).toBe("Sending to your address");
    expect(withdrawalJourneyDone(sending)).toBe(2);

    const sent = record({ status: { kind: "sent", at: at(6) } });
    const done = withdrawalProgress(sent, at(7));
    expect(done.view.kind).toBe("settled");
    expect(done.view.label).toBe("Sent");
    expect(withdrawalJourneyDone(sent)).toBe(3);
  });

  it("fails at the leg the failure left", () => {
    const payment = record({
      status: { kind: "failed", at: at(2), recoverable: true },
      failure: { kind: "payment-failed", step: "payment", message: "Declined", recoverable: true },
    });
    expect(withdrawalProgress(payment, at(3)).view.kind).toBe("failed");
    expect(withdrawalJourneyDone(payment)).toBe(0);

    const convert = record({
      status: { kind: "failed", at: at(4), recoverable: true },
      failure: { kind: "rejected", step: "convert", message: "rejected", recoverable: true },
    });
    expect(withdrawalProgress(convert, at(5)).view.kind).toBe("failed");
    expect(withdrawalJourneyDone(convert)).toBe(1);
  });
});

describe("withdrawal rows", () => {
  it("projects a record into the shell's row with the destination's icons and a state", () => {
    const [row] = projectWithdrawalTopUps(
      [record({ status: { kind: "converting", at: at(3), step: "swap" } })],
      at(4),
    );
    expect(row).toMatchObject({
      id: "withdraw:wd:dot-assethub#3",
      amount: "25",
      route: "crypto",
      startedAt: STARTED,
      details: {
        network: { label: "Asset Hub", icon: "/icons/polkadot.svg" },
        token: { label: "DOT", icon: "/icons/polkadot.svg" },
      },
      state: { kind: "finishing", status: "Converting your $CASH" },
    });
    expect(withdrawalRequestRef(row!.id)).toEqual(REF);
    expect(withdrawalRequestRef("crypto:dot-assethub#3")).toBeNull();
  });

  it("words the side exits from the failure kind, and a sent record as settled", () => {
    const [expired] = projectWithdrawalTopUps([
      record({
        status: { kind: "expired", at: at(40) },
        failure: { kind: "expired", step: "payment", message: "x", recoverable: false },
      }),
    ]);
    expect(expired!.state).toEqual({
      kind: "failed",
      at: at(40),
      reason: "This withdrawal expired because the payment never arrived.",
    });
    const [sent] = projectWithdrawalTopUps([record({ status: { kind: "sent", at: at(6) } })]);
    expect(sent!.state).toEqual({ kind: "settled", at: at(6) });
  });

  it("projects a Meld sale under its payout route, with no crypto destination to look up", () => {
    const [row] = projectWithdrawalTopUps([
      record({
        ref: requestRefOf("wd:meld-bank", 1),
        route: "bank",
        destination: { chain: "Meld", asset: "Bank", address: "Your bank account" },
        rail: {
          provider: "meld",
          stage: "waiting",
          updatedAt: STARTED,
          sale: {
            phase: "awaiting-deposit-address",
            meldFundingRequestId: "funding-1",
            committedAmount: "900000000",
            quotedFiatAmount: "150.00",
            quotedFiatCurrency: "USD",
          },
        },
      }),
    ]);
    expect(row).toMatchObject({ route: "bank" });
    expect(row!.details).toBeUndefined();
  });
});
