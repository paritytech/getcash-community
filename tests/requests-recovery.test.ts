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
import {
  FROM_BALANCE,
  FROM_BALANCE_AGAIN,
  recoveryPrompt,
  SEND_DEPOSIT,
  trappedCash,
  type PurseWord,
} from "../app/funding/timeline/recovery";
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

  it("keeps the status and the recovery under the same worker facts, so a poll that saw nothing new is a witness and not a write", () => {
    const record = trapped();
    const again = reduce(record, { ...trappedJob(view()), at: at(5) }) as TopUpRecord;
    expect(again.status).toBe(record.status);
    expect(again.recovery).toBe(record.recovery);
    const asked = requested(record);
    const polled = reduce(asked, { ...trappedJob(view()), at: at(6) }) as TopUpRecord;
    expect(polled.recovery).toBe(asked.recovery);
    // A moved fact is a new recovery.
    const moved = reduce(asked, { ...trappedJob(view({ askCash: "20000" })), at: at(7) });
    expect((moved as TopUpRecord).recovery).not.toBe(asked.recovery);
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

  it("keeps the token the buyer picked to send, through the worker's ticks", () => {
    const picked = reduce(trapped(), {
      source: "user",
      at: at(3),
      event: "recovery-token-picked",
      token: "USDT",
    }) as TopUpRecord;
    expect(picked.recovery?.depositToken).toBe("USDT");
    const ticked = reduce(picked, { ...trappedJob(view()), at: at(4) }) as TopUpRecord;
    expect(ticked.recovery?.depositToken).toBe("USDT");
    expect(ticked.status).toMatchObject({ kind: "recovering", step: "funding" });
    // The same pick again is a witness, not a write.
    expect(
      reduce(ticked, { source: "user", at: at(5), event: "recovery-token-picked", token: "USDT" }),
    ).toBe(ticked);
    const changed = reduce(ticked, {
      source: "user",
      at: at(5),
      event: "recovery-token-picked",
      token: "PAS",
    }) as TopUpRecord;
    expect(changed.recovery?.depositToken).toBe("PAS");
    // Not recovering: nothing to pick for.
    const notRecovering = awaiting();
    expect(
      reduce(notRecovering, {
        source: "user",
        at: at(3),
        event: "recovery-token-picked",
        token: "USDT",
      }),
    ).toBe(notRecovering);
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
  /** The band read with the purse, as the journey reads it. */
  const promptWith = (record: TopUpRecord, purse: PurseWord) => recoveryPrompt(record, purse);
  const COVERS = 226_780_000n;
  const SHORT = 5_000n;
  const host = (record: TopUpRecord, payment: Record<string, unknown>) =>
    reduce(record, {
      source: "host",
      at: at(4),
      payment: { attempt: 0, ...payment },
    } as Observation);

  it("holds the current line amber and offers the purse alone while the balance covers the fee", () => {
    const timeline = timelineOf(trapped());
    expect(timeline?.view.state).toBe("delayed");
    expect(timeline?.message).toEqual({ text: "Your Cash is almost here", delay: true });
    expect(timeline?.detail).toBe("A $0.01 network fee is needed to add it to your balance.");
    expect(timeline?.recovery?.actions).toEqual([FROM_BALANCE]);
    expect(listHeadline("crypto", timeline)).toEqual({
      text: "Needs a step from you",
      delayed: true,
    });
    // The purse unread counts as covering the fee; a read balance decides.
    expect(promptWith(trapped(), COVERS)?.actions).toEqual([FROM_BALANCE]);
    expect(promptWith(trapped(), BigInt(view().askCash!))?.actions).toEqual([FROM_BALANCE]);
  });

  it("names the Cash in the trap, not the quote, when a swap filled off it", () => {
    const short = trapped(view({ trappedAmount: "20000000", phase: "claiming" }));
    expect(trappedCash(short)).toBe("20");
    expect(timelineOf(short)?.detail).toBe(
      "The fee is paid. Your $20 Cash will be in your balance in a moment.",
    );
    // Until the worker found the trap there is only the quote.
    expect(trappedCash(awaiting())).toBe(awaiting().amountHuman);
  });

  it("offers a deposit alone while the balance falls short of the fee, or there is no purse", () => {
    for (const purse of [SHORT, "none"] as const) {
      const prompt = promptWith(trapped(), purse);
      expect(prompt?.message.text).toBe("Your Cash is almost here");
      expect(prompt?.detail).toBe(
        "A $0.01 network fee is needed to add it. You can pay it from another wallet.",
      );
      expect(prompt?.actions).toEqual([SEND_DEPOSIT]);
    }
  });

  it("offers nothing until the worker sized the fee", () => {
    const timeline = timelineOf(trapped(view({ askCash: undefined })));
    expect(timeline?.message?.text).toBe("Your Cash is almost here");
    expect(timeline?.detail).toBe("Working out the network fee.");
    expect(timeline?.recovery?.actions).toEqual([]);
    expect(listHeadline("crypto", timeline)).toEqual({
      text: "Your Cash is almost here",
      delayed: true,
    });
  });

  it("waits quietly once the purse was asked, and says the Cash is being added once it paid", () => {
    const asked = timelineOf(requested(trapped()));
    expect(asked?.message?.text).toBe("Your Cash is almost here");
    // Asked and not yet answered: the sheet is up.
    expect(asked?.detail).toBe("Waiting for the fee to be approved.");
    expect(asked?.recovery?.actions).toEqual([]);
    const registered = timelineOf(host(requested(trapped()), { status: "processing" }));
    expect(registered?.message?.text).toBe("Adding your Cash");
    expect(registered?.detail).toBe(
      "The fee is paid. Your $25 Cash will be in your balance in a moment.",
    );
    expect(registered?.recovery?.actions).toEqual([]);
    expect(listHeadline("crypto", registered)).toEqual({
      text: "Adding your Cash",
      delayed: true,
    });
  });

  it("offers a deposit alone once the balance fell short, until a read says it covers the fee again", () => {
    const short = refused(requested(trapped()));
    const unread = timelineOf(short);
    expect(unread?.message?.text).toBe("The fee wasn't paid");
    expect(unread?.detail).toBe("Your balance couldn't cover it. Pay the fee from another wallet.");
    expect(unread?.recovery?.actions).toEqual([SEND_DEPOSIT]);
    expect(promptWith(short, SHORT)?.actions).toEqual([SEND_DEPOSIT]);
    // The purse was topped up since: the purse is offered again.
    const toppedUp = promptWith(short, COVERS);
    expect(toppedUp?.detail).toBe(
      "Your $25 Cash is still waiting. Try again, or pay from another wallet.",
    );
    expect(toppedUp?.actions).toEqual([FROM_BALANCE_AGAIN, SEND_DEPOSIT]);
  });

  it("asks for the rest when the purse paid part of the fee", () => {
    const part = host(requested(trapped()), { status: "partiallyClaimed", actualClaimed: "4000" });
    const covers = timelineOf(part);
    expect(covers?.message?.text).toBe("We couldn't add your Cash yet");
    expect(covers?.detail).toBe(
      "Your balance covered part of the fee. Another $0.01 is needed. Pay it from your balance or from another wallet.",
    );
    expect(covers?.recovery?.actions).toEqual([FROM_BALANCE, SEND_DEPOSIT]);
    const short = promptWith(part, SHORT);
    expect(short?.detail).toBe(
      "Your balance covered part of the fee. Another $0.01 is needed. Pay it from another wallet.",
    );
    expect(short?.actions).toEqual([SEND_DEPOSIT]);
  });

  it("offers the purse again, then a deposit, when the sheet was declined or the host failed otherwise", () => {
    const declined = host(requested(trapped()), {
      status: "failed",
      reason: "declined",
      refusal: "declined",
    });
    const timeline = timelineOf(declined);
    expect(timeline?.message?.text).toBe("The fee wasn't paid");
    expect(timeline?.detail).toBe(
      "Your $25 Cash is still waiting. Try again, or pay from another wallet.",
    );
    expect(timeline?.recovery?.actions).toEqual([FROM_BALANCE_AGAIN, SEND_DEPOSIT]);
    // Short of the fee since: a deposit is the one way.
    const short = promptWith(declined, SHORT);
    expect(short?.detail).toBe("Your $25 Cash is still waiting. Pay the fee from another wallet.");
    expect(short?.actions).toEqual([SEND_DEPOSIT]);

    const failed = timelineOf(
      host(requested(trapped()), { status: "failed", reason: "boom", refusal: "other" }),
    );
    expect(failed?.message?.text).toBe("The fee wasn't paid");
    expect(failed?.recovery?.actions).toEqual([FROM_BALANCE_AGAIN, SEND_DEPOSIT]);
  });

  it("offers the purse again when the host does not know the payment it was asked for", () => {
    const unknown = timelineOf(host(requested(trapped()), { status: "not-found" }));
    expect(unknown?.detail).toBe("A $0.01 network fee is needed to add it to your balance.");
    expect(unknown?.recovery?.actions).toEqual([FROM_BALANCE]);
  });

  it("asks for the fee again once the worker's round moved past the payment, paid or not", () => {
    const paid = host(requested(trapped()), { status: "completed" }) as TopUpRecord;
    expect(timelineOf(paid)?.message?.text).toBe("Adding your Cash");
    const moved = reduce(paid, {
      ...trappedJob(view({ round: 1, askCash: "20000" })),
      at: at(5),
    }) as TopUpRecord;
    const covers = timelineOf(moved);
    expect(covers?.message?.text).toBe("We couldn't add your Cash yet");
    expect(covers?.detail).toBe(
      "Another $0.02 network fee is needed. Pay it from your balance or from another wallet.",
    );
    expect(covers?.recovery?.actions).toEqual([FROM_BALANCE, SEND_DEPOSIT]);
    const short = promptWith(moved, SHORT);
    expect(short?.detail).toBe("Another $0.02 network fee is needed. Pay it from another wallet.");
    expect(short?.actions).toEqual([SEND_DEPOSIT]);
  });

  it("says a deposit is being converted, then that the claim is on its way", () => {
    const converting = timelineOf(trapped(view({ deposit: "swap" })));
    expect(converting?.message?.text).toBe("Adding your Cash");
    expect(converting?.detail).toBe("Converting what you sent to cover the fee.");
    expect(converting?.recovery?.actions).toEqual([]);
    const claiming = timelineOf(trapped(view({ phase: "claiming" })));
    expect(claiming?.message?.text).toBe("Adding your Cash");
    expect(claiming?.detail).toBe(
      "The fee is paid. Your $25 Cash will be in your balance in a moment.",
    );
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
