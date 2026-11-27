// The worker's rail leg, offline: the provider and the hand that pays it are scripted, the leg
// itself and the records are real. What this pins is the glue the leg's own tests cannot see:
// which failure the engine writes when the provider's channel has closed, and that nothing is
// paid on the way there.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  railFor: vi.fn(),
  payRailExact: vi.fn(),
  exactPaymentOut: vi.fn(),
  paymentOutcome: vi.fn(),
  status: vi.fn(),
  channel: vi.fn(),
}));

vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  getHostLocalStorage: async () => ({
    readJSON: async (key: string) => mocks.stored.get(key) ?? null,
    writeJSON: async (key: string, value: unknown) => {
      // Snapshot, as real storage does.
      mocks.stored.set(key, JSON.parse(JSON.stringify(value)));
    },
  }),
}));

// The provider and the payment are the seams; the leg between them is the code under test.
vi.mock("../worker/src/providers.js", () => ({
  PAY_TIMEOUT_MS: 300_000,
  railFor: mocks.railFor,
  payRailExact: mocks.payRailExact,
  exactPaymentOut: mocks.exactPaymentOut,
  paymentOutcome: mocks.paymentOutcome,
}));

// What a sale leaves on its key is read off the chain once the leg is over; here the key holds
// nothing, on Asset Hub or on People, so no way home starts.
vi.mock("../worker/src/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker/src/shared.js")>();
  return {
    ...actual,
    keypairFor: async () => ({ address: "5Key", signer: {} }),
    connectChain: async () => ({
      getBestBlocks: async () => [{ hash: "0xbest", number: 1 }],
      getTypedApi: () => ({
        query: {
          Assets: { Account: { getValue: async () => ({ balance: 0n }) } },
          System: { Account: { getValue: async () => ({ data: { free: 0n }, nonce: 1 }) } },
        },
      }),
      destroy: () => {},
    }),
  };
});

vi.mock("@polkadot-api/descriptors", () => ({
  paseo_next_v2: { fake: "asset-hub" },
  paseo_people_next: { fake: "people" },
}));

vi.mock("@getsome/people", () => ({ CASH_LOCATION: { fake: "cash" } }));

type Engine = typeof import("../worker/src/withdraw-engine.js");
type StoredJob = Record<string, any>;

const WITHDRAW_KEY = "getsome.withdraw.jobs";
const hash32 = (fill: number) => `0x${fill.toString(16).padStart(2, "0").repeat(32)}`;
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const DAY = 86_400_000;
/** The exact figure the sale committed to pay its provider, planck. */
const AMOUNT = "20000000000";

/** The provider's own record of the channel, as it agrees with the job. */
const AGREEING = {
  depositAddress: "5Channel",
  payout: "off-chain",
  expired: false,
  expectedAmount: BigInt(AMOUNT),
};

/** A sale whose message leg is done: the PAS it sold is on the key, the channel is still to be
 *  paid. */
function landedJob(overrides: { leg?: unknown } = {}): StoredJob {
  return {
    v: 1,
    sessionId: "s-1",
    label: "wd:eph:meld-bank:1",
    keyAddress: "5Key",
    keyPublicKeyHex: hash32(0x07),
    amount: "21000000",
    destination: { chain: "Bank transfer", asset: "EUR", address: "" },
    landingHex: hash32(0x07),
    rail: "meld",
    tier: "pool",
    assetHubGenesis: hash32(0x11),
    peopleGenesis: hash32(0x22),
    peopleParaId: 1004,
    assetHubParaId: 1000,
    poolAccount: "5Pool",
    slippagePct: 5,
    paymentExpiresAt: NOW + DAY,
    channel: {
      id: "ch-1",
      address: "5Channel",
      openedAt: NOW - DAY,
      expiresAt: NOW + DAY,
      expectedEgress: "2420",
      amount: AMOUNT,
    },
    meld: { baseUrl: "https://adapter.test", productId: "getcash.dev" },
    phase: "handoff",
    landed: true,
    done: false,
    createdAt: NOW - DAY,
    armedAt: NOW - DAY,
    lastTickAt: null,
    state: {
      attempts: 1,
      rejections: 0,
      submitted: true,
      destinationBefore: "0",
      expectedLanding: "40000000000",
      fundsSeenAt: NOW - DAY,
      workedMs: 0,
    },
    leg:
      overrides.leg === undefined
        ? {
            handoff: { id: "ch-1", address: "5Channel", openedAt: NOW - DAY, expiresAt: NOW + DAY },
            paid: false,
            exact: { nonce: 0, inFlight: false, balanceBefore: null, rejections: 0 },
            reading: null,
          }
        : overrides.leg,
    txs: [],
  };
}

/** Fresh engine module (its job map cache resets), over the same stored jobs. */
async function engineWith(job: StoredJob): Promise<Engine> {
  mocks.stored.set(WITHDRAW_KEY, { "s-1": job });
  vi.resetModules();
  return await import("../worker/src/withdraw-engine.js");
}

