// The provider's leg through the store: the foreground Meld poll moves the record on screen and
// the requests store's Meld views read it back with today's values; a reconcile reads every other
// Meld request once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import type { MeldClientLike } from "@getsome/meld";
import { migrateRecord } from "../app/funding/requests/migrate";
import { MELD_POLL_MS, setRequestsClock, type RequestRecord } from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  setMirrorStorage,
  setRecordStorage,
} from "../app/funding/requests/storage";
import { setMeldStatusClientFactory, useRequestsStore } from "../app/stores/requests";
import type { ActiveFlowRecord } from "../app/stores/session";
import { requestRefOf, type RequestRef } from "../app/utils/request-index";
import {
  awaitingDepositCryptoRecord,
  FIXTURE_NOW,
  settledCardRecord,
  submittedCardRecord,
} from "./fixtures/requests";

// The background reads run hosted only; the chain and the worker are stand-ins that report
// nothing, so a reconcile here is the provider step alone.
vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/worker-rpc", () => ({
  getStorageWorkerManager: () => ({
    isAvailable: () => true,
    call: async () => {},
    dispose() {},
  }),
}));
vi.mock("../lib/coinage-live", () => ({
  probeTradeBurner: async () => ({ address: "", free: 0n }),
  readHostedTradeCounter: async () => 1,
  readFlowSlot: async () => ({ address: "", slot: null }),
  lostRequestHandoff: () => {
    throw new Error("unused");
  },
  ensureChainSubmitGrant: async () => {},
  createHostedCoinageWorld: async () => {
    throw new Error("no world is built here");
  },
}));

/** A Meld client whose status answer the test sets; the quote and session routes are never
 *  reached by a status poll. */
interface FakeMeldClient extends MeldClientLike {
  status: string;
  /** Thrown by the next status reads instead of answering, when set. */
  failure: Error | null;
  /** Status reads so far, by funding-request id. */
  reads: Record<string, number>;
}

function fakeMeldClient(status: string): FakeMeldClient {
  const client: FakeMeldClient = {
    status,
    failure: null,
    reads: {},
    getQuote: async () => {
      throw new Error("unused");
    },
    createSession: async () => {
      throw new Error("unused");
    },
    getStatus: async (fundingRequestId) => {
      client.reads[fundingRequestId] = (client.reads[fundingRequestId] ?? 0) + 1;
      if (client.failure !== null) throw client.failure;
      return { status: client.status };
    },
  };
  return client;
}

/** The ref a fixture is stored under: its own source id and trade number. */
const refOf = (record: ActiveFlowRecord): RequestRef =>
  requestRefOf(record.sourceId, record.tradeN!);

const migrated = (record: ActiveFlowRecord, ref = refOf(record)): RequestRecord => {
  const result = migrateRecord(record, ref, FIXTURE_NOW);
  if (result === null) throw new Error("fixture did not migrate");
  return result;
};

/** The card request before the buyer finished the widget. */
const { meldSubmittedAt: _stamp, ...unsubmittedCard } = submittedCardRecord;
const CARD_REF = refOf(submittedCardRecord);
const BANK_REF = requestRefOf("meld-bank", 5);

const realSetTimeout = setTimeout;
/** Lets a poll tick run to its end: the read and the observation are promise chains the fake
 *  clock does not cover. */
const settled = () => new Promise((resolve) => realSetTimeout(resolve, 0));

/** Moves the poll to its next tick and lets it land. */
async function nextPoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(MELD_POLL_MS);
  await settled();
}

