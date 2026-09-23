// The cancel boundary: nothing was paid, and — on a Meld sale — the provider has not yet
// disclosed a deposit address. `meldDepositKnown` can go true well before `paymentTaken` does, so
// this is the one invariant in the brief that a rank/payment check alone would miss.

import { describe, expect, it } from "vitest";
import { PAYMENT_WINDOW_MS, type WithdrawalRecord } from "../app/funding/requests/model";
import { requestRefOf } from "../app/utils/request-index";
import { withdrawalCancellable } from "../app/withdraw/cancel";

const STARTED = Date.UTC(2026, 8, 22, 9, 0, 0);
const REF = requestRefOf("wd:meld-bank", 1);

function baseRecord(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  return {
    schema: 3,
    kind: "withdrawal",
    ref: REF,
    rev: 0,
    updatedAt: STARTED,
    startedAt: STARTED,
    amountHuman: "25",
    route: "bank",
    destination: { chain: "Meld", asset: "Bank", address: "Your bank account" },
    key: { label: "wd:eph:meld-bank:1", address: "1key", publicKeyHex: `0x${"07".repeat(32)}` },
    payment: { attempt: 0 },
    deadline: { paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS },
    handoff: {
      label: "wd:eph:meld-bank:1",
      keyAddress: "1key",
      keyPublicKeyHex: `0x${"07".repeat(32)}`,
      amount: "25000000",
      destination: { chain: "Meld", asset: "Bank", address: "Your bank account" },
      landingHex: `0x${"aa".repeat(32)}`,
      rail: "meld",
      assetHubGenesis: "0xah",
      peopleGenesis: "0xpe",
      peopleParaId: 1004,
      assetHubParaId: 1000,
      poolAccount: "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B",
      slippagePct: 5,
      paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS,
    },
    status: { kind: "awaiting-payment" },
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
    witnesses: {},
    ...overrides,
  };
}

const directRecord = (overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord =>
  baseRecord({
    route: "crypto",
    destination: { chain: "Asset Hub", asset: "DOT", address: "15oF..." },
    rail: { provider: "direct", stage: "waiting", updatedAt: STARTED },
    ...overrides,
  });

describe("withdrawalCancellable", () => {
  it("allows cancelling a direct withdrawal that has not been paid", () => {
    expect(withdrawalCancellable(directRecord())).toBe(true);
  });

  it("refuses once a direct withdrawal's payment has been taken", () => {
    const record = directRecord({ payment: { attempt: 0, status: "processing" } });
    expect(withdrawalCancellable(record)).toBe(false);
  });

  it("refuses once the status has moved past awaiting-payment", () => {
    const record = directRecord({ status: { kind: "paid", at: STARTED, via: "host" } });
    expect(withdrawalCancellable(record)).toBe(false);
  });

  it("allows cancelling a Meld sale while its deposit address is not yet known", () => {
    expect(withdrawalCancellable(baseRecord())).toBe(true);
  });

  it("refuses a Meld sale once its deposit address is known, even though nothing has been paid", () => {
    const record = baseRecord({
      rail: {
        provider: "meld",
        stage: "waiting",
        updatedAt: STARTED,
        sale: {
          phase: "deposit-known",
          meldFundingRequestId: "funding-1",
          committedAmount: "900000000",
          quotedFiatAmount: "150.00",
          quotedFiatCurrency: "USD",
          deposit: {
            address: "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM",
            amount: "0.09",
            currency: "DOT_ASSETHUB",
            observedAt: STARTED,
          },
        },
      },
    });
    // Still `awaiting-payment` and nothing taken — the rank/payment check alone would say yes.
    expect(record.status.kind).toBe("awaiting-payment");
    expect(withdrawalCancellable(record)).toBe(false);
  });
});
