// The worker's side of a fiat sale, offline: the provider, the payment, the message leg and the
// funding engine are scripted; the engine's records and the rail leg between them are real. What
// this pins is the glue: a Meld hand-off must carry its exact figure and its adapter, the key pays
// that figure and only after the provider's record agrees, a payment whose answer was lost is read
// off the chain before the provider, the residue goes home through the funding engine only once
// the payment is out, a sale that ends before its provider is paid sends the whole key home, and a
// payment that cannot be confirmed stops the job with nothing sent anywhere.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  railFor: vi.fn(),
  payRail: vi.fn(),
  payRailExact: vi.fn(),
  exactPaymentOut: vi.fn(),
  status: vi.fn(),
  channel: vi.fn(),
  startFunding: vi.fn(),
  withdrawTickOnce: vi.fn(),
  keyFree: 0n,
  keyReadHangs: false,
}));

vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  getHostLocalStorage: async () => ({
    readJSON: async (key: string) => mocks.stored.get(key) ?? null,
    writeJSON: async (key: string, value: unknown) => {
      mocks.stored.set(key, JSON.parse(JSON.stringify(value)));
    },
  }),
}));

vi.mock("../worker/src/providers.js", () => ({
  PAY_TIMEOUT_MS: 300_000,
  railFor: mocks.railFor,
  payRail: mocks.payRail,
  payRailExact: mocks.payRailExact,
  exactPaymentOut: mocks.exactPaymentOut,
}));

vi.mock("../worker/src/engine.js", () => ({ startFunding: mocks.startFunding }));

// The message leg is scripted: what it does to the chain is the withdraw package's own business.
vi.mock("@getsome/withdraw", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withdrawTickOnce: mocks.withdrawTickOnce,
}));