const storedJob = (): StoredJob =>
  (mocks.stored.get(WITHDRAW_KEY) as Record<string, StoredJob>)["s-1"]!;

describe("the worker's rail leg", () => {
  beforeEach(() => {
    mocks.stored.clear();
    for (const fn of [
      mocks.railFor,
      mocks.payRailExact,
      mocks.exactPaymentOut,
      mocks.paymentOutcome,
      mocks.status,
      mocks.channel,
    ]) {
      fn.mockReset();
    }
    // The provider's record of the channel agrees with the job unless a test says otherwise.
    mocks.channel.mockResolvedValue(AGREEING);
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.payRailExact.mockResolvedValue(undefined);
    // No earlier attempt of the payment is out.
    mocks.exactPaymentOut.mockResolvedValue(false);
    mocks.status.mockResolvedValue({ status: "receiving" });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pays a channel that is open, and follows the sale after it", async () => {
    const engine = await engineWith(landedJob());
    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).toHaveBeenCalledTimes(1);
    expect(storedJob()).toMatchObject({ phase: "handoff", leg: { paid: true } });

    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).toHaveBeenCalledTimes(1); // never paid twice
    expect(storedJob()).toMatchObject({
      phase: "follow",
      leg: { reading: { status: "receiving" } },
    });
  });

  it("refuses a closed channel, pays nothing, and fails the job", async () => {
    const job = landedJob();
    job.leg.handoff.expiresAt = NOW - 1;
    job.channel.expiresAt = NOW - 1;
    const engine = await engineWith(job);

    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    const stored = storedJob();
    expect(stored).toMatchObject({ phase: "failed", failure: "channel-expired" });
    expect(stored.lastError).toMatch(/channel ch-1 closes at/);
    // Nothing moved, so the leg is still unpaid.
    expect(stored.leg.paid).toBe(false);
    expect(stored.txs).toEqual([]);
  });

  it("holds a job to the record's channel when its leg was stored without an expiry", async () => {
    // A job written before the leg carried the expiry: the record still knows it.
    const job = landedJob({
      leg: {
        handoff: { id: "ch-1", address: "5Channel", openedAt: NOW - DAY },
        paid: false,
        exact: { nonce: 0, inFlight: false, balanceBefore: null, rejections: 0 },
        reading: null,
      },
    });
    job.channel.expiresAt = NOW - 1;
    const engine = await engineWith(job);

    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-expired" });
  });

  it("pays a job whose channel named no expiry at all", async () => {
    const job = landedJob();
    job.leg.handoff.expiresAt = 0;
    job.channel.expiresAt = 0;
    const engine = await engineWith(job);

    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).toHaveBeenCalledTimes(1);
    expect(storedJob().phase).toBe("handoff");
    expect(storedJob().failure).toBeUndefined();
  });

  it("refuses when the provider's record of the channel disagrees, and pays nothing", async () => {
    mocks.channel.mockResolvedValue({ ...AGREEING, depositAddress: "5SomewhereElse" });
    const engine = await engineWith(landedJob());

    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    const stored = storedJob();
    expect(stored).toMatchObject({ phase: "failed", failure: "channel-mismatch" });
    expect(stored.lastError).toMatch(/takes deposits at 5SomewhereElse/);
    expect(stored.leg.paid).toBe(false);
    expect(stored.txs).toEqual([]);
  });

  it("checks the payout the provider holds the sale to, not just the address it is about to pay", async () => {
    for (const [record, reason] of [
      // The address agrees, for a payout on chain.
      [{ depositAddress: "5Channel", expired: false }, /pays out on chain/],
      // The address agrees, for another figure.
      [{ ...AGREEING, expectedAmount: BigInt(AMOUNT) + 1n }, /expects 20000000001/],
    ] as const) {
      mocks.channel.mockResolvedValue(record);
      const engine = await engineWith(landedJob());

      await engine.tickAllWithdraw();
      expect(mocks.payRailExact).not.toHaveBeenCalled();
      expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-mismatch" });
      expect(storedJob().lastError).toMatch(reason);
    }
  });

  it("keeps a job whose provider cannot be reached for the next tick, unpaid", async () => {
    mocks.channel.mockRejectedValue(new Error("provider unreachable"));
    const engine = await engineWith(landedJob());

    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    const stored = storedJob();
    // Transient: the job is still live and the next tick asks again.
    expect(stored.phase).toBe("handoff");
    expect(stored.failure).toBeUndefined();
    expect(stored.lastError).toMatch(/provider unreachable/);
  });

  it("clears the error a transient tick left once a tick completes", async () => {
    mocks.channel.mockRejectedValueOnce(new Error("provider unreachable"));
    const engine = await engineWith(landedJob());

    await engine.tickAllWithdraw();
    expect(storedJob().lastError).toMatch(/provider unreachable/);
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "handoff", leg: { paid: true } });
    expect(storedJob().lastError).toBeUndefined();
  });
});
