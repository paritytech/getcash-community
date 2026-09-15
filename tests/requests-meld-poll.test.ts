// The provider's leg through the store: the foreground Meld poll moves the record on screen and
// the requests store's Meld views read it back with today's values; a reconcile reads every other
// Meld request once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import type { MeldClientLike } from "@getsome/meld";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  MELD_POLL_MS,
  setRequestsClock,
  TOMBSTONE_GRACE_MS,
  type RequestRecord,
} from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  type KeyedStorage,
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

/** A memory record storage that counts the writes under each key. */
function countingStorage() {
  const inner = createMemoryKeyedStorage();
  const writes = new Map<string, number>();
  const storage: KeyedStorage = {
    read: (key) => inner.read(key),
    write: (key, value) => {
      writes.set(key, (writes.get(key) ?? 0) + 1);
      return inner.write(key, value);
    },
    clear: (key) => inner.clear(key),
  };
  return { storage, writesTo: (key: string) => writes.get(key) ?? 0 };
}

const MINUTE = 60_000;
const MELD_GONE =
  "We can no longer find this payment. Do not pay again. Contact support with your reference.";

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

/** The card request under another trade number and funding request, with `patch` applied. */
function cardRecord(
  tradeN: number,
  fundingRequestId: string,
  patch: Partial<RequestRecord>,
): RequestRecord {
  return {
    ...migrated(unsubmittedCard, requestRefOf("meld-card", tradeN)),
    tradeN,
    meldFundingRequestId: fundingRequestId,
    ...patch,
  };
}