// The residue is read off the key on Asset Hub through a client the engine opens for it.
vi.mock("../worker/src/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker/src/shared.js")>();
  return {
    ...actual,
    keypairFor: async () => ({ address: "5Key", signer: {} }),
    connectChain: async () => ({
      getBestBlocks: async () => [{ hash: "0xbest", number: 1 }],
      getTypedApi: () => ({
        query: {
          System: {
            Account: {
              getValue: () =>
                mocks.keyReadHangs
                  ? new Promise(() => {})
                  : Promise.resolve({ data: { free: mocks.keyFree }, nonce: 1 }),
            },
          },
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
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const DAY = 86_400_000;
const AMOUNT = "20000000000";
const DEPOSIT = "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM";

const channel = {
  id: "funding-sell-1",
  address: DEPOSIT,
  openedAt: NOW - 60_000,
  expiresAt: 0,
  expectedEgress: "9012",
  amount: AMOUNT,
};

/** The hand-off the page sends once the provider named its deposit address. */
const handoff = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "s-1",
  label: "wd:eph:meld-bank:1",
  keyAddress: "5Key",
  keyPublicKeyHex: hash32(0x07),
  amount: "100000000",
  destination: { chain: "Bank transfer", asset: "EUR", address: "" },
  landingHex: hash32(0x07),
  rail: "meld",
  assetHubGenesis: hash32(0x11),
  peopleGenesis: hash32(0x22),
  peopleParaId: 1004,
  assetHubParaId: 1000,
  poolAccount: "5Pool",
  slippagePct: 5,
  paymentExpiresAt: NOW + DAY,
  channel,
  meld: { baseUrl: "https://adapter.test", productId: "getcash.dev" },
  ...overrides,
});

/** A Meld job whose message leg is done: the PAS is on the key, the provider still to be paid. */
function landedJob(): StoredJob {
  return {
    v: 1,
    ...handoff(),
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
      destinationPasBefore: "0",
      expectedLanding: "21000000000",
      fundsSeenAt: NOW - DAY,
      workedMs: 0,
    },
    leg: {
      handoff: { id: channel.id, address: DEPOSIT, openedAt: channel.openedAt, expiresAt: 0 },
      paid: false,
      sweep: { attempts: 0, rejections: 0 },
      exact: { nonce: 0, inFlight: false, balanceBefore: null, attempts: 0, rejections: 0 },
      reading: null,
    },
    txs: [],
  };
}

async function engineWith(jobs: Record<string, StoredJob>): Promise<Engine> {
  mocks.stored.set(WITHDRAW_KEY, jobs);
  vi.resetModules();
  return await import("../worker/src/withdraw-engine.js");
}

const storedJob = (): StoredJob =>
  (mocks.stored.get(WITHDRAW_KEY) as Record<string, StoredJob>)["s-1"]!;

describe("the worker's side of a fiat sale", () => {
  beforeEach(() => {
    mocks.stored.clear();
    for (const fn of [
      mocks.railFor,
      mocks.payRail,
      mocks.payRailExact,
      mocks.exactPaymentOut,
      mocks.status,
      mocks.channel,
      mocks.startFunding,
      mocks.withdrawTickOnce,
    ]) {
      fn.mockReset();
    }
    mocks.channel.mockResolvedValue({
      depositAddress: DEPOSIT,
      payout: "off-chain",
      expired: false,
      expectedAmount: BigInt(AMOUNT),
    });
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.payRailExact.mockResolvedValue(undefined);
    mocks.exactPaymentOut.mockResolvedValue(false);
    mocks.status.mockResolvedValue({ status: "receiving" });
    mocks.startFunding.mockResolvedValue({ sessionId: "s-1/residue" });
    mocks.keyFree = 7_000_000_000n;
    mocks.keyReadHangs = false;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a sale's hand-off without its exact figure, or without its adapter", async () => {
    const engine = await engineWith({});
    const { amount: _dropped, ...noAmount } = channel;
    expect(await engine.startWithdraw(handoff({ channel: noAmount }))).toMatchObject({
      error: "invalid",
      reason: expect.stringMatching(/exact amount/),
    });
    expect(await engine.startWithdraw(handoff({ meld: undefined }))).toMatchObject({
      error: "invalid",
      reason: expect.stringMatching(/adapter/),
    });
    expect(await engine.startWithdraw(handoff())).toMatchObject({ sessionId: "s-1" });
    expect(storedJob()).toMatchObject({
      channel: { amount: AMOUNT },
      meld: { baseUrl: "https://adapter.test", productId: "getcash.dev" },
      leg: { exact: { nonce: 0, inFlight: false } },
    });
  });

  it("pays exactly the committed figure, once the provider's record agrees", async () => {
    const engine = await engineWith({ "s-1": landedJob() });
    await engine.tickAllWithdraw();
    expect(mocks.channel).toHaveBeenCalledWith("funding-sell-1");
    expect(mocks.payRail).not.toHaveBeenCalled();
    expect(mocks.payRailExact).toHaveBeenCalledTimes(1);
    const [, paidHandoff, paidAmount, exact] = mocks.payRailExact.mock.calls[0]!;
    expect(paidHandoff).toMatchObject({ id: "funding-sell-1", address: DEPOSIT });
    expect(paidAmount).toBe(BigInt(AMOUNT));
    expect(exact).toMatchObject({ nonce: 0 });
    expect(storedJob().leg.paid).toBe(true);
  });

  it("pays nothing when the provider expects another figure, and sends the whole key home", async () => {
    mocks.channel.mockResolvedValue({
      depositAddress: DEPOSIT,
      payout: "off-chain",
      expired: false,
      expectedAmount: BigInt(AMOUNT) + 1n,
    });
    const engine = await engineWith({ "s-1": landedJob() });
    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-mismatch" });
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });

  it("sends the residue home through the funding engine once the payment is out", async () => {
    const engine = await engineWith({ "s-1": landedJob() });
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({
      sessionId: "s-1/residue",
      label: "wd:eph:meld-bank:1",
      burnerAddress: "5Key",
      settleAmount: "10000",
      peopleParaId: 1004,
      tier: "pool",
      // Held to the bound the sale went out under, and claimed under ids the purse's payment to
      // the key never used.
      quoteFloorPct: 5,
      claimIdOffset: 1_000_000,
    });
    expect(storedJob().residue).toMatchObject({
      amount: "7000000000",
      returning: true,
      sessionId: "s-1/residue",
    });
    // Once only: the next pass follows the provider and starts nothing more.
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
  });

  it("keeps a residue too small to be worth the way back", async () => {
    mocks.keyFree = 200_000_000n;
    const engine = await engineWith({ "s-1": landedJob() });
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    expect(storedJob().residue).toEqual({ amount: "200000000", returning: false });
  });

  it("stops the job when the payment cannot be confirmed, and sends nothing home", async () => {
    const engine = await engineWith({ "s-1": landedJob() });
    const { PaymentUnresolvedError } = await import("@getsome/withdraw");
    mocks.payRailExact.mockRejectedValue(new PaymentUnresolvedError("the key moved on"));
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "unresolved", done: false });
    expect(storedJob().leg.paid).toBe(false);
    expect(mocks.startFunding).not.toHaveBeenCalled();
  });

  it("describes the residue to the page", async () => {
    const engine = await engineWith({ "s-1": landedJob() });
    await engine.tickAllWithdraw();
    expect(await engine.withdrawStatus({ sessionId: "s-1" })).toMatchObject({
      residue: { amount: "7000000000", returning: true },
    });
  });
});

/** A landed job whose payment went out and whose answer was lost. */
function inFlightJob(): StoredJob {
  const job = landedJob();
  job.leg.exact = {
    nonce: 0,
    inFlight: true,
    balanceBefore: "21000000000",
    attempts: 1,
    rejections: 0,
  };
  return job;
}

describe("a sale's payment whose answer was lost", () => {
  beforeEach(() => {
    mocks.stored.clear();
    for (const fn of [
      mocks.railFor,
      mocks.payRailExact,
      mocks.exactPaymentOut,
      mocks.status,
      mocks.channel,
      mocks.startFunding,
    ]) {
      fn.mockReset();
    }
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.exactPaymentOut.mockResolvedValue(false);
    mocks.status.mockResolvedValue({ status: "receiving" });
    mocks.startFunding.mockResolvedValue({ sessionId: "s-1/residue" });
    mocks.keyFree = 1_000_000_000n;
    mocks.keyReadHangs = false;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is read off the chain before the adapter, which has closed the order it filled", async () => {
    // The provider saw the funds and concluded the order, so the adapter no longer discloses it.
    mocks.channel.mockResolvedValue(null);
    mocks.exactPaymentOut.mockResolvedValue(true);
    const engine = await engineWith({ "s-1": inFlightJob() });
    await engine.tickAllWithdraw();
    const [, amount, exact] = mocks.exactPaymentOut.mock.calls[0]!;
    expect(amount).toBe(BigInt(AMOUNT));
    expect(exact).toMatchObject({ nonce: 0, inFlight: true });
    expect(mocks.channel).not.toHaveBeenCalled();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "handoff", leg: { paid: true } });
    expect(storedJob().failure).toBeUndefined();
    // Paid, so what is left goes home as a residue, not as the whole key.
    expect(storedJob().residue).toMatchObject({ amount: "1000000000", returning: true });
  });

  it("stops for a human, sending nothing anywhere, when the provider refuses meanwhile", async () => {
    // The chain does not show the attempt yet, and it may still land: the refusal proves nothing.
    mocks.channel.mockResolvedValue({
      depositAddress: DEPOSIT,
      payout: "off-chain",
      expired: true,
      expectedAmount: BigInt(AMOUNT),
    });
    const engine = await engineWith({ "s-1": inFlightJob() });
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "unresolved" });
    expect(storedJob().lastError).toMatch(/may still be in flight/);
    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    expect(storedJob().residue).toBeUndefined();
  });
});

