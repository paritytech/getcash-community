// The page's side of a fiat sale: confirm opens the provider's SELL session for the committed
// figure, naming no wallet, and writes a record that waits on KYC, asking nothing of the
// purse; the provider's deposit address becomes the channel; only then is the price checked and
// the purse asked; a cancel during KYC withdraws the order at the provider too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createFakeMeldClient } from "@getsome/meld";
import {
  PAYMENT_WINDOW_MS,
  SALE_WINDOW_MS,
  setRequestsClock,
  type WithdrawalRecord,
} from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  setMirrorStorage,
  setRecordStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { setMeldSellClient } from "../app/withdraw/meld-client";
import { FIXTURE_NOW } from "./fixtures/requests";

const KEY_HEX = `0x${"07".repeat(32)}`;
const KEY_ADDRESS = "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ";
/** The key the number after the first derives. */
const NEXT_KEY_ADDRESS = "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM";
const COMMITTED = 234_521_000_000n;

/** The host's counter, as `advanceWithdrawCounter` leaves it. */
const counter = vi.hoisted(() => ({ next: 1 }));

vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
const workerCall = vi.fn(async () => ({}));
vi.mock("../lib/worker-rpc", () => ({
  getStorageWorkerManager: () => ({ isAvailable: () => true, call: workerCall }),
}));
vi.mock("../lib/withdraw-live", () => ({
  PaymentRefusedError: class PaymentRefusedError extends Error {},
  cashCanMove: vi.fn(async () => true),
  nextWithdrawNumber: async () => counter.next,
  withdrawKeyFor: async (_sourceId: string, n: number) => ({
    address: n === 1 ? KEY_ADDRESS : NEXT_KEY_ADDRESS,
    publicKeyHex: KEY_HEX,
  }),
  advanceWithdrawCounter: vi.fn(async (_sourceId: string, n: number) => {
    counter.next = n + 1;
  }),
  requestKeyPayment: vi.fn(async () => {}),
  nudgeWithdrawTicks: () => {},
  openWithdrawChannelFor: vi.fn(async () => {
    throw new Error("a sale never opens a Chainflip channel");
  }),
  sendWithdrawHandoff: vi.fn(async () => {}),
  cancelWithdrawJob: vi.fn(async () => ({})),
  probeWithdrawKey: vi.fn(async () => ({ address: KEY_ADDRESS, cash: 0n })),
  readPaymentStatus: async () => ({ status: "not-found" }),
  meldCommitmentFundable: vi.fn(async () => true),
  meldHandoffConfig: () => ({ baseUrl: "https://adapter.test", productId: "getcash.dev" }),
  withdrawHandoff: (
    args: Record<string, unknown> & { key: { address: string; publicKeyHex: string } },
  ) => ({
    label: "wd:eph:meld-bank:1",
    keyAddress: args.key.address,
    keyPublicKeyHex: args.key.publicKeyHex,
    amount: String(args.amount),
    destination: args.destination,
    landingHex: args.landingHex,
    rail: args.rail,
    assetHubGenesis: "0xah",
    peopleGenesis: "0xpe",
    peopleParaId: 1004,
    assetHubParaId: 1000,
    poolAccount: "5Pool",
    slippagePct: 5,
    paymentExpiresAt: args.paymentExpiresAt,
    ...(args.meld === undefined ? {} : { meld: args.meld }),
  }),
}));

import * as live from "../lib/withdraw-live";
import { useWithdrawalRequest } from "../app/composables/useWithdrawalRequest";

const handedOff = vi.mocked(live.sendWithdrawHandoff);
const asked = vi.mocked(live.requestKeyPayment);
const fundable = vi.mocked(live.meldCommitmentFundable);
const advanced = vi.mocked(live.advanceWithdrawCounter);
const probed = vi.mocked(live.probeWithdrawKey);

function fakeWebStorage(): WebStorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

const QUOTE = {
  serviceProvider: "TRANSAK",
  sourceAmount: "23.4521",
  destinationAmount: "90.12",
  totalFee: "3.10",
  partnerFee: "0.50",
};

