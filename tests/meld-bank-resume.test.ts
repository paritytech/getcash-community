// A native bank transfer re-opened from the list: its details come back from the adapter's funding
// read while the order is still payable, the screen may call them lapsed only once that read has
// settled, and an iframe build keeps recovering the provider's page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  createFakeMeldHeadlessClient,
  type BankInstructions,
  type HeadlessFunding,
} from "@getsome/meld";
import { setMeldHeadlessClientFactory } from "../lib/meld-headless";
import { setRequestsClock } from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  REQUEST_INDEX_KEY,
  requestKey,
  setRecordStorage,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore, type ActiveFlowRecord } from "../app/stores/session";
import { requestRefOf, serializeRequestIndex } from "../app/utils/request-index";
import { FIXTURE_NOW, submittedCardRecord } from "./fixtures/requests";

vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/coinage-live", () => ({
  createHostedCoinageWorld: async (args: { tradeN?: number; sourceId?: string }) => ({
    session: {
      ready: Promise.resolve(),
      peek: () => ({ phase: "awaiting-deposit" }),
      getState: () => ({ phase: "awaiting-deposit" }),
      subscribe: () => ({ unsubscribe() {} }),
      resume: async () => {},
      clear: async () => {},
      dispose() {},
    },
    sourceId: args.sourceId,
    tradeN: args.tradeN,
    refundAddress: null,
    revealRefundKey: () => null,
    runFunding: async () => {},
    dispose() {},
  }),
}));

const ORDER_ID = "mfr-bank-5";
const INSTRUCTIONS: BankInstructions = {
  rail: "SEPA",
  amount: "52.06",
  currency: "EUR",
  accountHolderName: "Provider Payments",
  iban: "DE89370400440532013000",
  bic: "DEMODEFFXXX",
  reference: "GETCASH-5",
  expiresAt: FIXTURE_NOW + 60 * 60_000,
};
const WIDGET_URL = "https://provider.example/pay/5";

const { meldSubmittedAt: _submitted, ...unpaid } = submittedCardRecord;
const bankRecord: ActiveFlowRecord = {
  ...unpaid,
  asset: "Bank",
  sourceSymbol: "EUR",
  tradeN: 5,
  sourceId: "meld-bank",
  meldFundingRequestId: ORDER_ID,
  meldCountry: "DE",
};
const ref = requestRefOf("meld-bank", 5);

/** A headless funding read that answers `funding`, released by the returned function. */
function heldFunding(funding: HeadlessFunding) {
  let release = () => {};
  const getFunding = vi.fn(
    () =>
      new Promise<HeadlessFunding>((resolve) => {
        release = () => resolve(funding);
      }),
  );
  setMeldHeadlessClientFactory(() => ({ ...createFakeMeldHeadlessClient(), getFunding }));
  return { getFunding, release: () => release() };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function reopen() {
  const storage = createMemoryKeyedStorage();
  setRecordStorage(storage);
  await storage.write(requestKey(ref), JSON.stringify(bankRecord));
  await storage.write(REQUEST_INDEX_KEY, serializeRequestIndex([ref]));
  const session = useSessionStore();
  expect(await session.openRequest(ref)).toBe(true);
  return session;
}

beforeEach(() => {
  setActivePinia(createPinia());
  setRequestsClock(() => FIXTURE_NOW);
  vi.stubEnv("VITE_MELD_BASE_URL", "https://adapter.test");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  const requests = useRequestsStore();
  requests.stopMeldPoll();
  requests.stopJobPoll();
  await requests.flush();
  setMeldHeadlessClientFactory(null);
  setRequestsClock(Date.now);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("re-opening a native bank transfer", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MELD_MODE", "native");
  });

  it("shows the details the adapter still serves, once its read has settled", async () => {
    const read = heldFunding({
      status: "session_opened",
      integrationMode: "headless",
      paymentInstructions: INSTRUCTIONS,
    });
    const session = await reopen();

    expect(session.meldPayUrlPending).toBe(true);
    expect(session.meldPayment).toBeNull();

    read.release();
    await flush();
    expect(read.getFunding).toHaveBeenCalledWith(ORDER_ID);
    expect(session.meldPayUrlPending).toBe(false);
    expect(session.meldPayment).toEqual({
      kind: "bank",
      fundingRequestId: ORDER_ID,
      instructions: INSTRUCTIONS,
    });
  });

  it("has no details once the adapter stops serving them, which reads as lapsed", async () => {
    const read = heldFunding({ status: "expired", integrationMode: "headless" });
    const session = await reopen();
    read.release();
    await flush();

    expect(session.meldPayUrlPending).toBe(false);
    expect(session.meldPayment).toBeNull();
    expect(session.meldPayUrl).toBeNull();
  });

  it("forgets the recovered details when the request is left", async () => {
    const read = heldFunding({
      status: "session_opened",
      integrationMode: "headless",
      paymentInstructions: INSTRUCTIONS,
    });
    const session = await reopen();
    read.release();
    await flush();
    session.reset();
    await flush();

    expect(session.meldPayment).toBeNull();
  });
});

describe("re-opening a bank transfer in an iframe build", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MELD_MODE", "iframe");
  });

  it("recovers the provider's page and never reads the headless funding", async () => {
    const getFunding = vi.fn();
    setMeldHeadlessClientFactory(() => ({ ...createFakeMeldHeadlessClient(), getFunding }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              funding: { status: "session_opened", serviceProviderWidgetUrl: WIDGET_URL },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const session = await reopen();
    await flush();

    expect(session.meldPayUrlPending).toBe(false);
    expect(session.meldPayUrl).toBe(WIDGET_URL);
    expect(session.meldPayment).toBeNull();
    expect(getFunding).not.toHaveBeenCalled();
  });
});
