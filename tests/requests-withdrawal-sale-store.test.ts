// A fiat sale through the store's reconcile, hosted: until the purse is asked nothing is handed to
// the worker, since no CASH is coming; off screen the reconcile reads the sale, the provider's
// deposit address becomes its channel there too, and an order that ends before the seller comes
// back ends the record.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createFakeMeldClient } from "@getsome/meld";
import {
  SALE_WINDOW_MS,
  setRequestsClock,
  type WithdrawalRecord,
} from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  REQUEST_INDEX_KEY,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  type KeyedStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { setMeldStatusClientFactory, useRequestsStore } from "../app/stores/requests";
import { requestRefOf, serializeRequestIndex } from "../app/utils/request-index";
import { FIXTURE_NOW } from "./fixtures/requests";

vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/worker-rpc", () => ({
  getStorageWorkerManager: () => ({ isAvailable: () => true, call: vi.fn(async () => ({})) }),
}));
vi.mock("../lib/coinage-live", () => ({
  createHostedCoinageWorld: vi.fn(),
  ensureChainSubmitGrant: async () => {},
  probeTradeBurner: vi.fn(),
  readHostedTradeCounter: async () => 0,
  readFlowSlot: async () => null,
  lostRequestHandoff: vi.fn(),
}));
vi.mock("../lib/withdraw-live", () => ({
  sendWithdrawHandoff: vi.fn(async () => {}),
  probeWithdrawKey: async () => ({ address: "5Key", cash: 0n }),
  readPaymentStatus: async () => ({ status: "not-found" }),
  nudgeWithdrawTicks: () => {},
}));

import * as live from "../lib/withdraw-live";

const handedOff = vi.mocked(live.sendWithdrawHandoff);

const STARTED = FIXTURE_NOW - 60_000;
const REF = requestRefOf("wd:meld-bank", 1);
const KEY_HEX = `0x${"07".repeat(32)}`;

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

function sale(fundingRequestId: string): WithdrawalRecord {
  const destination = { chain: "Bank transfer", asset: "EUR", address: "" };
  return {
    schema: 2,
    kind: "withdrawal",
    ref: REF,
    rev: 0,
    updatedAt: STARTED,
    startedAt: STARTED,
    amountHuman: "100",
    route: "bank",
    destination,
    key: { label: "wd:eph:meld-bank:1", address: "5Key", publicKeyHex: KEY_HEX },
    payment: { attempt: 0 },
    deadline: { paymentExpiresAt: STARTED + SALE_WINDOW_MS },
    handoff: {
      label: "wd:eph:meld-bank:1",
      keyAddress: "5Key",
      keyPublicKeyHex: KEY_HEX,
      amount: "100000000",
      destination,
      landingHex: KEY_HEX,
      rail: "meld",
      assetHubGenesis: "0xah",
      peopleGenesis: "0xpe",
      peopleParaId: 1004,
      assetHubParaId: 1000,
      poolAccount: "5Pool",
      slippagePct: 5,
      paymentExpiresAt: STARTED + SALE_WINDOW_MS,
      meld: { baseUrl: "https://adapter.test" },
    },
    status: { kind: "awaiting-payment" },
    rail: { provider: "meld", stage: "waiting", updatedAt: STARTED },
    sale: {
      fundingRequestId,
      serviceProvider: "TRANSAK",
      country: "DE",
      fiat: "EUR",
      paymentMethodType: "SEPA",
      widgetUrl: "https://kyc.test",
      cryptoAmount: "234521000000",
      quotedPayout: "90.12",
    },
    witnesses: {},
  };
}

let storage: KeyedStorage;

async function seed(record: WithdrawalRecord): Promise<void> {
  await storage.write(requestKey(record.ref), JSON.stringify(record));
  await storage.write(REQUEST_INDEX_KEY, serializeRequestIndex([record.ref]));
}

describe("requests store: a fiat sale, hosted", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    storage = createMemoryKeyedStorage();
    setRecordStorage(storage);
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => FIXTURE_NOW);
    handedOff.mockClear();
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
    setMeldStatusClientFactory(() => null);
  });

  it("hands the worker nothing while the sale waits on KYC", async () => {
    setMeldStatusClientFactory(() => null);
    await seed(sale("mock-sell-1"));
    const requests = useRequestsStore();
    await requests.reconcile("refresh");
    expect(requests.get(REF)).toMatchObject({
      status: { kind: "awaiting-payment" },
      witnesses: { worker: { known: false } },
    });
    expect(handedOff).not.toHaveBeenCalled();
  });

  it("reads a sale off screen until the provider names its deposit address", async () => {
    const meld = createFakeMeldClient({ sellPollsBeforeDeposit: 0 });
    const opened = await meld.createSellSession({
      serviceProvider: "TRANSAK",
      orderRef: "5Key",
      country: "DE",
      sourceCurrencyCode: "DOT_ASSETHUB",
      sourceAmount: "23.4521",
      destinationCurrencyCode: "EUR",
      paymentMethodType: "SEPA",
    });
    setMeldStatusClientFactory(() => meld);
    await seed(sale(opened.fundingRequestId));
    const requests = useRequestsStore();
    await requests.reconcile("refresh");
    const record = requests.get(REF) as WithdrawalRecord;
    expect(record.handoff.channel).toMatchObject({
      id: opened.fundingRequestId,
      amount: "234521000000",
    });
    expect(record.sale?.depositSeenAt).toBe(FIXTURE_NOW);
  });

  it("keeps reading it off screen until the purse is asked, handing the worker nothing", async () => {
    const meld = createFakeMeldClient({ sellPollsBeforeDeposit: 0 });
    const opened = await meld.createSellSession({
      serviceProvider: "TRANSAK",
      orderRef: "5Key",
      country: "DE",
      sourceCurrencyCode: "DOT_ASSETHUB",
      sourceAmount: "23.4521",
      destinationCurrencyCode: "EUR",
      paymentMethodType: "SEPA",
    });
    setMeldStatusClientFactory(() => meld);
    await seed(sale(opened.fundingRequestId));
    const requests = useRequestsStore();
    await requests.reconcile("refresh");
    expect((requests.get(REF) as WithdrawalRecord).handoff.channel).toBeDefined();
    // The seller has not come back to it; meanwhile the provider ends the order.
    const read = vi.spyOn(meld, "getStatus").mockResolvedValue({ status: "failed" });
    await requests.reconcile("refresh");
    expect(read).toHaveBeenCalledWith(opened.fundingRequestId);
    expect(requests.get(REF)).toMatchObject({
      status: { kind: "failed", recoverable: false },
      failure: { kind: "sale-ended" },
    });
    expect(handedOff).not.toHaveBeenCalled();
  });
});
