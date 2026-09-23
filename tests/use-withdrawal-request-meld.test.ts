// useWithdrawalRequest's `start()` on the meld rail: the second of the two sites that used to
// hard-refuse "meld" (see app/stores/requests.ts's recordFromWithdrawJob for the other one).
// `withdrawHandoff`, `meldLandingHex`, `meldOrderRefFor` and `planckToDecimalString` are the real
// implementations here, via `importOriginal`; only the host-dependent I/O is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { MeldSellClientLike, MeldSellSessionRequest } from "@getsome/meld";
import { assetHubAddressFor } from "@getsome/withdraw";
import { setRequestsClock } from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  setMirrorStorage,
  setRecordStorage,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { useWithdrawalRequest } from "../app/composables/useWithdrawalRequest";
import { FIXTURE_NOW } from "./fixtures/requests";

vi.mock("../lib/host-account", () => ({ isHosted: () => true }));

const KEY_ADDRESS = "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ";
const KEY_HEX = `0x${"07".repeat(32)}` as `0x${string}`;

const seams = vi.hoisted(() => ({
  nextWithdrawNumber: vi.fn(async () => 4),
  withdrawKeyFor: vi.fn(async () => ({ address: "", publicKeyHex: "" as `0x${string}` })),
  advanceWithdrawCounter: vi.fn(async () => {}),
  requestKeyPayment: vi.fn(async () => {}),
}));
seams.withdrawKeyFor.mockResolvedValue({ address: KEY_ADDRESS, publicKeyHex: KEY_HEX });

// Only the host-dependent I/O is mocked; the pure pieces (withdrawHandoff, meldLandingHex,
// meldOrderRefFor, planckToDecimalString) are the real package, so this exercises them for real.
vi.mock("../lib/withdraw-live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/withdraw-live")>();
  return {
    ...actual,
    nextWithdrawNumber: seams.nextWithdrawNumber,
    withdrawKeyFor: seams.withdrawKeyFor,
    advanceWithdrawCounter: seams.advanceWithdrawCounter,
    requestKeyPayment: seams.requestKeyPayment,
  };
});
vi.mock("../lib/worker-rpc", () => ({
  getStorageWorkerManager: () => ({ isAvailable: () => true, call: async () => ({}) }),
}));

function fakeMeldClient(): MeldSellClientLike & {
  createSellSession: ReturnType<
    typeof vi.fn<
      (req: MeldSellSessionRequest) => ReturnType<MeldSellClientLike["createSellSession"]>
    >
  >;
} {
  return {
    getSellQuote: async () => {
      throw new Error("unused");
    },
    createSellSession: vi.fn(async (req: MeldSellSessionRequest) => ({
      fundingRequestId: "funding-req-1",
      sessionId: "s-1",
      externalSessionId: `${req.orderRef}-1`,
      widgetUrl: "https://sell.test",
    })),
  };
}

const DESTINATION = { chain: "Meld", asset: "Bank", address: "bank-ref" };
const EXPECTED_ORDER_REF = assetHubAddressFor(KEY_HEX);