describe("a fiat sale from the page", () => {
  let meld: ReturnType<typeof createFakeMeldClient>;

  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => FIXTURE_NOW);
    meld = createFakeMeldClient({ sellPollsBeforeDeposit: 1 });
    setMeldSellClient(meld);
    handedOff.mockClear();
    asked.mockClear();
    fundable.mockClear().mockResolvedValue(true);
    advanced.mockClear();
    probed.mockClear();
    counter.next = 1;
    workerCall.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    requests.stopSalePoll();
    await requests.flush();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMirrorStorage(null);
    setMeldSellClient(null);
  });

  const startSale = () =>
    useWithdrawalRequest().startSale({
      method: "bank",
      amount: 100_000_000n,
      country: "DE",
      fiat: "EUR",
      paymentMethodType: "SEPA",
      quote: QUOTE,
      cryptoAmount: COMMITTED,
    });

  /** Reads the sale until the provider names its deposit address. */
  async function toDeposit(ref: Parameters<ReturnType<typeof useRequestsStore>["get"]>[0]) {
    const requests = useRequestsStore();
    const record = requests.get(ref) as WithdrawalRecord;
    for (let i = 0; i < 2; i += 1) {
      await requests.observeSaleStatus(ref, meld, record.sale!.fundingRequestId);
    }
    return requests.get(ref) as WithdrawalRecord;
  }

  it("opens the sale for the committed figure and waits on KYC, asking nothing yet", async () => {
    const spy = vi.spyOn(meld, "createSellSession");
    const outcome = await startSale();
    expect(outcome.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceProvider: "TRANSAK",
        orderRef: KEY_ADDRESS,
        sourceCurrencyCode: "DOT_ASSETHUB",
        sourceAmount: "23.4521",
        destinationCurrencyCode: "EUR",
        paymentMethodType: "SEPA",
      }),
    );
    // Optional on a sale, and the adapter refuses it: no wallet is named.
    expect(spy.mock.calls[0]![0]).not.toHaveProperty("walletAddress");
    if (!outcome.ok) return;
    const record = useRequestsStore().get(outcome.ref) as WithdrawalRecord;
    expect(record).toMatchObject({
      route: "bank",
      rail: { provider: "meld" },
      status: { kind: "awaiting-payment" },
      payment: { attempt: 0 },
      deadline: { paymentExpiresAt: FIXTURE_NOW + SALE_WINDOW_MS },
      sale: {
        fundingRequestId: "mock-sell-1",
        cryptoAmount: COMMITTED.toString(),
        quotedPayout: "90.12",
      },
      handoff: { rail: "meld", meld: { baseUrl: "https://adapter.test" } },
    });
    expect(record.handoff.channel).toBeUndefined();
    expect(asked).not.toHaveBeenCalled();
    expect(handedOff).not.toHaveBeenCalled();
    // The screen that asked takes the sale to the front, if it is still up; opening it does not.
    expect(useRequestsStore().foregroundWithdrawal).toBeNull();
  });

  it("creates nothing when the provider will not open the sale", async () => {
    vi.spyOn(meld, "createSellSession").mockRejectedValue(
      new Error("Not available in your region yet."),
    );
    const outcome = await startSale();
    expect(outcome).toEqual({ ok: false, reason: "Not available in your region yet." });
    expect(useRequestsStore().withdrawals).toEqual([]);
  });

  it("asks the purse and hands the sale over once the address is known and the price holds", async () => {
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    const known = await toDeposit(outcome.ref);
    expect(known.handoff.channel).toMatchObject({
      id: "mock-sell-1",
      amount: COMMITTED.toString(),
    });

    const paid = await useWithdrawalRequest().paySale(outcome.ref);
    expect(paid).toEqual({ ok: true });
    expect(fundable).toHaveBeenCalledWith(100_000_000n, COMMITTED, known.handoff.channel!.address);
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ amount: 100_000_000n }));
    expect(handedOff).toHaveBeenCalledTimes(1);
    const [, , payload] = handedOff.mock.calls[0]!;
    expect(payload).toMatchObject({
      rail: "meld",
      channel: { id: "mock-sell-1", amount: COMMITTED.toString() },
      meld: { baseUrl: "https://adapter.test" },
    });
  });

  it("asks nothing before the provider has named its address", async () => {
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    const paid = await useWithdrawalRequest().paySale(outcome.ref);
    expect(paid.ok).toBe(false);
    expect(asked).not.toHaveBeenCalled();
  });

  it("ends the sale with nothing taken when the price moved too far during KYC", async () => {
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    await toDeposit(outcome.ref);
    fundable.mockResolvedValue(false);
    const paid = await useWithdrawalRequest().paySale(outcome.ref);
    expect(paid.ok).toBe(false);
    expect(asked).not.toHaveBeenCalled();
    expect(handedOff).not.toHaveBeenCalled();
    expect(useRequestsStore().get(outcome.ref)).toMatchObject({
      status: { kind: "failed", recoverable: false },
      failure: { kind: "unfundable" },
    });
  });

  it("waits, rather than ending the sale, when the price cannot be checked", async () => {
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    await toDeposit(outcome.ref);
    fundable.mockRejectedValue(new Error("Asset Hub cannot quote the sale"));
    const paid = await useWithdrawalRequest().paySale(outcome.ref);
    expect(paid.ok).toBe(false);
    expect(useRequestsStore().get(outcome.ref)?.status.kind).toBe("awaiting-payment");
  });

  it("withdraws the order at the provider when the seller cancels during KYC", async () => {
    const cancelled = vi.spyOn(meld, "cancel");
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(await useWithdrawalRequest().cancel(outcome.ref)).toBe("ok");
    expect(useRequestsStore().get(outcome.ref)?.status.kind).toBe("cancelled");
    expect(cancelled).toHaveBeenCalledWith("mock-sell-1");
  });

  it("cancels a sale whose purse was never asked without reading People", async () => {
    probed.mockRejectedValue(new Error("People unreachable"));
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    await toDeposit(outcome.ref);
    expect(await useWithdrawalRequest().cancel(outcome.ref)).toBe("ok");
    expect(probed).not.toHaveBeenCalled();
    expect(useRequestsStore().get(outcome.ref)?.status.kind).toBe("cancelled");
    probed.mockReset().mockResolvedValue({ address: KEY_ADDRESS, cash: 0n });
  });

  it("does not ask the purse while a cancel is under way", async () => {
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    await toDeposit(outcome.ref);
    const withdrawal = useWithdrawalRequest();
    // A purse that refused once: the key is read before a cancel stands, which takes a while.
    asked.mockRejectedValueOnce(new live.PaymentRefusedError("declined"));
    await withdrawal.paySale(outcome.ref);
    await vi.waitFor(() => expect(useRequestsStore().get(outcome.ref)?.status.kind).toBe("failed"));
    expect(await withdrawal.retry(outcome.ref)).toBe(true);
    let release: (read: { address: string; cash: bigint }) => void = () => {};
    probed.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const cancelling = withdrawal.cancel(outcome.ref);
    await vi.waitFor(() => expect(probed).toHaveBeenCalled());
    asked.mockClear();
    expect(await withdrawal.paySale(outcome.ref)).toEqual({
      ok: false,
      reason: "The withdrawal is being cancelled.",
    });
    expect(asked).not.toHaveBeenCalled();
    release({ address: KEY_ADDRESS, cash: 0n });
    expect(await cancelling).toBe("ok");
    expect(useRequestsStore().get(outcome.ref)?.status.kind).toBe("cancelled");
  });

  it("takes the number before the session, so a lost answer leaves the next try its own key", async () => {
    const opened = vi.spyOn(meld, "createSellSession");
    // The adapter opened the session and the answer never came back.
    opened.mockRejectedValueOnce(new Error("Failed to fetch"));
    expect(await startSale()).toEqual({ ok: false, reason: "Failed to fetch" });
    expect(advanced).toHaveBeenCalledWith("wd:meld-bank", 1);
    expect(advanced.mock.invocationCallOrder[0]).toBeLessThan(opened.mock.invocationCallOrder[0]!);
    expect(useRequestsStore().withdrawals).toEqual([]);

    // The next try is withdrawal 2: another key, so another idempotency key at the adapter, and
    // not a resume into the first session's terms.
    const outcome = await startSale();
    expect(outcome.ok).toBe(true);
    expect(opened.mock.calls.map(([request]) => request.orderRef)).toEqual([
      KEY_ADDRESS,
      NEXT_KEY_ADDRESS,
    ]);
    if (outcome.ok) expect(outcome.ref.tradeN).toBe(2);
  });

  it("stands by a cancel that landed during the price check: the purse is not asked", async () => {
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    await toDeposit(outcome.ref);
    let settle: (fundable: boolean) => void = () => {};
    fundable.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const withdrawal = useWithdrawalRequest();
    const paying = withdrawal.paySale(outcome.ref);
    await vi.waitFor(() => expect(fundable).toHaveBeenCalled());
    expect(await withdrawal.cancel(outcome.ref)).toBe("ok");
    settle(true);
    expect((await paying).ok).toBe(false);
    expect(asked).not.toHaveBeenCalled();
    expect(handedOff).not.toHaveBeenCalled();
    expect(useRequestsStore().get(outcome.ref)?.status.kind).toBe("cancelled");
  });

  it("reads the order once more before the price, and ends a sale the provider ended meanwhile", async () => {
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    await toDeposit(outcome.ref);
    vi.spyOn(meld, "getStatus").mockResolvedValueOnce({ status: "failed" });
    const paid = await useWithdrawalRequest().paySale(outcome.ref);
    expect(paid.ok).toBe(false);
    expect(fundable).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalled();
    expect(useRequestsStore().get(outcome.ref)).toMatchObject({
      status: { kind: "failed", recoverable: false },
      failure: { kind: "sale-ended" },
    });
  });

  it("waits, asking nothing, while the order cannot be read", async () => {
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    await toDeposit(outcome.ref);
    vi.spyOn(meld, "getStatus").mockRejectedValueOnce(new Error("adapter down"));
    const paid = await useWithdrawalRequest().paySale(outcome.ref);
    expect(paid).toEqual({ ok: false, reason: "The sale could not be checked with the provider." });
    expect(fundable).not.toHaveBeenCalled();
    expect(useRequestsStore().get(outcome.ref)?.status.kind).toBe("awaiting-payment");
  });

  it("hands a sale whose purse was asked over again, never asking the purse twice", async () => {
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    await toDeposit(outcome.ref);
    const withdrawal = useWithdrawalRequest();
    expect(await withdrawal.paySale(outcome.ref)).toEqual({ ok: true });
    // The worker lost the job, so the route hands it over again.
    expect(await withdrawal.paySale(outcome.ref)).toEqual({ ok: true });
    expect(asked).toHaveBeenCalledTimes(1);
    expect(fundable).toHaveBeenCalledTimes(1);
    expect(handedOff).toHaveBeenCalledTimes(2);
  });

  it("leaves a refused purse to be asked again by the sale's route, priced again first", async () => {
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    await toDeposit(outcome.ref);
    asked.mockRejectedValueOnce(new live.PaymentRefusedError("declined"));
    const withdrawal = useWithdrawalRequest();
    expect(await withdrawal.paySale(outcome.ref)).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(useRequestsStore().get(outcome.ref)).toMatchObject({
        status: { kind: "failed", recoverable: true },
        failure: { step: "payment" },
      }),
    );
    fundable.mockClear();
    asked.mockClear();
    expect(await withdrawal.retry(outcome.ref)).toBe(true);
    // Back to waiting for its payment under a fresh attempt, the purse not asked yet: the route
    // follows the record there and checks the order and the price before it asks.
    expect(useRequestsStore().get(outcome.ref)).toMatchObject({
      status: { kind: "awaiting-payment" },
      payment: { attempt: 1 },
    });
    expect((useRequestsStore().get(outcome.ref) as WithdrawalRecord).payment.requestedAt).toBe(
      undefined,
    );
    expect(fundable).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalled();
    expect(await withdrawal.paySale(outcome.ref)).toEqual({ ok: true });
    expect(fundable).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("starts the payment window when the purse is asked, and hands the worker that window", async () => {
    const outcome = await startSale();
    if (!outcome.ok) throw new Error(outcome.reason);
    await toDeposit(outcome.ref);
    const askedAt = FIXTURE_NOW + 3 * 3_600_000;
    setRequestsClock(() => askedAt);
    expect(await useWithdrawalRequest().paySale(outcome.ref)).toEqual({ ok: true });
    const record = useRequestsStore().get(outcome.ref) as WithdrawalRecord;
    expect(record.deadline.paymentExpiresAt).toBe(askedAt + PAYMENT_WINDOW_MS);
    const [, , payload] = handedOff.mock.calls[0]!;
    expect(payload).toMatchObject({ paymentExpiresAt: askedAt + PAYMENT_WINDOW_MS });
  });
});