/** The lines `observeMeldStatus` warned about a payment the adapter did not find, in order. */
const notFoundWarnings = () =>
  vi
    .mocked(console.warn)
    .mock.calls.map(([line]) => String(line))
    .filter((line) => line.startsWith("[meld] status for"));

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

  it("a repeated status changes nothing on the record", async () => {
    vi.useFakeTimers();
    const counting = countingStorage();
    setRecordStorage(counting.storage);
    const requests = useRequestsStore();
    const client = fakeMeldClient("transaction_seen");
    await requests.create(CARD_REF, migrated(unsubmittedCard));
    const key = requestKey(CARD_REF);
    expect(counting.writesTo(key)).toBe(1);
    requests.setForeground(CARD_REF);

    // The first sighting moves the record: the deposit is seen, and written to the host at once.
    requests.startMeldPoll(CARD_REF, client, "mfr");
    await settled();
    expect(client.reads).toEqual({ mfr: 1 });
    expect(requests.get(CARD_REF)).toMatchObject({
      rev: 1,
      status: { kind: "deposit-seen", assurance: "provisional", via: "rail" },
      rail: { stage: "received", status: "receiving" },
    });
    expect(counting.writesTo(key)).toBe(2);

    // The same answer again is the provider's witness alone: no rev, no write.
    await nextPoll();
    expect(client.reads).toEqual({ mfr: 2 });
    expect(requests.get(CARD_REF)).toMatchObject({
      rev: 1,
      rail: { stage: "received", status: "receiving" },
      witnesses: { provider: { status: "receiving", at: FIXTURE_NOW } },
    });
    expect(counting.writesTo(key)).toBe(2);
  });

  it("a 404 stops the poll with the do-not-pay-again message", async () => {
    vi.useFakeTimers();
    const requests = useRequestsStore();
    const client = fakeMeldClient("session_opened");
    client.failure = Object.assign(new Error("not found"), { status: 404 });
    await requests.create(CARD_REF, migrated(unsubmittedCard));
    requests.setForeground(CARD_REF);

    // Two "not found" answers are an adapter hiccup: the record waits and the poll goes on.
    requests.startMeldPoll(CARD_REF, client, "mfr");
    await settled();
    expect(client.reads).toEqual({ mfr: 1 });
    expect(requests.get(CARD_REF)).toMatchObject({
      rev: 0,
      status: { kind: "awaiting-deposit" },
      rail: { stage: "waiting" },
    });
    expect(requests.meldDelayed).toBe(false);
    expect(notFoundWarnings()).toEqual(["[meld] status for mfr not found (1/3)"]);
    await nextPoll();
    expect(client.reads).toEqual({ mfr: 2 });
    expect(requests.get(CARD_REF)).toMatchObject({
      rev: 0,
      status: { kind: "awaiting-deposit" },
      rail: { stage: "waiting" },
    });
    expect(requests.meldDelayed).toBe(false);
    expect(notFoundWarnings()).toEqual([
      "[meld] status for mfr not found (1/3)",
      "[meld] status for mfr not found (2/3)",
    ]);

    // The third declares the payment gone and ends the poll.
    await nextPoll();
    expect(client.reads).toEqual({ mfr: 3 });
    expect(requests.meldStage).toBe("failed");
    expect(requests.meldFailureMessage).toBe(MELD_GONE);
    expect(requests.get(CARD_REF)).toMatchObject({
      status: { kind: "failed", recoverable: false },
      rail: { stage: "failed" },
    });
    await nextPoll();
    expect(client.reads).toEqual({ mfr: 3 });
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

  it("dead Meld requests are not re-read", async () => {
    const requests = useRequestsStore();
    const client = fakeMeldClient("session_opened");
    setMeldStatusClientFactory(() => client);
    const expiredAt = FIXTURE_NOW - MINUTE;
    // Expired inside the grace window: a late "received" could still re-open it.
    await requests.create(
      requestRefOf("meld-card", 10),
      cardRecord(10, "mfr-expired-fresh", {
        status: { kind: "expired", at: expiredAt },
        deadline: { depositExpiresAt: expiredAt, source: "route" },
      }),
    );
    // Expired past the window and the grace.
    const longGone = FIXTURE_NOW - TOMBSTONE_GRACE_MS - MINUTE;
    await requests.create(
      requestRefOf("meld-card", 11),
      cardRecord(11, "mfr-expired-stale", {
        status: { kind: "expired", at: longGone },
        deadline: { depositExpiresAt: longGone, source: "route" },
      }),
    );
    // Failed on the provider's own final word.
    await requests.create(
      requestRefOf("meld-card", 12),
      cardRecord(12, "mfr-failed", {
        status: { kind: "failed", at: expiredAt, recoverable: false },
        rail: {
          provider: "meld",
          status: "failed",
          stage: "failed",
          failure: { kind: "deposit-rejected", message: "declined" },
          updatedAt: expiredAt,
        },
      }),
    );
    await requests.create(
      requestRefOf("meld-card", 13),
      cardRecord(13, "mfr-cancelled", {
        status: { kind: "cancelled", at: expiredAt },
        cancelledAt: expiredAt,
      }),
    );

    await requests.reconcile("refresh");

    expect(client.reads).toEqual({ "mfr-expired-fresh": 1 });
    expect(requests.get(requestRefOf("meld-card", 10))?.status).toEqual({
      kind: "expired",
      at: expiredAt,
    });
  });

  it("three consecutive not-found answers across passes mark a background request gone; a good answer in between resets", async () => {
    const requests = useRequestsStore();
    const client = fakeMeldClient("transaction_seen");
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    client.failure = notFound;
    setMeldStatusClientFactory(() => client);
    await requests.create(CARD_REF, migrated(unsubmittedCard));

    // Two passes of "not found": the request waits.
    await requests.reconcile("refresh");
    await requests.reconcile("refresh");
    expect(client.reads).toEqual({ "mfr-fixture-card-2": 2 });
    expect(requests.get(CARD_REF)).toMatchObject({
      rev: 0,
      status: { kind: "awaiting-deposit" },
      rail: { stage: "waiting" },
    });

    // The adapter answers again: the count starts over.
    client.failure = null;
    await requests.reconcile("refresh");
    expect(client.reads).toEqual({ "mfr-fixture-card-2": 3 });
    expect(requests.get(CARD_REF)).toMatchObject({
      status: { kind: "deposit-seen", via: "rail" },
      rail: { stage: "received" },
    });

    // Three more in a row: the payment is gone. The provider saw the deposit, so its word fails
    // the rail; the record itself is the worker's to fail.
    client.failure = notFound;
    await requests.reconcile("refresh");
    await requests.reconcile("refresh");
    expect(requests.get(CARD_REF)?.rail.stage).toBe("received");
    await requests.reconcile("refresh");
    expect(client.reads).toEqual({ "mfr-fixture-card-2": 6 });
    expect(requests.get(CARD_REF)).toMatchObject({
      status: { kind: "deposit-seen", via: "rail" },
      rail: { stage: "failed", failure: { kind: "unknown", message: MELD_GONE } },
    });
    expect(notFoundWarnings()).toEqual([
      "[meld] status for mfr-fixture-card-2 not found (1/3)",
      "[meld] status for mfr-fixture-card-2 not found (2/3)",
      "[meld] status for mfr-fixture-card-2 not found (1/3)",
      "[meld] status for mfr-fixture-card-2 not found (2/3)",
    ]);
  });
});