describe("requests store: the Meld poll", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(null);
    setRequestsClock(() => FIXTURE_NOW);
    setMeldStatusClientFactory(() => null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    // Neither a poll nor a coalesced write may outlive its test.
    const requests = useRequestsStore();
    requests.leave();
    requests.stopJobPoll();
    await requests.flush();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMeldStatusClientFactory(() => null);
  });

  it("foreground poll maps adapter statuses to meldStage as today", async () => {
    vi.useFakeTimers();
    const requests = useRequestsStore();
    const client = fakeMeldClient("session_opened");
    await requests.create(CARD_REF, migrated(unsubmittedCard));
    requests.setForeground(CARD_REF);

    requests.startMeldPoll(CARD_REF, client, "mfr");
    await settled();
    expect(client.reads).toEqual({ mfr: 1 });
    expect(requests.meldStage).toBe("waiting");
    expect(requests.meldHandedOff).toBe(false);

    // The provider saw the transaction, but a 3DS challenge may still need the widget: the stage
    // holds at waiting until the buyer submits.
    client.status = "transaction_seen";
    await nextPoll();
    expect(requests.meldStage).toBe("waiting");
    expect(requests.meldDelayed).toBe(false);
    expect(requests.get(CARD_REF)?.rail.stage).toBe("received");

    await requests.markMeldSubmitted(CARD_REF);
    expect(requests.meldStage).toBe("receiving");
    expect(requests.meldHandedOff).toBe(true);
    expect(requests.meldSubmitted).toBe(true);

    // The provider's crypto delivery is stuck and retrying: a delay, nothing terminal.
    client.status = "crypto_failed";
    await nextPoll();
    await nextTick();
    expect(requests.meldStage).toBe("receiving");
    expect(requests.meldDelayed).toBe(true);

    client.status = "settled";
    await nextPoll();
    expect(requests.meldStage).toBe("complete");
    expect(requests.meldHandedOff).toBe(true);
    expect(requests.get(CARD_REF)?.rail.stage).toBe("delivered");
    // Delivered ends the poll.
    const readsBefore = client.reads.mfr;
    await nextPoll();
    expect(client.reads.mfr).toBe(readsBefore);

    // A second card request whose bank refused the payment.
    const declined = fakeMeldClient("declined");
    const DECLINED_REF = requestRefOf("meld-card", 6);
    await requests.create(DECLINED_REF, {
      ...migrated(unsubmittedCard, DECLINED_REF),
      tradeN: 6,
      meldFundingRequestId: "mfr-declined",
    });
    requests.setForeground(DECLINED_REF);
    requests.startMeldPoll(DECLINED_REF, declined, "mfr-declined");
    await settled();
    expect(requests.meldStage).toBe("failed");
    expect(requests.meldFailureMessage).toBe(
      "Your bank declined the payment. Check your card details or try another card.",
    );
    expect(requests.get(DECLINED_REF)?.status.kind).toBe("failed");
    const declinedReads = declined.reads["mfr-declined"];
    await nextPoll();
    expect(declined.reads["mfr-declined"]).toBe(declinedReads);
  });

  it("a 404 stops the poll with the do-not-pay-again message", async () => {
    vi.useFakeTimers();
    const requests = useRequestsStore();
    const client = fakeMeldClient("session_opened");
    client.failure = Object.assign(new Error("not found"), { status: 404 });
    await requests.create(CARD_REF, migrated(unsubmittedCard));
    requests.setForeground(CARD_REF);

    requests.startMeldPoll(CARD_REF, client, "mfr");
    await settled();

    expect(requests.meldStage).toBe("failed");
    expect(requests.meldFailureMessage).toBe(
      "We can no longer find this payment. Do not pay again. Contact support with your reference.",
    );
    expect(requests.get(CARD_REF)).toMatchObject({
      status: { kind: "failed", recoverable: false },
      rail: { stage: "failed" },
    });
    expect(client.reads).toEqual({ mfr: 1 });
    await nextPoll();
    expect(client.reads).toEqual({ mfr: 1 });
  });

  it("reconcile reads one status per background Meld entry", async () => {
    const requests = useRequestsStore();
    const client = fakeMeldClient("transaction_seen");
    setMeldStatusClientFactory(() => client);
    // Two Meld requests the provider can still move, one it settled, and the crypto request on
    // screen, whose own world watches it.
    await requests.create(CARD_REF, migrated(submittedCardRecord));
    await requests.create(BANK_REF, {
      ...migrated(unsubmittedCard, BANK_REF),
      chain: "Meld",
      asset: "Bank",
      tradeN: 5,
      sourceId: "meld-bank",
      route: "bank",
      meldFundingRequestId: "mfr-bank-5",
    });
    await requests.create(refOf(settledCardRecord), migrated(settledCardRecord));
    const CRYPTO_REF = refOf(awaitingDepositCryptoRecord);
    await requests.create(CRYPTO_REF, migrated(awaitingDepositCryptoRecord));
    requests.setForeground(CRYPTO_REF);

    await requests.reconcile("refresh");

    expect(client.reads).toEqual({ "mfr-fixture-card-2": 1, "mfr-bank-5": 1 });
    expect(requests.get(CARD_REF)?.rail.stage).toBe("received");
    expect(requests.get(BANK_REF)?.rail.stage).toBe("received");
    expect(requests.get(refOf(settledCardRecord))?.rail.stage).toBe("waiting");
  });
});
