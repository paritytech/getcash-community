// The withdrawal kind through the store: its record lives in the same map as the top-ups, the
// worker poll reads the withdrawal blob for it, a withdrawal job with no record becomes one, the
// payment's stamps are critical writes, and the cancel takes its last look at the key.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  JOB_POLL_MS,
  PAYMENT_WINDOW_MS,
  setRequestsClock,
  type WithdrawalRecord,
} from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  REQUEST_INDEX_KEY,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  WITHDRAW_JOBS_KEY,
  type KeyedStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { requestRefOf, serializeRequestIndex, type RequestRef } from "../app/utils/request-index";
import { awaitingDepositCryptoRecord, FIXTURE_NOW } from "./fixtures/requests";

const MINUTE = 60_000;
/** How long a poll tick may take to land: its worker nudge imports modules the fake clock cannot
 *  drive, so the outcome is awaited in real time. */
const POLL_SETTLES = { timeout: 10_000, interval: 5 };
const STARTED = FIXTURE_NOW - 5 * MINUTE;
const SOURCE = "wd:pas-assethub";
const REF = requestRefOf(SOURCE, 2);
const SESSION = `${SOURCE}:2`;
const KEY_ADDRESS = "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ";
const KEY_HEX = `0x${"07".repeat(32)}`;
const LANDING_HEX = `0x${"aa".repeat(32)}`;
const DESTINATION = {
  chain: "Asset Hub",
  asset: "PAS",
  address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
};

/** The hand-off as the worker keeps it on its job, and as the record carries it. */
const handoff = {
  label: "wd:eph:pas-assethub:2",
  keyAddress: KEY_ADDRESS,
  keyPublicKeyHex: KEY_HEX,
  amount: "21000000",
  destination: DESTINATION,
  landingHex: LANDING_HEX,
  rail: "direct" as const,
  assetHubGenesis: "0xah",
  peopleGenesis: "0xpe",
  peopleParaId: 1004,
  assetHubParaId: 1000,
  poolAccount: "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B",
  slippagePct: 5,
  paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS,
};

function withdrawal(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  return {
    schema: 2,
    kind: "withdrawal",
    ref: REF,
    rev: 0,
    updatedAt: STARTED,
    startedAt: STARTED,
    amountHuman: "21",
    route: "crypto",
    destination: DESTINATION,
    key: { label: handoff.label, address: KEY_ADDRESS, publicKeyHex: KEY_HEX },
    payment: { attempt: 0, requestedAt: STARTED, id: "pay-1" },
    deadline: { paymentExpiresAt: handoff.paymentExpiresAt },
    handoff,
    status: { kind: "awaiting-payment" },
    rail: { provider: "direct", stage: "waiting", updatedAt: STARTED },
    witnesses: {},
    ...overrides,
  };
}

/** A withdrawal job as the worker persists it. */
function job(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    sessionId: SESSION,
    ...handoff,
    phase: "await-cash",
    done: false,
    createdAt: STARTED,
    armedAt: STARTED,
    lastTickAt: FIXTURE_NOW - 2_000,
    state: {
      attempts: 0,
      rejections: 0,
      submitted: false,
      destinationPasBefore: null,
      expectedLanding: null,
      fundsSeenAt: null,
      workedMs: 0,
    },
    txs: [],
    ...overrides,
  };
}

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

let storage: KeyedStorage;

async function seed(records: WithdrawalRecord[], jobs: Record<string, unknown>): Promise<void> {
  for (const record of records) {
    await storage.write(requestKey(record.ref), JSON.stringify(record));
  }
  await storage.write(REQUEST_INDEX_KEY, serializeRequestIndex(records.map((r) => r.ref)));
  await storage.write(WITHDRAW_JOBS_KEY, JSON.stringify(jobs));
}

