// A top-up whose Cash is in People's trap: the record through the reducer, the views and the
// timeline's prompt, the store reading the worker's trap off its job, and the fee's payment id.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  paymentOutOfRound,
  setRequestsClock,
  topUpRankOf,
  type Observation,
  type TopUpRecord,
  type WorkerJobView,
  type WorkerRecoveryView,
} from "../app/funding/requests/model";
import { paymentIdFor, recoveryPaymentIdFor } from "../app/funding/requests/payment-id";
import { reduce } from "../app/funding/requests/reducer";
import {
  createMemoryKeyedStorage,
  REQUEST_INDEX_KEY,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  WORKER_JOBS_KEY,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { fundingStepOf, phaseLike, rowStateOf } from "../app/funding/requests/views";
import { listHeadline } from "../app/funding/timeline/list";
import { FROM_BALANCE, FROM_BALANCE_AGAIN, SEND_DEPOSIT } from "../app/funding/timeline/recovery";
import { createTopUpTimelines } from "../app/funding/timeline/timelines";
import { useRequestsStore } from "../app/stores/requests";
import { requestRefOf, serializeRequestIndex } from "../app/utils/request-index";
import { awaitingDepositCryptoRecord, FIXTURE_NOW, fixtureWorkerJobs } from "./fixtures/requests";

const MINUTE = 60_000;
const at = (minutes: number) => FIXTURE_NOW + minutes * MINUTE;
const REF = requestRefOf("dot-assethub", 3);
const CLAIMER = `0x${"07".repeat(32)}`;
const KEY = `0x${"ab".repeat(32)}`;

function awaiting(): TopUpRecord {
  const record = migrateRecord(awaitingDepositCryptoRecord, REF, FIXTURE_NOW);
  if (record?.kind !== "top-up") throw new Error("fixture did not migrate");
  return record;
}

const view = (overrides: Partial<WorkerRecoveryView> = {}): WorkerRecoveryView => ({
  trappedAmount: "25000000",
  trappedAt: at(2),
  claimerHex: CLAIMER,
  phase: "funding",
  round: 0,
  askCash: "10000",
  minimums: { PAS: "900000000", DOTUSD: "600000", USDT: null, USDC: "650000" },
  ...overrides,
});

/** The worker's job once the conversion is in a block and the trap found, at `recovery`. */
const trappedJob = (recovery: WorkerRecoveryView, overrides: Partial<WorkerJobView> = {}) =>
  ({
    source: "worker",
    at: at(2),
    job: {
      phase: "recovering",
      done: false,
      fundsSeenAt: at(0),
      lastTickAt: at(2),
      claim: null,
      conversion: {
        preparedAt: at(1),
        converted: { txHash: `0x${"11".repeat(32)}`, block: 100, at: at(1), workedMs: 5_000 },
      },
      recovery,
      ...overrides,
    },
  }) satisfies Observation;

const trapped = (recovery = view()): TopUpRecord =>
  reduce(awaiting(), trappedJob(recovery)) as TopUpRecord;

const requested = (record: TopUpRecord, attempt = 0): TopUpRecord =>
  reduce(record, {
    source: "user",
    at: at(3),
    event: "payment-requested",
    attempt,
    id: recoveryPaymentIdFor(CLAIMER, attempt),
  }) as TopUpRecord;

const refused = (record: TopUpRecord, attempt = 0): TopUpRecord =>
  reduce(record, {
    source: "host",
    at: at(4),
    payment: {
      attempt,
      status: "failed",
      reason: "The balance does not cover this fee.",
      refusal: "insufficient-balance",
    },
  }) as TopUpRecord;

describe("the reducer", () => {
  it("moves a converting top-up to recovering on the worker's trap, keeping its facts", () => {
    const record = trapped();
    expect(record.status).toEqual({ kind: "recovering", at: at(2), step: "funding" });
    expect(record.recovery).toEqual({
      trappedAmount: "25000000",
      trappedAt: at(2),
      claimerHex: CLAIMER,
      round: 0,
      askCash: "10000",
      minimums: { PAS: "900000000", DOTUSD: "600000", USDT: null, USDC: "650000" },
    });
    expect(record.converted?.at).toBe(at(1));
    expect(topUpRankOf(record)).toBe(2);
  });

  it("follows the recovery to its claim, and to claiming once the worker is done", () => {
    const claiming = reduce(trapped(), {
      ...trappedJob(view({ phase: "claiming" })),
      at: at(5),
    }) as TopUpRecord;
    // The status keeps when the trap was found; only the step moves.
    expect(claiming.status).toEqual({ kind: "recovering", at: at(2), step: "claiming" });
    const done = reduce(claiming, {
      ...trappedJob(view({ phase: "done" }), { phase: "done", done: true }),
      at: at(6),
    }) as TopUpRecord;
    expect(done.status).toEqual({ kind: "claiming", at: at(6) });
    expect(done.recovery?.trappedAmount).toBe("25000000");
  });

  it("stamps the fee's prompt before the host is asked, and keeps the host's answer on it", () => {
    const asked = requested(trapped());
    expect(asked.recovery?.payment).toEqual({
      attempt: 0,
      requestedAt: at(3),
      id: recoveryPaymentIdFor(CLAIMER, 0),
      round: 0,
    });
    // The same attempt is stamped once.
    expect(requested(asked)).toBe(asked);
    const declined = refused(asked);
    expect(declined.recovery?.payment).toMatchObject({
      attempt: 0,
      status: "failed",
      reason: "The balance does not cover this fee.",
      refusal: "insufficient-balance",
      updatedAt: at(4),
    });
    expect(declined.status.kind).toBe("recovering");
    expect(declined.witnesses.host).toEqual({ status: "failed", at: at(4) });
    // The next attempt takes a fresh id; the host's word on an old attempt is only a witness.
    const again = requested(declined, 1);
    expect(again.recovery?.payment?.id).toBe(recoveryPaymentIdFor(CLAIMER, 1));
    expect(refused(again, 0).recovery?.payment?.status).toBeUndefined();
    // A later worker read keeps the payment beside its own facts.
    const read = reduce(again, { ...trappedJob(view()), at: at(5) }) as TopUpRecord;
    expect(read.recovery?.payment?.attempt).toBe(1);
  });

  it("asks again under the same id an attempt the host turned out not to know", () => {
    const asked = requested(trapped());
    const unknown = reduce(asked, {
      source: "host",
      at: at(4),
      payment: { attempt: 0, status: "not-found" },
    }) as TopUpRecord;
    expect(unknown.recovery?.payment?.status).toBe("not-found");
    const again = reduce(unknown, {
      source: "user",
      at: at(5),
      event: "payment-requested",
      attempt: 0,
      id: recoveryPaymentIdFor(CLAIMER, 0),
    }) as TopUpRecord;
    expect(again.recovery?.payment).toEqual({
      attempt: 0,
      requestedAt: at(5),
      id: recoveryPaymentIdFor(CLAIMER, 0),
      round: 0,
    });
  });

  it("keeps a payment's round, and reads one the worker moved past as out of its round", () => {
    const asked = requested(trapped());
    expect(paymentOutOfRound(asked.recovery!)).toBe(false);
    const moved = reduce(asked, { ...trappedJob(view({ round: 1 })), at: at(5) }) as TopUpRecord;
    expect(moved.recovery?.round).toBe(1);
    expect(moved.recovery?.payment?.round).toBe(0);
    expect(paymentOutOfRound(moved.recovery!)).toBe(true);
  });

  it("is neither cancelled nor expired while the trap stands", () => {
    const record = trapped();
    const cancelled = reduce(record, {
      source: "user",
      at: at(3),
      event: "cancelled",
      depositExpiresAt: 0,
    });
    expect(cancelled.status.kind).toBe("recovering");
    const aged = reduce(record, { source: "clock", at: at(60 * 24 * 7) });
    expect(aged.status.kind).toBe("recovering");
  });

  it("stamps no prompt on a top-up that is not being recovered", () => {
    const record = awaiting();
    expect(requested(record)).toBe(record);
  });
});

describe("the views", () => {
  it("read a recovering top-up as still converting, on its way, in the finishing rows", () => {
    const record = trapped();
    expect(phaseLike(record)).toBe("swapping");
    expect(fundingStepOf(record)).toBe("await-arrival");
    expect(rowStateOf(record, "Needs a step from you")).toEqual({
      kind: "finishing",
      status: "Needs a step from you",
    });
  });
});

describe("the timeline", () => {
  const NOW = at(5);
  const timelineOf = (record: TopUpRecord) => createTopUpTimelines()(record, NOW);

  it("holds the current line amber and offers the purse first, then a deposit, with the fee", () => {
    const timeline = timelineOf(trapped());
    expect(timeline?.view.state).toBe("delayed");
    expect(timeline?.message).toEqual({
      text: "Your Cash got stuck on the way to your balance.",
      delay: true,
    });
    expect(timeline?.detail).toBe(
      "Pay the $0.01 Cash recovery fee from your balance to get it back.",
    );
    expect(timeline?.recovery?.actions).toEqual([FROM_BALANCE, SEND_DEPOSIT]);
    expect(listHeadline("crypto", timeline)).toEqual({
      text: "Needs a step from you",
      delayed: true,
    });
  });

  it("offers nothing until the worker sized the fee", () => {
    const timeline = timelineOf(trapped(view({ askCash: undefined })));
    expect(timeline?.message?.text).toBe("Your Cash got stuck on the way to your balance.");
    expect(timeline?.detail).toBe("Working out the recovery fee.");
    expect(timeline?.recovery?.actions).toEqual([]);
    expect(listHeadline("crypto", timeline)).toEqual({
      text: "Recovering your Cash",
      delayed: true,
    });
  });

  it("waits quietly once the purse was asked, and offers the deposit first once the balance fell short", () => {
    const asked = timelineOf(requested(trapped()));
    expect(asked?.message?.text).toBe("Recovering your Cash");
    expect(asked?.detail).toBe("The fee is on its way from your balance.");
    expect(asked?.recovery?.actions).toEqual([]);
    expect(listHeadline("crypto", asked)).toEqual({ text: "Recovering your Cash", delayed: true });

    const short = timelineOf(refused(requested(trapped())));
    expect(short?.message?.text).toBe("Your balance couldn't cover the recovery fee.");
    expect(short?.detail).toBe(
      "Send a small deposit to this top-up's address to cover it, or try again once you have Cash.",
    );
    expect(short?.recovery?.actions).toEqual([SEND_DEPOSIT, FROM_BALANCE_AGAIN]);
  });

  it("offers the purse first again when the sheet was declined, or the host failed otherwise", () => {
    const declined = timelineOf(
      reduce(requested(trapped()), {
        source: "host",
        at: at(4),
        payment: { attempt: 0, status: "failed", reason: "declined", refusal: "declined" },
      }),
    );
    expect(declined?.message?.text).toBe("You declined the fee payment.");
    expect(declined?.detail).toBe(
      "Try again, or send a small deposit to this top-up's address instead.",
    );
    expect(declined?.recovery?.actions).toEqual([FROM_BALANCE_AGAIN, SEND_DEPOSIT]);

    const failed = timelineOf(
      reduce(requested(trapped()), {
        source: "host",
        at: at(4),
        payment: { attempt: 0, status: "failed", reason: "boom", refusal: "other" },
      }),
    );
    expect(failed?.message?.text).toBe("The fee couldn't be paid from your balance.");
    expect(failed?.recovery?.actions).toEqual([FROM_BALANCE_AGAIN, SEND_DEPOSIT]);
  });

  it("offers the purse again when the host does not know the payment it was asked for", () => {
    const unknown = timelineOf(
      reduce(requested(trapped()), {
        source: "host",
        at: at(4),
        payment: { attempt: 0, status: "not-found" },
      }),
    );
    expect(unknown?.detail).toBe(
      "Pay the $0.01 Cash recovery fee from your balance to get it back.",
    );
    expect(unknown?.recovery?.actions).toEqual([FROM_BALANCE, SEND_DEPOSIT]);
  });

  it("asks for the fee again once the worker's round moved past the payment, paid or not", () => {
    const paid = reduce(requested(trapped()), {
      source: "host",
      at: at(4),
      payment: { attempt: 0, status: "completed" },
    }) as TopUpRecord;
    expect(timelineOf(paid)?.detail).toBe("The fee is on its way from your balance.");
    const moved = timelineOf(
      reduce(paid, { ...trappedJob(view({ round: 1, askCash: "20000" })), at: at(5) }),
    );
    expect(moved?.message?.text).toBe("The claim didn't go through.");
    expect(moved?.detail).toBe(
      "Another $0.02 Cash is needed. Pay it from your balance, or send a small deposit instead.",
    );
    expect(moved?.recovery?.actions).toEqual([FROM_BALANCE_AGAIN, SEND_DEPOSIT]);
  });

  it("says a deposit is being converted, then that the claim is on its way", () => {
    const converting = timelineOf(trapped(view({ deposit: "swap" })));
    expect(converting?.detail).toBe("Converting what you sent to cover the fee.");
    expect(converting?.recovery?.actions).toEqual([]);
    const claiming = timelineOf(trapped(view({ phase: "claiming" })));
    expect(claiming?.message?.text).toBe("Recovering your Cash");
    expect(claiming?.detail).toBe("It will be added to your balance in a moment.");
    expect(claiming?.recovery?.actions).toEqual([]);
  });
});

describe("the store", () => {
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

  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => at(3));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMirrorStorage(null);
  });

  it("reads the trap and the recovery off the worker's job, as the worker persists them", async () => {
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
            feeCash: "9_876".replace("_", ""),
            askCash: "10000",
            round: 1,
            held: "0",
            attempts: 0,
            nonceAtClaim: null,
            sentAt: null,
            minimums: {
              at: at(2),
              feeCash: "9876",
              minimums: { PAS: "900000000", DOTUSD: "600000", USDT: null, USDC: "650000" },
              keepNativeForFees: "110",
              routes: { USDT: { tier: "pool", external: "USDT" }, USDC: { tier: "psm" } },
            },
            deposit: "await-native",
          },
        },
      }),
    );
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    const record = requests.get(REF);
    expect(record?.kind).toBe("top-up");
    expect(record?.status).toMatchObject({ kind: "recovering", step: "funding" });
    expect((record as TopUpRecord).recovery).toEqual({
      trappedAmount: "25000000",
      trappedAt: at(2),
      claimerHex: CLAIMER,
      round: 1,
      askCash: "10000",
      minimums: { PAS: "900000000", DOTUSD: "600000", USDT: null, USDC: "650000" },
      deposit: "await-native",
    });
  });
});

describe("the fee's payment id", () => {
  it("never collides with the top-up's own claim id, and changes per attempt", () => {
    const first = recoveryPaymentIdFor(CLAIMER, 0);
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first).not.toBe(paymentIdFor(CLAIMER, 0));
    expect(first).not.toBe(CLAIMER);
    expect(recoveryPaymentIdFor(CLAIMER, 1)).not.toBe(first);
    expect(recoveryPaymentIdFor(CLAIMER, 1)).not.toBe(paymentIdFor(CLAIMER, 1));
  });
});