describe("a fiat sale in a build that cannot run one", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => FIXTURE_NOW);
    advanced.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMirrorStorage(null);
    setMeldSellClient(null);
  });

  it("refuses before taking a number, with no client or no adapter for the worker", async () => {
    const meldClient = await import("../app/withdraw/meld-client");
    vi.spyOn(meldClient, "meldSellClient").mockReturnValue(null);
    const outcome = await useWithdrawalRequest().startSale({
      method: "card",
      amount: 100_000_000n,
      country: "DE",
      fiat: "EUR",
      paymentMethodType: "CREDIT_DEBIT_CARD",
      quote: QUOTE,
      cryptoAmount: COMMITTED,
    });
    expect(outcome).toEqual({
      ok: false,
      reason: "Card and bank withdrawals are not available right now.",
    });
    expect(advanced).not.toHaveBeenCalled();
    expect(useRequestsStore().withdrawals).toEqual([]);
  });

  it("refuses before taking a number on a network where CASH cannot reach Asset Hub", async () => {
    const meld = createFakeMeldClient();
    const opened = vi.spyOn(meld, "createSellSession");
    setMeldSellClient(meld);
    vi.mocked(live.cashCanMove).mockResolvedValueOnce(false);
    const outcome = await useWithdrawalRequest().startSale({
      method: "bank",
      amount: 100_000_000n,
      country: "DE",
      fiat: "EUR",
      paymentMethodType: "SEPA",
      quote: QUOTE,
      cryptoAmount: COMMITTED,
    });
    expect(outcome).toEqual({
      ok: false,
      reason: "This network does not let CASH move from People to Asset Hub.",
    });
    expect(opened).not.toHaveBeenCalled();
    expect(advanced).not.toHaveBeenCalled();
    expect(useRequestsStore().withdrawals).toEqual([]);
  });
});
