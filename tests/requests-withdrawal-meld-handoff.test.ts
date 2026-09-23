// A meld withdrawal defers two things until its sale discloses a deposit address: the worker's
// hand-off (so it never runs the chain legs blind) and the purse's payment prompt (so a seller
// who abandons KYC never has CASH parked on a burner for a sale that did not happen). The
// background provider poll is what learns the address; `promptMeldPayments` and
// `handOffLostRequests` are what act on it, in the same reconcile pass. Extends
// tests/requests-withdrawal-store.test.ts's fixtures and tests/requests-meld-poll.test.ts's fake
// client in style.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { MeldClientLike, MeldDepositDisclosure } from "@getsome/meld";
import {
  PAYMENT_WINDOW_MS,
  setRequestsClock,
  type WithdrawalRecord,
} from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  type KeyedStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { setMeldStatusClientFactory, useRequestsStore } from "../app/stores/requests";
import { requestRefOf } from "../app/utils/request-index";
import { FIXTURE_NOW } from "./fixtures/requests";

vi.mock("../lib/host-account", () => ({ isHosted: () => true }));

class FakePaymentRefusedError extends Error {}

const seams = vi.hoisted(() => ({
  probeWithdrawKey: vi.fn(async () => ({ address: "probed", cash: 0n })),
  sendWithdrawHandoff: vi.fn(async () => {}),
  meldOrderRefFor: vi.fn(() => "5OrderRefAddressDerivedFromTheBurnerKey"),
  requestKeyPayment: vi.fn(async () => {}),
}));

vi.mock("../lib/worker-rpc", () => ({
  getStorageWorkerManager: () => ({ isAvailable: () => true, call: async () => ({}) }),
}));
vi.mock("../lib/coinage-live", () => ({
  ensureChainSubmitGrant: async () => {},
  createHostedCoinageWorld: async () => {
    throw new Error("no world is built here");
  },
}));
vi.mock("../lib/withdraw-live", () => ({
  probeWithdrawKey: seams.probeWithdrawKey,
  sendWithdrawHandoff: seams.sendWithdrawHandoff,
  meldOrderRefFor: seams.meldOrderRefFor,
  requestKeyPayment: seams.requestKeyPayment,
  PaymentRefusedError: FakePaymentRefusedError,
}));

const MINUTE = 60_000;
const STARTED = FIXTURE_NOW - 5 * MINUTE;
const SOURCE = "wd:meld-bank";
const REF = requestRefOf(SOURCE, 3);
const KEY_ADDRESS = "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ";
const KEY_HEX = `0x${"07".repeat(32)}`;
const DESTINATION = { chain: "Meld", asset: "Bank", address: "bank-ref" };
const PAYOUT_ADDRESS = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

const handoff = {
  label: "wd:eph:meld-bank:3",
  keyAddress: KEY_ADDRESS,
  keyPublicKeyHex: KEY_HEX,
  amount: "21000000",
  destination: DESTINATION,
  landingHex: KEY_HEX,
  rail: "meld" as const,
  assetHubGenesis: "0xah",
  peopleGenesis: "0xpe",
  peopleParaId: 1004,
  assetHubParaId: 1000,
  poolAccount: "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B",
  slippagePct: 5,
  paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS,
};

function meldWithdrawal(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  return {
    schema: 3,
    kind: "withdrawal",
    ref: REF,
    rev: 0,
    updatedAt: STARTED,
    startedAt: STARTED,
    amountHuman: "21",
    route: "crypto",
    destination: DESTINATION,
    key: { label: handoff.label, address: KEY_ADDRESS, publicKeyHex: KEY_HEX },
    payment: { attempt: 0 },
    deadline: { paymentExpiresAt: handoff.paymentExpiresAt },
    handoff,
    status: { kind: "awaiting-payment" },
    rail: {
      provider: "meld",
      sale: {
        phase: "awaiting-deposit-address",
        meldFundingRequestId: "mfr-1",
        committedAmount: "900000000",
        quotedFiatAmount: "156.30",
        quotedFiatCurrency: "USD",
      },
      stage: "waiting",
      updatedAt: STARTED,
    },
    witnesses: {},
    ...overrides,
  };
}

