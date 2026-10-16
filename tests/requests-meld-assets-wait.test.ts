// The reconcile reads every record without waiting on the adapter's asset table: only a sale's own
// reading waits for it, since that is what is checked against Meld's code for the sold asset.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { MeldAsset } from "@getsome/core";
import type { WithdrawalRecord } from "../app/funding/requests/model";
import { FIXTURE_NOW } from "./fixtures/requests";
import { TEST_MELD_ASSETS } from "./setup-meld-assets";

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

const STARTED = FIXTURE_NOW - 60_000;
const KEY_HEX = `0x${"07".repeat(32)}`;

async function freshStore() {
  // A fresh module registry holds an empty asset table, as a page does before the adapter answers.
  vi.resetModules();
  const model = await import("../app/funding/requests/model");
  const storage = await import("../app/funding/requests/storage");
  const store = await import("../app/stores/requests");
  const index = await import("../app/utils/request-index");
  const core = await import("@getsome/core");
  return { model, storage, store, index, core };
}

function sale(
  ref: WithdrawalRecord["ref"],
  paymentExpiresAt: number,
  fundingRequestId: string,
): WithdrawalRecord {
  const destination = { chain: "Bank transfer", asset: "EUR", address: "" };
  return {
    schema: 2,
    kind: "withdrawal",
    ref,
    rev: 0,
    updatedAt: STARTED,
    startedAt: STARTED,
    amountHuman: "100",
    route: "bank",
    destination,
    key: { label: "wd:eph:meld-bank:1", address: "5Key", publicKeyHex: KEY_HEX },
    payment: { attempt: 0 },
    deadline: { paymentExpiresAt },
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
      paymentExpiresAt,
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

describe("the reconcile and the asset table", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the records while the adapter has not answered, and reads the sale once it has", async () => {
    const { model, storage, store, index, core } = await freshStore();
    expect(core.meldAssetsInstalled()).toBe(false);
    const records = storage.createMemoryKeyedStorage();
    storage.setRecordStorage(records);
    storage.setMirrorStorage(null);
    model.setRequestsClock(() => FIXTURE_NOW);

    const ref = index.requestRefOf("wd:meld-bank", 1);
    const record = sale(ref, STARTED + model.SALE_WINDOW_MS, "mock-sell-1");
    await records.write(storage.requestKey(ref), JSON.stringify(record));
    await records.write(storage.REQUEST_INDEX_KEY, index.serializeRequestIndex([ref]));

    let answer: (rows: MeldAsset[]) => void = () => {};
    const getAssets = vi.fn(
      () =>
        new Promise<MeldAsset[]>((resolve) => {
          answer = resolve;
        }),
    );
    const getStatus = vi.fn(async () => ({ status: "session_opened" }));
    store.setMeldStatusClientFactory(() => ({ getAssets, getStatus }) as never);

    const requests = store.useRequestsStore();
    let done = false;
    const reconciled = requests.reconcile("refresh").then(() => {
      done = true;
    });
    await vi.waitFor(() => expect(getAssets).toHaveBeenCalled());

    // The record is read and shown; only the sale's reading waits on the table.
    expect(requests.get(ref)).toMatchObject({ status: { kind: "awaiting-payment" } });
    expect(getStatus).not.toHaveBeenCalled();
    expect(done).toBe(false);

    answer([...TEST_MELD_ASSETS]);
    await reconciled;
    expect(getStatus).toHaveBeenCalledWith("mock-sell-1");
    requests.stopJobPoll();
    requests.stopSalePoll();
    await requests.flush();
    model.setRequestsClock(Date.now);
  });
});