async function stored(ref: RequestRef): Promise<Record<string, unknown> | null> {
  const raw = await storage.read(requestKey(ref));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

describe("requests store: withdrawals", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    storage = createMemoryKeyedStorage();
    setRecordStorage(storage);
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => FIXTURE_NOW);
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

  it("lists a withdrawal beside the top-ups, in its own view", async () => {
    await seed([withdrawal()], {});
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    expect(requests.openWithdrawals.map((r) => r.ref)).toEqual([REF]);
    expect(requests.openTopUps).toEqual([]);
    expect(requests.records).toHaveLength(1);
    // Its job is unknown to the worker: the store says so and nothing else moves.
    expect(requests.get(REF)).toMatchObject({
      status: { kind: "awaiting-payment" },
      witnesses: { worker: { known: false, at: FIXTURE_NOW } },
    });
  });

  it("nudges the worker into a pass on each poll round while a withdrawal is its to move", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const call = vi.fn(async () => ({}));
    vi.doMock("../lib/worker-rpc", () => ({
      getStorageWorkerManager: () => ({ isAvailable: () => true, call }),
    }));
    try {
      const rpc = await import("../lib/worker-rpc");
      expect(rpc.getStorageWorkerManager().isAvailable()).toBe(true);
      // Warm the live module, so the store's own import of it is not first-time I/O.
      await import("../lib/withdraw-live");
      await seed([withdrawal()], {
        [SESSION]: job({ phase: "convert", state: { fundsSeenAt: FIXTURE_NOW - 60_000 } }),
      });
      const requests = useRequestsStore();
      await requests.reconcile("boot");
      expect(requests.get(REF)?.status.kind).toBe("converting");
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
      await vi.waitFor(() => expect(call).toHaveBeenCalledWith("tickAllWithdraw"), POLL_SETTLES);
    } finally {
      vi.doUnmock("../lib/worker-rpc");
      vi.useRealTimers();
    }
  });

  it("starts the job poll when a withdrawal is created, without a reconcile", async () => {
    // Warm the modules the poll's nudge imports: cold, that first-time I/O outlasts the turns
    // this test spends waiting, and the witness never lands within them.
    await Promise.all([import("../lib/worker-rpc"), import("../lib/withdraw-live")]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      await storage.write(
        WITHDRAW_JOBS_KEY,
        JSON.stringify({ [SESSION]: job({ phase: "await-cash" }) }),
      );
      const requests = useRequestsStore();
      await requests.create(REF, withdrawal());
      expect(requests.get(REF)?.witnesses.worker).toBeUndefined();
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
      await vi.waitFor(
        () =>
          expect(requests.get(REF)?.witnesses.worker).toMatchObject({
            known: true,
            phase: "await-cash",
          }),
        POLL_SETTLES,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves a withdrawal by its job in the withdrawal blob, through to sent", async () => {
    const seenAt = FIXTURE_NOW - 60_000;
    await seed([withdrawal()], {
      [SESSION]: job({ phase: "convert", state: { fundsSeenAt: seenAt, submitted: false } }),
    });
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    expect(requests.get(REF)).toMatchObject({
      rev: 1,
      status: { kind: "converting", at: FIXTURE_NOW, step: "convert" },
      witnesses: { worker: { known: true, phase: "convert", fundsSeenAt: seenAt } },
    });
    // The payment leg completing is critical: on the host before the reconcile resolved.
    expect(await stored(REF)).toMatchObject({ status: { kind: "converting" } });

    await storage.write(
      WITHDRAW_JOBS_KEY,
      JSON.stringify({
        [SESSION]: job({
          phase: "done",
          done: true,
          state: { fundsSeenAt: seenAt, submitted: true },
        }),
      }),
    );
    await requests.reconcile("refresh");
    expect(requests.get(REF)).toMatchObject({
      status: { kind: "sent", at: FIXTURE_NOW },
      rail: { stage: "delivered" },
      witnesses: { worker: { phase: "done", done: true } },
    });
    expect(await stored(REF)).toMatchObject({ status: { kind: "sent" } });
  });

  it("gives a withdrawal job the surface never recorded a record from the hand-off it keeps", async () => {
    await seed([], { [SESSION]: job({ phase: "swap", state: { fundsSeenAt: STARTED + 1_000 } }) });
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    const record = requests.get(REF);
    expect(record).toMatchObject({
      kind: "withdrawal",
      amountHuman: "21",
      destination: DESTINATION,
      key: { address: KEY_ADDRESS, publicKeyHex: KEY_HEX },
      // The prompt happened before the hand-off, under the first attempt's id: the key itself.
      payment: { attempt: 0, requestedAt: STARTED, id: KEY_HEX },
      status: { kind: "converting", step: "swap" },
      rail: { provider: "direct" },
    });
    expect(await stored(REF)).not.toBeNull();
  });

  it("rebuilds a meld withdrawal job the surface never recorded as an already deposit-known sale", async () => {
    // The worker is never handed a meld job until its sale has disclosed a payout address (see
    // requests-withdrawal-meld-handoff.test.ts), so a meld job that exists to be recovered from
    // here always carries the full `meld` sub-object the hand-off was built with.
    const meld = {
      committedAmount: "900000000",
      providerPayoutAddress: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
      orderRef: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      meldFundingRequestId: "funding-req-1",
      quotedFiatAmount: "156.30",
      quotedFiatCurrency: "USD",
      cryptoCurrency: "DOT_ASSETHUB",
    };
    await seed([], {
      [SESSION]: job({
        rail: "meld",
        meld,
        phase: "pay-provider",
        state: { fundsSeenAt: STARTED + 1_000, submitted: true },
      }),
    });
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    const record = requests.get(REF);
    expect(record?.rail.provider).toBe("meld");
    if (record?.rail.provider !== "meld" || record.rail.sale.phase !== "deposit-known") {
      throw new Error("expected a reconstructed meld sale, already deposit-known");
    }
    expect(record.rail.sale).toMatchObject({
      meldFundingRequestId: "funding-req-1",
      committedAmount: "900000000",
      quotedFiatAmount: "156.30",
      quotedFiatCurrency: "USD",
      deposit: {
        address: meld.providerPayoutAddress,
        amount: "0.09", // 900000000 planck at 10 decimals
        currency: "DOT_ASSETHUB",
      },
    });
    expect(record.handoff.meld).toEqual(meld);
  });

  it("refuses a meld job missing its sale details, the same as any other malformed job", async () => {
    await seed([], { [SESSION]: job({ rail: "meld", phase: "await-cash" }) });
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    expect(requests.has(REF)).toBe(false);
  });

  it("does not sweep a cancelled withdrawal's job back into a record", async () => {
    await seed([], { [SESSION]: job({ phase: "failed", failure: "cancelled" }) });
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    expect(requests.has(REF)).toBe(false);
  });

  it("writes the prompt's stamp to the host at once", async () => {
    await seed([withdrawal({ payment: { attempt: 0 } })], {});
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    await requests.markPaymentRequested(REF, 0, "pay-9");
    expect(await stored(REF)).toMatchObject({
      payment: { attempt: 0, requestedAt: FIXTURE_NOW, id: "pay-9" },
    });
  });

  it("refuses a cancel once anything was paid, and takes its last look at the key otherwise", async () => {
    await seed([withdrawal({ payment: { attempt: 0 } })], {});
    const requests = useRequestsStore();
    await requests.reconcile("boot");

    // Nothing prompted, the key empty: the cancel may proceed.
    expect(await requests.cancelWithdrawal(REF, { readKeyCash: async () => 0n })).toBe("ok");
    // CASH on the key refuses it and reaches the record as the read that found it.
    expect(await requests.cancelWithdrawal(REF, { readKeyCash: async () => 21_000_000n })).toBe(
      "refused",
    );
    expect(requests.get(REF)).toMatchObject({
      status: { kind: "paid", via: "pre-cancel" },
      paidAmount: "21000000",
    });
    expect(await requests.cancelWithdrawal(REF, { readKeyCash: async () => 0n })).toBe("refused");
  });

  it("leaves a cancel unconfirmed when the key does not answer", async () => {
    await seed([withdrawal({ payment: { attempt: 0 } })], {});
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    const outcome = await requests.cancelWithdrawal(REF, {
      readKeyCash: () => Promise.reject(new Error("no chain")),
    });
    expect(outcome).toBe("unconfirmed");
  });

  it("leaves a cancel of a prompted payment unconfirmed when the host cannot be asked", async () => {
    // Prompted under a known id; outside a host there is no worker to ask about it.
    await seed([withdrawal()], {});
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    expect(await requests.cancelWithdrawal(REF, { readKeyCash: async () => 0n })).toBe(
      "unconfirmed",
    );
  });

  it("refuses a cancel once the host has the payment in hand", async () => {
    await seed(
      [
        withdrawal({
          payment: { attempt: 0, requestedAt: STARTED, id: "pay-1", status: "processing" },
        }),
      ],
      {},
    );
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    expect(await requests.cancelWithdrawal(REF, { readKeyCash: async () => 0n })).toBe("refused");
  });

  it("refuses a Meld sale's cancel once its deposit address is known, without reading the key or the host", async () => {
    let readKeyCalled = false;
    await seed(
      [
        withdrawal({
          payment: { attempt: 0 },
          rail: {
            provider: "meld",
            stage: "waiting",
            updatedAt: STARTED,
            sale: {
              phase: "deposit-known",
              meldFundingRequestId: "funding-1",
              committedAmount: "900000000",
              quotedFiatAmount: "150.00",
              quotedFiatCurrency: "USD",
              deposit: {
                address: "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM",
                amount: "0.09",
                currency: "DOT_ASSETHUB",
                observedAt: STARTED,
              },
            },
          },
        }),
      ],
      {},
    );
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    // Nothing was paid and the rank is still 0 — a rank/payment check alone would say "ok" here.
    const outcome = await requests.cancelWithdrawal(REF, {
      readKeyCash: async () => {
        readKeyCalled = true;
        return 0n;
      },
    });
    expect(outcome).toBe("refused");
    // Refused before it ever asked the chain: a bounded read that timed out would have answered
    // "unconfirmed" instead, telling the seller to check their connection when the honest answer
    // is that the sale has already moved past the point a cancel can be honoured.
    expect(readKeyCalled).toBe(false);
  });

  it("keeps the top-up paths for top-ups: their cancel and retry refuse a withdrawal", async () => {
    await seed([withdrawal({ payment: { attempt: 0 } })], {});
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    expect(await requests.cancel(REF, { readBurner: async () => 0n })).toBe("refused");
    expect(await requests.retry(REF)).toBe(false);
    // And a top-up is not a withdrawal.
    await storage.write(
      requestKey(requestRefOf("dot-assethub", 3)),
      JSON.stringify(awaitingDepositCryptoRecord),
    );
    await storage.write(
      REQUEST_INDEX_KEY,
      serializeRequestIndex([REF, requestRefOf("dot-assethub", 3)]),
    );
    await requests.reconcile("refresh");
    expect(
      await requests.cancelWithdrawal(requestRefOf("dot-assethub", 3), {
        readKeyCash: async () => 0n,
      }),
    ).toBe("refused");
    expect(requests.openTopUps).toHaveLength(1);
    expect(requests.openWithdrawals).toHaveLength(1);
  });
});