describe("useWithdrawalRequest: constructing a meld withdrawal", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(null);
    setRequestsClock(() => FIXTURE_NOW);
    seams.nextWithdrawNumber.mockClear();
    seams.advanceWithdrawCounter.mockClear();
    seams.requestKeyPayment.mockClear();
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
  });

  it("opens the sell session under the key's own derived order ref, and builds a valid awaiting-deposit-address record", async () => {
    const client = fakeMeldClient();
    const { start } = useWithdrawalRequest();
    const outcome = await start({
      destinationId: "meld-bank",
      amount: 21_000_000n,
      destination: DESTINATION,
      // Ignored for a meld rail: the code computes the burner's own account, never this value.
      landingHex: `0x${"ff".repeat(32)}`,
      rail: "meld",
      meld: {
        client,
        serviceProvider: "TRANSAK",
        country: "US",
        sourceCurrencyCode: "DOT_ASSETHUB",
        destinationCurrencyCode: "USD",
        paymentMethodType: "ACH",
        committedAmount: 900_000_000n,
        quotedFiatAmount: "156.30",
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reason);

    const requests = useRequestsStore();
    const record = requests.get(outcome.ref);
    if (record?.rail.provider !== "meld") throw new Error("expected a meld rail");
    expect(record.rail.sale).toMatchObject({
      phase: "awaiting-deposit-address",
      meldFundingRequestId: "funding-req-1",
      committedAmount: "900000000",
      quotedFiatAmount: "156.30",
      quotedFiatCurrency: "USD",
    });
    // The burner's own Asset Hub account -- same bytes as its People public key -- never the
    // destination the user asked to receive at, and never the caller-supplied value.
    expect(record.handoff.landingHex).toBe(KEY_HEX);
    expect(record.destination).toEqual(DESTINATION);
    // No payout address yet: the worker cannot be handed a commitment it has nowhere to pay.
    expect(record.handoff.meld).toBeUndefined();
    expect(record.status).toEqual({ kind: "awaiting-payment" });

    expect(client.createSellSession).toHaveBeenCalledTimes(1);
    const sent = client.createSellSession.mock.calls[0]![0];
    // Derived from the key, not accepted from the caller: no such field exists on WithdrawalStart.
    expect(sent.orderRef).toBe(EXPECTED_ORDER_REF);
    expect(sent.serviceProvider).toBe("TRANSAK");
    expect(sent.sourceAmount).toBe("0.09"); // 900_000_000 planck at 10 decimals
    expect(sent.destinationCurrencyCode).toBe("USD");

    // Nothing is prompted here: the design's phase boundary is the sale's own KYC, not the
    // record's creation. A seller who opens a sale and abandons KYC must never have CASH parked
    // on a burner for a sale that did not happen. The reconcile store's own
    // `promptMeldPayments` prompts it, once the sale discloses a deposit address (see
    // tests/requests-withdrawal-meld-handoff.test.ts).
    expect(seams.requestKeyPayment).not.toHaveBeenCalled();
    expect(record.payment).toEqual({ attempt: 0 });
  });

  it("refuses a meld rail with no sale to commit to, building nothing", async () => {
    const { start } = useWithdrawalRequest();
    const outcome = await start({
      destinationId: "meld-bank",
      amount: 21_000_000n,
      destination: DESTINATION,
      landingHex: `0x${"ff".repeat(32)}`,
      rail: "meld",
    });
    expect(outcome).toMatchObject({ ok: false, ref: null });
    expect(seams.nextWithdrawNumber).not.toHaveBeenCalled();
  });

  it("mints a fresh order ref for a different withdrawal number, deriving from that key instead", async () => {
    const otherKeyHex = `0x${"08".repeat(32)}` as `0x${string}`;
    seams.withdrawKeyFor.mockResolvedValueOnce({
      address: "other-address",
      publicKeyHex: otherKeyHex,
    });
    const client = fakeMeldClient();
    const { start } = useWithdrawalRequest();
    await start({
      destinationId: "meld-bank",
      amount: 21_000_000n,
      destination: DESTINATION,
      landingHex: `0x${"ff".repeat(32)}`,
      rail: "meld",
      meld: {
        client,
        serviceProvider: "TRANSAK",
        country: "US",
        sourceCurrencyCode: "DOT_ASSETHUB",
        destinationCurrencyCode: "USD",
        paymentMethodType: "ACH",
        committedAmount: 50_000_000_000n,
        quotedFiatAmount: "8.68",
      },
    });
    const sent = client.createSellSession.mock.calls[0]![0];
    expect(sent.orderRef).toBe(assetHubAddressFor(otherKeyHex));
    expect(sent.orderRef).not.toBe(EXPECTED_ORDER_REF);
  });
});