function fakeMeldClient(status: string, deposit?: MeldDepositDisclosure): MeldClientLike {
  return {
    getQuote: async () => {
      throw new Error("unused");
    },
    createSession: async () => {
      throw new Error("unused");
    },
    getStatus: async () => ({ status, ...(deposit ? { deposit } : {}) }),
    cancel: async () => {
      throw new Error("unused");
    },
  };
}

const DEPOSIT: MeldDepositDisclosure = {
  address: PAYOUT_ADDRESS,
  amount: "90",
  currency: "DOT_ASSETHUB",
  observedAt: FIXTURE_NOW,
};

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

describe("requests store: a meld withdrawal's deferred hand-off", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    storage = createMemoryKeyedStorage();
    setRecordStorage(storage);
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => FIXTURE_NOW);
    setMeldStatusClientFactory(() => null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    seams.probeWithdrawKey.mockClear();
    seams.sendWithdrawHandoff.mockClear();
    seams.meldOrderRefFor.mockClear();
    seams.requestKeyPayment.mockClear();
    seams.requestKeyPayment.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMeldStatusClientFactory(() => null);
    setMirrorStorage(null);
  });

  it("does not hand the worker a sale still awaiting its deposit address, and does not prompt its payment either", async () => {
    const requests = useRequestsStore();
    setMeldStatusClientFactory(() => fakeMeldClient("session_opened"));
    await requests.create(REF, meldWithdrawal());

    await requests.reconcile("boot");

    expect(seams.sendWithdrawHandoff).not.toHaveBeenCalled();
    expect(seams.requestKeyPayment).not.toHaveBeenCalled();
    const record = requests.get(REF);
    expect(record?.rail.provider).toBe("meld");
    expect(record?.payment.requestedAt).toBeUndefined();
    if (record?.rail.provider === "meld") {
      expect(record.rail.sale.phase).toBe("awaiting-deposit-address");
    }
  });

  it("folds a disclosed deposit through, prompts the payment for the first time, and hands the worker the sale with a full meld payload", async () => {
    const requests = useRequestsStore();
    setMeldStatusClientFactory(() => fakeMeldClient("session_opened", DEPOSIT));
    await requests.create(REF, meldWithdrawal());

    await requests.reconcile("boot");

    const record = requests.get(REF);
    expect(record?.rail.provider).toBe("meld");
    if (record?.rail.provider === "meld" && record.rail.sale.phase === "deposit-known") {
      expect(record.rail.sale.deposit).toEqual(DEPOSIT);
    } else {
      throw new Error("expected the sale to have moved to deposit-known");
    }

    // The payment is prompted only now -- not at record creation -- and only once.
    expect(seams.requestKeyPayment).toHaveBeenCalledTimes(1);
    expect(seams.requestKeyPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 21_000_000n,
        key: { address: KEY_ADDRESS, publicKeyHex: KEY_HEX },
      }),
    );
    expect(record?.payment.requestedAt).toBe(FIXTURE_NOW);

    expect(seams.sendWithdrawHandoff).toHaveBeenCalledTimes(1);
    const [, , payload] = seams.sendWithdrawHandoff.mock.calls[0]!;
    expect(payload).toMatchObject({
      rail: "meld",
      meld: {
        committedAmount: "900000000",
        providerPayoutAddress: PAYOUT_ADDRESS,
        orderRef: "5OrderRefAddressDerivedFromTheBurnerKey",
        meldFundingRequestId: "mfr-1",
        quotedFiatAmount: "156.30",
        quotedFiatCurrency: "USD",
        cryptoCurrency: "DOT_ASSETHUB",
      },
    });
    // Persisted, not just sent: a later pass reads it back rather than rebuilding it. The write
    // is coalesced like any non-critical change, so it needs a flush to land.
    await requests.flush();
    expect(await storage.read(requestKey(REF))).toContain(PAYOUT_ADDRESS);
  });

  it("still prompts the payment and hands the worker the sale while the seller is watching it — the ordinary path, not the edge case", async () => {
    // A direct or chainflip withdrawal's hand-off is excluded from this step while its record is
    // foreground, because `start()` already sent it the moment the record was created. A meld
    // withdrawal's is not: `start()` sends nothing, so this step is the ONLY thing that ever
    // prompts the payment or hands off the sale, on screen or off. A seller who opens a sale and
    // then watches their own withdrawal through KYC — which is what anyone would do — must not
    // have their CASH stranded on the burner for as long as they keep the tab open.
    const requests = useRequestsStore();
    setMeldStatusClientFactory(() => fakeMeldClient("session_opened", DEPOSIT));
    await requests.create(REF, meldWithdrawal());
    requests.setForeground(REF);

    await requests.reconcile("boot");

    expect(seams.requestKeyPayment).toHaveBeenCalledTimes(1);
    expect(seams.sendWithdrawHandoff).toHaveBeenCalledTimes(1);
    const record = requests.get(REF);
    expect(record?.payment.requestedAt).toBe(FIXTURE_NOW);
    if (record?.rail.provider === "meld" && record.rail.sale.phase === "deposit-known") {
      expect(record.rail.sale.deposit).toEqual(DEPOSIT);
    } else {
      throw new Error("expected the sale to have moved to deposit-known");
    }
  });

  it("never lets a malformed provider address reach the worker: refuses the hand-off loudly instead", async () => {
    const requests = useRequestsStore();
    const badDeposit: MeldDepositDisclosure = { ...DEPOSIT, address: "not-an-address" };
    setMeldStatusClientFactory(() => fakeMeldClient("session_opened", badDeposit));
    await requests.create(REF, meldWithdrawal());

    await requests.reconcile("boot");

    // The sale still moved to deposit-known -- the disclosure itself was well-formed -- but the
    // address does not decode, so nothing is signed against it and nothing is sent to the worker.
    const record = requests.get(REF);
    if (record?.rail.provider === "meld" && record.rail.sale.phase === "deposit-known") {
      expect(record.rail.sale.deposit.address).toBe("not-an-address");
    } else {
      throw new Error("expected the sale to have moved to deposit-known");
    }
    expect(seams.sendWithdrawHandoff).not.toHaveBeenCalled();
    expect(record?.handoff.meld).toBeUndefined();
    // Not a silent retry loop: the record fails terminally, visibly, with a reason a human (and
    // eventually a screen) can read -- an address that will not decode on the next pass either
    // does not decode on this one, so retrying resolves nothing.
    expect(record?.status.kind).toBe("failed");
    expect(record?.failure).toMatchObject({
      kind: "unknown",
      step: "payment",
      recoverable: false,
      message:
        "The payment provider gave an address we could not use. Contact support with your reference.",
    });
    expect(record?.rail.failure).toMatchObject({ code: "invalid-payout-address" });
    // Terminal now: the next pass leaves it alone rather than retrying forever.
    seams.sendWithdrawHandoff.mockClear();
    await requests.reconcile("refresh");
    expect(seams.sendWithdrawHandoff).not.toHaveBeenCalled();
  });

  it("does not un-know a deposit that stops being disclosed, and does not rebuild an already-sent meld payload", async () => {
    const requests = useRequestsStore();
    setMeldStatusClientFactory(() => fakeMeldClient("session_opened", DEPOSIT));
    await requests.create(REF, meldWithdrawal());
    await requests.reconcile("boot");
    expect(seams.sendWithdrawHandoff).toHaveBeenCalledTimes(1);
    const firstPayload = seams.sendWithdrawHandoff.mock.calls[0]![2];

    // The adapter stops disclosing the address once the request has moved on -- normal, not an
    // error -- but `deposit-known` is entered once and never left.
    setMeldStatusClientFactory(() => fakeMeldClient("transaction_seen"));
    await requests.reconcile("refresh");

    const record = requests.get(REF);
    if (record?.rail.provider === "meld" && record.rail.sale.phase === "deposit-known") {
      expect(record.rail.sale.deposit).toEqual(DEPOSIT);
    } else {
      throw new Error("expected the sale to still be deposit-known");
    }
    // The worker still has not acknowledged the job (nothing here writes one), so the reconcile's
    // hand-off step retries every pass, as it already does for direct and chainflip -- that is
    // not what this test pins. What it pins is that the meld payload itself is built once, from
    // the order ref the withdrawal's key derives, and never rebuilt on a later pass.
    expect(seams.meldOrderRefFor).toHaveBeenCalledTimes(1);
    for (const call of seams.sendWithdrawHandoff.mock.calls) {
      expect(call[2]).toMatchObject({ meld: (firstPayload as { meld: unknown }).meld });
    }
  });
});