describe("a sale that ends before its provider is paid", () => {
  beforeEach(() => {
    mocks.stored.clear();
    for (const fn of [
      mocks.railFor,
      mocks.payRailExact,
      mocks.exactPaymentOut,
      mocks.status,
      mocks.channel,
      mocks.startFunding,
      mocks.withdrawTickOnce,
    ]) {
      fn.mockReset();
    }
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.exactPaymentOut.mockResolvedValue(false);
    mocks.startFunding.mockResolvedValue({ sessionId: "s-1/residue" });
    mocks.keyFree = 21_000_000_000n;
    mocks.keyReadHangs = false;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const closed = {
    depositAddress: DEPOSIT,
    payout: "off-chain",
    expired: true,
    expectedAmount: BigInt(AMOUNT),
  };

  it("sends the whole key home when the provider closed the order, and never pays it after", async () => {
    mocks.channel.mockResolvedValue(closed);
    const job = landedJob();
    job.state.submittedSlippagePct = 1.25;
    const engine = await engineWith({ "s-1": job });
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-expired" });
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({
      sessionId: "s-1/residue",
      settleAmount: "10000",
      tier: "pool",
      quoteFloorPct: 1.25,
      claimIdOffset: 1_000_000,
    });
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
    expect(storedJob().residue.amount).toBeUndefined();

    // A re-sent hand-off does not re-arm it, even once the provider's record looks right again.
    mocks.channel.mockResolvedValue({ ...closed, expired: false });
    await engine.startWithdraw(handoff());
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-expired" });
    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
  });

  it("sends the whole key home when the order no longer matches the sale", async () => {
    mocks.channel.mockResolvedValue(null);
    const engine = await engineWith({ "s-1": landedJob() });
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-mismatch" });
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });

  it("sends the CASH home when the price moved past the promise before anything left People", async () => {
    const job = landedJob();
    Object.assign(job, { landed: false, phase: "convert" });
    const engine = await engineWith({ "s-1": job });
    // The class of the module the engine was loaded with.
    const { CommitmentUnfundableError } = await import("@getsome/withdraw");
    mocks.withdrawTickOnce.mockRejectedValue(new CommitmentUnfundableError(1n, 2n));
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "unfundable" });
    // No submitted bound to hold the way back to, so the hand-off's ceiling.
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({ quoteFloorPct: 5 });
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });

  it("tries the way home again on a later pass until it starts, the job done or not", async () => {
    // Paid on the first pass, and the residue's job could not be registered.
    mocks.channel.mockResolvedValue({ ...closed, expired: false });
    mocks.payRailExact.mockResolvedValue(undefined);
    mocks.startFunding.mockResolvedValueOnce({ error: "invalid", reason: "storage down" });
    const engine = await engineWith({ "s-1": landedJob() });
    await engine.tickAllWithdraw();
    expect(storedJob().leg.paid).toBe(true);
    expect(storedJob().residue).toBeUndefined();
    expect(storedJob().residueError).toMatch(/storage down/);

    // The provider settles on the next pass: the job is done and ticked no more, but the key
    // still goes home.
    mocks.status.mockResolvedValue({ status: "complete" });
    mocks.startFunding.mockRejectedValueOnce(new Error("still down"));
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ done: true, phase: "done" });
    expect(storedJob().residueError).toMatch(/still down/);
    await engine.tickAllWithdraw();
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(storedJob().residue).toMatchObject({ amount: "21000000000", returning: true });
    expect(storedJob().residueError).toBeUndefined();
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(3);
  });

  it("gives up a residue read that hangs, and tries it again", async () => {
    mocks.channel.mockResolvedValue({ ...closed, expired: false });
    mocks.payRailExact.mockResolvedValue(undefined);
    mocks.keyReadHangs = true;
    const engine = await engineWith({ "s-1": landedJob() });
    const pass = engine.tickAllWithdraw();
    await vi.advanceTimersByTimeAsync(30_000);
    await pass;
    expect(storedJob().leg.paid).toBe(true);
    expect(storedJob().residueError).toMatch(/residue read timed out/);
    expect(mocks.startFunding).not.toHaveBeenCalled();
    mocks.keyReadHangs = false;
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toMatchObject({ returning: true });
  });
});
