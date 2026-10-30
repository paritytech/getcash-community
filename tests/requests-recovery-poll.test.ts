// A trapped top-up's claim fee through the store, hosted: the purse asked under the attempt's id,
// the host's word read back until it is final, and an attempt the host turned out not to know
// asked again under the same id.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setRequestsClock, type TopUpRecord } from "../app/funding/requests/model";
import { recoveryPaymentIdFor } from "../app/funding/requests/payment-id";
import {
  createMemoryKeyedStorage,
  REQUEST_INDEX_KEY,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  WORKER_JOBS_KEY,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { requestRefOf, serializeRequestIndex } from "../app/utils/request-index";
import { awaitingDepositCryptoRecord, FIXTURE_NOW, fixtureWorkerJobs } from "./fixtures/requests";

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
  readPaymentStatus: vi.fn(async () => ({ status: "not-found" })),
  requestKeyPayment: vi.fn(async () => {}),
  PaymentRefusedError: class PaymentRefusedError extends Error {
    constructor(
      message: string,
      readonly refusal = "other",
    ) {
      super(message);
    }
  },
  nudgeWithdrawTicks: () => {},
}));

import * as live from "../lib/withdraw-live";

const readStatus = vi.mocked(live.readPaymentStatus);
const asked = vi.mocked(live.requestKeyPayment);

const MINUTE = 60_000;
const at = (minutes: number) => FIXTURE_NOW + minutes * MINUTE;
const REF = requestRefOf("dot-assethub", 3);
const CLAIMER = `0x${"07".repeat(32)}`;
const KEY = `0x${"ab".repeat(32)}`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

/** The top-up as stored, with its job in the trap and the fee sized. */
async function seedTrapped() {
  const storage = createMemoryKeyedStorage();
  setRecordStorage(storage);
  await storage.write(requestKey(REF), JSON.stringify(awaitingDepositCryptoRecord));
  await storage.write(REQUEST_INDEX_KEY, serializeRequestIndex([REF]));
  const job = fixtureWorkerJobs["dot-assethub:3"]!;
  await storage.write(
    WORKER_JOBS_KEY,
    JSON.stringify({
      "dot-assethub:3": {
        ...job,
        phase: "recovering",
        lastTickAt: at(2),
        state: { ...job.state, xcmSubmitted: true, fundsSeenAt: at(0), sentToPeople: "25000000" },
        trap: { amount: "25000000", key: KEY, claimerHex: CLAIMER, at: at(2) },
        recovery: {
          phase: "funding",
          feeCash: "7799",
          askCash: "10000",
          round: 0,
          held: "0",
          attempts: 0,
          nonceAtClaim: null,
          sentAt: null,
        },
      },
    }),
  );
}

describe("requests store: a trapped top-up's fee, hosted", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => at(3));
    readStatus.mockClear();
    asked.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    requests.stopPaymentPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMirrorStorage(null);
  });

  it("asks the purse under the attempt's id, reads the host's word back, and asks again under the same id when the host does not know it", async () => {
    await seedTrapped();
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    const payment = () => (requests.get(REF) as TopUpRecord).recovery?.payment;
    expect(requests.get(REF)?.status).toMatchObject({ kind: "recovering", step: "funding" });

    // The purse is asked for the fee under attempt 0's id, with the fee's round on the stamp.
    expect(await requests.requestRecoveryPayment(REF)).toEqual({ ok: true });
    await settle();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked.mock.calls[0]![0]).toMatchObject({
      idHex: recoveryPaymentIdFor(CLAIMER, 0),
      amount: 10_000n,
    });
    expect(payment()).toMatchObject({ attempt: 0, status: "processing", round: 0 });

    // The host's word is read back on the top-up as on a withdrawal, until it is final.
    readStatus.mockResolvedValueOnce({ status: "completed" });
    expect(await requests.observePaymentStatus(REF)).toBe("ok");
    expect(payment()).toMatchObject({ attempt: 0, status: "completed" });

    // A host that turned out not to know the attempt is asked again under the same id, and the
    // stamp starts over.
    readStatus.mockResolvedValueOnce({ status: "not-found" });
    await requests.observePaymentStatus(REF);
    expect(payment()?.status).toBe("not-found");
    expect(await requests.requestRecoveryPayment(REF)).toEqual({ ok: true });
    await settle();
    expect(asked).toHaveBeenCalledTimes(2);
    expect(asked.mock.calls[1]![0]).toMatchObject({ idHex: recoveryPaymentIdFor(CLAIMER, 0) });
    expect(payment()).toMatchObject({ attempt: 0, status: "processing", requestedAt: at(3) });

    // A payment the purse made short is over: the next ask is a fresh attempt under its own id.
    readStatus.mockResolvedValueOnce({ status: "partiallyClaimed", actualClaimed: "4000" });
    await requests.observePaymentStatus(REF);
    expect(payment()?.status).toBe("partiallyClaimed");
    expect(await requests.requestRecoveryPayment(REF)).toEqual({ ok: true });
    await settle();
    expect(asked).toHaveBeenCalledTimes(3);
    expect(asked.mock.calls[2]![0]).toMatchObject({ idHex: recoveryPaymentIdFor(CLAIMER, 1) });
    expect(payment()).toMatchObject({ attempt: 1, status: "processing" });

    // A request that failed for a reason that was not the host's refusal may have been paid: it
    // is asked again under the same id, and the host's answer takes the stamp over.
    readStatus.mockResolvedValueOnce({ status: "completed" });
    await requests.observePaymentStatus(REF);
    asked.mockRejectedValueOnce(new Error("socket closed"));
    // A later round moves the stamp out of its round so the fee is asked for anew.
    await requests.observe(REF, {
      source: "worker",
      at: at(4),
      job: {
        phase: "recovering",
        done: false,
        fundsSeenAt: at(0),
        lastTickAt: at(4),
        claim: null,
        recovery: {
          trappedAmount: "25000000",
          trappedAt: at(2),
          claimerHex: CLAIMER,
          phase: "funding",
          round: 1,
          askCash: "10000",
        },
      },
    });
    expect(await requests.requestRecoveryPayment(REF)).toEqual({ ok: true });
    await settle();
    expect(asked).toHaveBeenCalledTimes(4);
    expect(payment()).toMatchObject({ attempt: 2, status: "failed", refusal: "other" });
    expect(await requests.requestRecoveryPayment(REF)).toEqual({ ok: true });
    await settle();
    expect(asked).toHaveBeenCalledTimes(5);
    expect(asked.mock.calls[4]![0]).toMatchObject({ idHex: recoveryPaymentIdFor(CLAIMER, 2) });
    expect(payment()).toMatchObject({ attempt: 2, status: "processing" });
  });

  it("polls the host for the fee's payment while the top-up is on screen and its word is pending", async () => {
    await seedTrapped();
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    requests.setForeground(REF);
    await settle();
    // Nothing asked yet: nothing to read.
    expect(readStatus).not.toHaveBeenCalled();

    // Once the host registered the payment, its status is read; a final word ends the poll.
    readStatus.mockResolvedValue({ status: "completed" });
    await requests.requestRecoveryPayment(REF);
    await settle();
    await settle();
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect((requests.get(REF) as TopUpRecord).recovery?.payment?.status).toBe("completed");
  });
});
