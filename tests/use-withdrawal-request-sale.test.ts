// The page's side of a fiat sale: confirm opens the provider's SELL session for the committed
// figure, naming no wallet, and writes a record that waits on KYC, asking nothing of the
// purse; the provider's deposit address becomes the channel; only then is the price checked and
// the purse asked, a PSM sale with this app's other redeems ahead spoken for; a cancel during KYC
// withdraws the order at the provider too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createFakeMeldClient } from "@getsome/meld";
import type { ConversionRoute } from "@getsome/funding";
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
import { requestRefOf } from "../app/utils/request-index";
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
  openSwapSaleChannel: vi.fn(),
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
    ...(args.sale as Record<string, unknown>),
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
const openSwap = vi.mocked(live.openSwapSaleChannel);
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
const PSM_SALE: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 5_000 };
/** What the PSM sale of 100 CASH commits, in USDT. */
const PSM_COMMITTED = 98_668_800n;

/** Another PSM withdrawal of this app, converting under the worker: 50 CASH ahead of any sale. */
const CONVERTING_PSM_WITHDRAWAL: WithdrawalRecord = {
  schema: 2,
  kind: "withdrawal",
  ref: requestRefOf("wd:usdt-assethub", 1),
  rev: 0,
  updatedAt: FIXTURE_NOW,
  startedAt: FIXTURE_NOW,
  amountHuman: "50",
  route: "crypto",
  destination: { chain: "Asset Hub", asset: "USDT", address: NEXT_KEY_ADDRESS },
  key: { label: "wd:eph:usdt-assethub:1", address: NEXT_KEY_ADDRESS, publicKeyHex: KEY_HEX },
  payment: { attempt: 0, requestedAt: FIXTURE_NOW, id: "pay-1" },
  deadline: { paymentExpiresAt: FIXTURE_NOW + PAYMENT_WINDOW_MS },
  handoff: {
    label: "wd:eph:usdt-assethub:1",
    keyAddress: NEXT_KEY_ADDRESS,
    keyPublicKeyHex: KEY_HEX,
    amount: "50000000",
    destination: { chain: "Asset Hub", asset: "USDT", address: NEXT_KEY_ADDRESS },
    landingHex: KEY_HEX,
    rail: "direct",
    tier: "psm",
    external: "USDT",
    feeRate: 5_000,
    assetHubGenesis: "0xah",
    peopleGenesis: "0xpe",
    peopleParaId: 1004,
    assetHubParaId: 1000,
    poolAccount: "5Pool",
    slippagePct: 5,
    paymentExpiresAt: FIXTURE_NOW + PAYMENT_WINDOW_MS,
  },
  status: { kind: "converting", at: FIXTURE_NOW, step: "convert" },
  rail: { provider: "direct", stage: "waiting", updatedAt: FIXTURE_NOW },
  witnesses: {},
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

  /** A sale of DOT out of the pool, or of USDT out of the PSM, as the quote decided it. */
  const startSale = (sale: ConversionRoute = { tier: "pool" }, cryptoAmount = COMMITTED) =>
    useWithdrawalRequest().startSale({
      method: "bank",
      amount: 100_000_000n,
      country: "DE",
      fiat: "EUR",
      paymentMethodType: "SEPA",
      quote: QUOTE,
      cryptoAmount,
      route: sale,
      ...(sale.tier === "psm" ? { sellCode: "USDT_ASSETHUB" } : {}),
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

  it("opens a direct sale quoted under DOT_STATEMINT under that code", async () => {
    const spy = vi.spyOn(meld, "createSellSession");
    const outcome = await useWithdrawalRequest().startSale({
      method: "bank",
      amount: 100_000_000n,
      country: "GB",
      fiat: "GBP",
      paymentMethodType: "UK_FASTER_PAYMENTS",
      quote: { ...QUOTE, serviceProvider: "ONRAMPMONEY" },
      cryptoAmount: COMMITTED,
      sellCode: "DOT_STATEMINT",
    });
    expect(outcome.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceProvider: "ONRAMPMONEY",
        sourceCurrencyCode: "DOT_STATEMINT",
        sourceAmount: "23.4521",
        destinationCurrencyCode: "GBP",
      }),
    );
  });

  it("refuses a direct sale under a code it cannot sell, opening nothing", async () => {
    const spy = vi.spyOn(meld, "createSellSession");
    const outcome = await useWithdrawalRequest().startSale({
      method: "bank",
      amount: 100_000_000n,
      country: "GB",
      fiat: "GBP",
      paymentMethodType: "UK_FASTER_PAYMENTS",
      quote: QUOTE,
      cryptoAmount: COMMITTED,
      sellCode: "USDC_STATEMINT",
    });
    expect(outcome).toEqual({ ok: false, reason: "A sale cannot sell USDC_STATEMINT." });
    expect(spy).not.toHaveBeenCalled();
    expect(advanced).not.toHaveBeenCalled();
  });

  /** 25 USDT, the figure a direct sale of USDT commits to. */
  const USDT_COMMITTED = 25_000_000n;
  const REDEEM = { tier: "psm", external: "USDT", feeRate: 1_000 } as const;
  const startUsdtSale = (
    over: Partial<Parameters<ReturnType<typeof useWithdrawalRequest>["startSale"]>[0]> = {},
  ) =>
    useWithdrawalRequest().startSale({
      method: "bank",
      amount: 30_000_000n,
      country: "GB",
      fiat: "GBP",
      paymentMethodType: "UK_FASTER_PAYMENTS",
      quote: { ...QUOTE, serviceProvider: "ONRAMPMONEY" },
      cryptoAmount: USDT_COMMITTED,
      sellCode: "USDT_STATEMINT",
      route: REDEEM,
      ...over,
    });

  it.each(["USDT_ASSETHUB", "USDT_STATEMINT"])(
    "opens a direct sale of USDT under %s, the CASH redeemed for it",
    async (sellCode) => {
      const spy = vi.spyOn(meld, "createSellSession");
      const outcome = await startUsdtSale({ sellCode });
      if (!outcome.ok) throw new Error(outcome.reason);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceProvider: "ONRAMPMONEY",
          sourceCurrencyCode: sellCode,
          sourceAmount: "25",
          destinationCurrencyCode: "GBP",
        }),
      );
      const record = useRequestsStore().get(outcome.ref) as WithdrawalRecord;
      expect(record.sale).toMatchObject({
        sellCode,
        cryptoAmount: USDT_COMMITTED.toString(),
      });
      expect(record.sale?.lane).toBeUndefined();
      expect(record.handoff).toMatchObject({ rail: "meld", ...REDEEM });
      expect(record.handoff.swap).toBeUndefined();
    },
  );

  it.each(["USDT_ASSETHUB", "USDT_STATEMINT"])(
    "takes a %s deposit for its exact figure and checks the redeem before the purse",
    async (sellCode) => {
      const outcome = await startUsdtSale({ sellCode });
      if (!outcome.ok) throw new Error(outcome.reason);
      const known = await toDeposit(outcome.ref);
      expect(known.status.kind).toBe("awaiting-payment");
      expect(known.handoff.channel).toMatchObject({
        id: "mock-sell-1",
        amount: USDT_COMMITTED.toString(),
      });

      expect(await useWithdrawalRequest().paySale(outcome.ref)).toEqual({ ok: true });
      expect(fundable).toHaveBeenCalledWith(
        30_000_000n,
        USDT_COMMITTED,
        known.handoff.channel!.address,
        REDEEM,
        0n,
      );
      expect(handedOff).toHaveBeenCalledTimes(1);
      expect(handedOff.mock.calls[0]![2]).toMatchObject({
        ...REDEEM,
        channel: { id: "mock-sell-1", amount: USDT_COMMITTED.toString() },
      });
    },
  );

  it("refuses a sale of USDT without its redeem, and a sale of DOT with one", async () => {
    const spy = vi.spyOn(meld, "createSellSession");
    const mismatch = { ok: false, reason: "The sale's asset and its conversion do not match." };
    expect(await startUsdtSale({ route: undefined })).toEqual(mismatch);
    expect(await startUsdtSale({ route: { tier: "pool" } })).toEqual(mismatch);
    expect(await startUsdtSale({ sellCode: "DOT_STATEMINT" })).toEqual(mismatch);
    expect(await startUsdtSale({ sellCode: undefined })).toEqual(mismatch);
    expect(spy).not.toHaveBeenCalled();
  });

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
    expect(fundable).toHaveBeenCalledWith(
      100_000_000n,
      COMMITTED,
      known.handoff.channel!.address,
      { tier: "pool" },
      0n,
    );
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ amount: 100_000_000n }));
    expect(handedOff).toHaveBeenCalledTimes(1);
    const [, , payload] = handedOff.mock.calls[0]!;
    expect(payload).toMatchObject({
      rail: "meld",
      channel: { id: "mock-sell-1", amount: COMMITTED.toString() },
      meld: { baseUrl: "https://adapter.test" },
    });
  });

  it("decides a PSM sale again before the purse, with this app's other redeems ahead spoken for", async () => {
    const requests = useRequestsStore();
    await requests.create(CONVERTING_PSM_WITHDRAWAL.ref, CONVERTING_PSM_WITHDRAWAL);
    const outcome = await startSale(PSM_SALE, PSM_COMMITTED);
    if (!outcome.ok) throw new Error(outcome.reason);
    const known = await toDeposit(outcome.ref);
    expect(await useWithdrawalRequest().paySale(outcome.ref)).toEqual({ ok: true });
    // The 50 CASH converting ahead count against the pair's room; the sale's own 100 do not.
    expect(fundable).toHaveBeenCalledWith(
      100_000_000n,
      PSM_COMMITTED,
      known.handoff.channel!.address,
      PSM_SALE,
      50_000_000n,
    );
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ amount: 100_000_000n }));
    expect(handedOff).toHaveBeenCalledTimes(1);
  });

  it("ends a PSM sale the pair can no longer serve with nothing taken", async () => {
    const outcome = await startSale(PSM_SALE, PSM_COMMITTED);
    if (!outcome.ok) throw new Error(outcome.reason);
    await toDeposit(outcome.ref);
    // The pair filled up or repriced during KYC: the check decided the sale again and answered no.
    fundable.mockResolvedValue(false);
    const paid = await useWithdrawalRequest().paySale(outcome.ref);
    expect(paid).toEqual({ ok: false, reason: "The price moved too far while you verified." });
    expect(fundable).toHaveBeenCalledWith(
      100_000_000n,
      PSM_COMMITTED,
      expect.any(String),
      PSM_SALE,
      0n,
    );
    expect(asked).not.toHaveBeenCalled();
    expect(handedOff).not.toHaveBeenCalled();
    expect(useRequestsStore().get(outcome.ref)).toMatchObject({
      status: { kind: "failed", recoverable: false },
      failure: { kind: "unfundable" },
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

  describe("through an offramp lane", () => {
    const LANE_COMMITTED = 24_000_000n;
    const REDEEM = { tier: "psm", external: "USDT", feeRate: 1_000 } as const;
    const swapChannel = (id: string, expiresAt: number) => ({
      id,
      address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
      openedAt: FIXTURE_NOW,
      expiresAt,
      expectedEgress: LANE_COMMITTED.toString(),
      amount: "25100000",
    });

    beforeEach(() => {
      openSwap.mockReset().mockResolvedValue(swapChannel("cf-fresh", FIXTURE_NOW + 3_600_000));
    });

    async function laneSaleAtDeposit() {
      const outcome = await useWithdrawalRequest().startSale({
        method: "bank",
        amount: 30_000_000n,
        country: "GB",
        fiat: "GBP",
        paymentMethodType: "UK_FASTER_PAYMENTS",
        quote: QUOTE,
        cryptoAmount: LANE_COMMITTED,
        swap: { lane: "usdc-solana", route: REDEEM },
      });
      if (!outcome.ok) throw new Error(outcome.reason);
      await toDeposit(outcome.ref);
      return outcome.ref;
    }

    it("keeps a swap opened earlier while the key still has time to pay it", async () => {
      const ref = await laneSaleAtDeposit();
      const kept = swapChannel("cf-kept", FIXTURE_NOW + 3_600_000);
      await useRequestsStore().observe(ref, {
        source: "user",
        at: FIXTURE_NOW,
        event: "swap-opened",
        channel: kept,
      });
      expect(await useWithdrawalRequest().paySale(ref)).toEqual({ ok: true });
      expect(openSwap).not.toHaveBeenCalled();
      expect((useRequestsStore().get(ref) as WithdrawalRecord).handoff.swap?.id).toBe("cf-kept");
    });

    it("opens a fresh swap in place of one about to close", async () => {
      const ref = await laneSaleAtDeposit();
      await useRequestsStore().observe(ref, {
        source: "user",
        at: FIXTURE_NOW,
        event: "swap-opened",
        channel: swapChannel("cf-stale", FIXTURE_NOW + 60_000),
      });
      expect(await useWithdrawalRequest().paySale(ref)).toEqual({ ok: true });
      expect(openSwap).toHaveBeenCalledTimes(1);
      expect((useRequestsStore().get(ref) as WithdrawalRecord).handoff.swap?.id).toBe("cf-fresh");
    });

    it("opens a fresh swap in place of one the worker would refuse once the purse has paid", async () => {
      // Twenty minutes left: past the worker's own margin, but not past it plus the purse's window.
      const ref = await laneSaleAtDeposit();
      await useRequestsStore().observe(ref, {
        source: "user",
        at: FIXTURE_NOW,
        event: "swap-opened",
        channel: swapChannel("cf-short", FIXTURE_NOW + 20 * 60_000),
      });
      expect(await useWithdrawalRequest().paySale(ref)).toEqual({ ok: true });
      expect(openSwap).toHaveBeenCalledTimes(1);
      expect((useRequestsStore().get(ref) as WithdrawalRecord).handoff.swap?.id).toBe("cf-fresh");
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
});
