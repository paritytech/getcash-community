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
  fundingStatus: vi.fn(),
  withdrawTickOnce: vi.fn(),
  chooseRoute: vi.fn(),
  submits: [] as { args: unknown; options: unknown }[],
  keyFree: 0n,
  keyCash: 0n,
  /** The key's holding of the sale's token on Asset Hub, when the sale landed a stable. */
  keyToken: 0n,
  keyReadHangs: false,
}));

vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  getHostLocalStorage: async () => ({
    // A copy, as the host's storage reads back: what the worker holds in memory is not stored
    // until it writes it.
    readJSON: async (key: string) => {
      const value = mocks.stored.get(key);
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
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

vi.mock("../worker/src/engine.js", () => ({
  CLAIM_UNIT: 10_000n,
  startFunding: mocks.startFunding,
  fundingStatus: mocks.fundingStatus,
}));

// The message leg is scripted: what it does to the chain is the withdraw package's own business.
vi.mock("@getsome/withdraw", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withdrawTickOnce: mocks.withdrawTickOnce,
}));

// How the CASH moves to Asset Hub is the chains' answer, and the scripted leg does not read it;
// the route a stable residue takes home is the PSM's answer, scripted here.
vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chooseCashTransfer: async () => "teleport",
  chooseRoute: mocks.chooseRoute,
}));

// The residue is read off the key on Asset Hub through a client the engine opens for it: the
// native from the account, a stable from its pallet-assets holding; the CASH on People from its
// holding under the CASH location. The real hand that pays submits through the same client.
vi.mock("../worker/src/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker/src/shared.js")>();
  return {
    ...actual,
    keypairFor: async () => ({ address: "5Key", signer: {} }),
    connectChain: async () => ({
      getBestBlocks: async () => [{ hash: "0xbest", number: 1 }],
      getTypedApi: () => ({
        tx: {
          Assets: {
            transfer_keep_alive: (args: unknown) => ({
              decodedCall: { transfer: args },
              signAndSubmit: async (_signer: unknown, options: unknown) => {
                mocks.submits.push({ args, options });
                return { ok: true, txHash: "0xpaid", block: { number: 2 } };
              },
            }),
          },
        },
        apis: {
          DryRunApi: {
            dry_run_call: async () => ({
              success: true,
              value: { execution_result: { success: true } },
            }),
          },
        },
        query: {
          Assets: {
            Account: {
              getValue: (id: unknown) =>
                Promise.resolve({
                  balance: typeof id === "number" ? mocks.keyToken : mocks.keyCash,
                }),
            },
          },
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
  tier: "pool",
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
      exact: { nonce: 0, inFlight: false, balanceBefore: null, rejections: 0 },
      reading: null,
    },
    txs: [],
  };
}

// The funding job carrying a key home, as the worker reads it back: running, unless a test says not.
beforeEach(() => {
  mocks.fundingStatus.mockReset();
  mocks.fundingStatus.mockResolvedValue({ phase: "convert", claim: null });
});

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

  it("holds, sending nothing anywhere, while the provider refuses and the attempt may still land", async () => {
    // The chain does not show the attempt yet, and it may still land: the refusal proves nothing.
    mocks.channel.mockResolvedValue({
      depositAddress: DEPOSIT,
      payout: "off-chain",
      expired: true,
      expectedAmount: BigInt(AMOUNT),
    });
    const engine = await engineWith({ "s-1": inFlightJob() });
    await engine.tickAllWithdraw();
    expect(storedJob().phase).toBe("handoff");
    expect(storedJob().failure).toBeUndefined();
    expect(storedJob().lastError).toMatch(/may still land/);
    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    expect(storedJob().residue).toBeUndefined();
  });

  it("lets the refusal stand once the attempt has outlived its mortality unlanded", async () => {
    mocks.channel.mockResolvedValue({
      depositAddress: DEPOSIT,
      payout: "off-chain",
      expired: true,
      expectedAmount: BigInt(AMOUNT),
    });
    const engine = await engineWith({ "s-1": inFlightJob() });
    await engine.tickAllWithdraw();
    // The chain is now past the attempt's era with the nonce unmoved: it can never land.
    mocks.exactPaymentOut.mockImplementation(
      async (_record: unknown, _amount: unknown, exact: { inFlight: boolean }) => {
        exact.inFlight = false;
        return false;
      },
    );
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-expired" });
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });

  it("carries on as paid when the held attempt lands after all", async () => {
    mocks.channel.mockResolvedValue({
      depositAddress: DEPOSIT,
      payout: "off-chain",
      expired: true,
      expectedAmount: BigInt(AMOUNT),
    });
    const engine = await engineWith({ "s-1": inFlightJob() });
    await engine.tickAllWithdraw();
    mocks.exactPaymentOut.mockResolvedValue(true);
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "handoff", leg: { paid: true } });
    expect(storedJob().residue).toMatchObject({ returning: true });
    expect(storedJob().residue.whole).toBeUndefined();
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
    const engine = await engineWith({ "s-1": landedJob() });
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-expired" });
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({
      sessionId: "s-1/residue",
      settleAmount: "10000",
      tier: "pool",
      // Held to the floor the sale itself went out under, the hand-off's.
      quoteFloorPct: 5,
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
    // Held to the hand-off's floor, as every way home is.
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({ quoteFloorPct: 5 });
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });

  it("tries the way home again on a later pass until it starts, the job done or not", async () => {
    // Paid on the first pass, and the residue's job could not be registered.
    mocks.channel.mockResolvedValue({ ...closed, expired: false });
    mocks.payRailExact.mockResolvedValue(undefined);
    mocks.startFunding.mockResolvedValueOnce({ error: "invalid", reason: "storage down" });
    mocks.fundingStatus.mockResolvedValue({ sessionId: "s-1/residue", known: false });
    const engine = await engineWith({ "s-1": landedJob() });
    await engine.tickAllWithdraw();
    expect(storedJob().leg.paid).toBe(true);
    // The way home is on the job, though its funding job is not there yet.
    expect(storedJob().residue).toMatchObject({
      amount: "21000000000",
      returning: true,
      sessionId: "s-1/residue",
    });
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
    expect(storedJob().residueError).toBeUndefined();
    // A first start is not a restart: the way home keeps all its retries.
    expect(storedJob().residue.rearms).toBeUndefined();
    expect(mocks.startFunding).toHaveBeenCalledTimes(3);
    mocks.fundingStatus.mockResolvedValue({ phase: "convert", claim: null });
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(3);
  });

  it("stores the way home before its funding job starts, so a worker stopped between follows it", async () => {
    mocks.channel.mockResolvedValue(closed);
    let atStart: StoredJob | undefined;
    mocks.startFunding.mockImplementation(async () => {
      atStart = JSON.parse(JSON.stringify(storedJob()));
      return { sessionId: "s-1/residue" };
    });
    const engine = await engineWith({ "s-1": landedJob() });
    await engine.tickAllWithdraw();
    // What a worker stopped inside the start would load: the sale over, its way home open.
    expect(atStart).toMatchObject({
      phase: "failed",
      failure: "channel-expired",
      residue: { whole: true, returning: true, sessionId: "s-1/residue" },
    });

    // Loaded again from that, with the funding job running: nothing is started or read twice.
    mocks.startFunding.mockClear();
    const reloaded = await engineWith({ "s-1": atStart! });
    await reloaded.tickAllWithdraw();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
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

describe("a sale's time to pay its provider", () => {
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
    mocks.channel.mockResolvedValue({
      depositAddress: DEPOSIT,
      payout: "off-chain",
      expired: false,
      expectedAmount: BigInt(AMOUNT),
    });
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

  /** A landed job whose channel the provider must be paid by `expiresAt`. */
  const dueBy = (expiresAt: number): StoredJob => {
    const job = landedJob();
    job.channel = { ...job.channel, expiresAt };
    job.leg.handoff = { ...job.leg.handoff, expiresAt };
    return job;
  };

  it("pays nothing once the sale's time is up, and sends the whole key home", async () => {
    // Meld names no expiry for the order: a worker that resumes late must not pay an order the
    // provider may have dropped.
    const engine = await engineWith({ "s-1": dueBy(NOW + 60_000) });
    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-expired" });
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });

  it("pays inside the sale's time", async () => {
    const engine = await engineWith({ "s-1": dueBy(NOW + 3_600_000) });
    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).toHaveBeenCalledTimes(1);
  });

  it("takes a later deadline from a re-sent hand-off for the same order, never an earlier one", async () => {
    const engine = await engineWith({ "s-1": dueBy(NOW + 600_000) });
    const later = NOW + 3_600_000;
    await engine.startWithdraw(handoff({ channel: { ...channel, expiresAt: later } }));
    expect(storedJob().leg.handoff.expiresAt).toBe(later);
    expect(storedJob().channel.expiresAt).toBe(later);
    await engine.startWithdraw(handoff({ channel: { ...channel, expiresAt: NOW + 60_000 } }));
    expect(storedJob().leg.handoff.expiresAt).toBe(later);
  });

  it("keeps a sale's one order and its payment's state when a hand-off names another", async () => {
    const job = inFlightJob();
    const engine = await engineWith({ "s-1": job });
    await engine.startWithdraw(handoff({ channel: { ...channel, id: "funding-sell-2" } }));
    expect(storedJob().leg.handoff.id).toBe("funding-sell-1");
    expect(storedJob().leg.exact).toMatchObject({ nonce: 0, inFlight: true });
  });

  it("does not re-arm a payment that could not be confirmed on a re-sent hand-off", async () => {
    const job = inFlightJob();
    Object.assign(job, { phase: "failed", failure: "unresolved", lastError: "the key moved on" });
    const engine = await engineWith({ "s-1": job });
    await engine.startWithdraw(handoff());
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "unresolved" });
    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(mocks.startFunding).not.toHaveBeenCalled();
  });
});

describe("a sale's way to the provider and back", () => {
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
    mocks.channel.mockResolvedValue({
      depositAddress: DEPOSIT,
      payout: "off-chain",
      expired: false,
      expectedAmount: BigInt(AMOUNT),
    });
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.exactPaymentOut.mockResolvedValue(false);
    mocks.status.mockResolvedValue({ status: "receiving" });
    mocks.startFunding.mockResolvedValue({ sessionId: "s-1/residue" });
    mocks.keyFree = 21_000_000_000n;
    mocks.keyReadHangs = false;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@getsome/core");
  });

  /** A job whose CASH is on the key, not yet sold, due to pay its provider by `expiresAt`. */
  const unsold = (expiresAt: number): StoredJob => {
    const job = landedJob();
    Object.assign(job, { landed: false, phase: "convert" });
    job.state.submitted = false;
    job.channel = { ...job.channel, expiresAt };
    job.leg.handoff = { ...job.leg.handoff, expiresAt };
    return job;
  };

  it("does not sell a sale whose time is up, and sends its CASH home as it is", async () => {
    const engine = await engineWith({ "s-1": unsold(NOW + 60_000) });
    await engine.tickAllWithdraw();
    expect(mocks.withdrawTickOnce).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-expired" });
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });

  it("lets a sale already submitted finish its message, whatever the clock says", async () => {
    const job = unsold(NOW + 60_000);
    job.state.submitted = true;
    mocks.withdrawTickOnce.mockResolvedValue({ step: "deliver" });
    const engine = await engineWith({ "s-1": job });
    await engine.tickAllWithdraw();
    expect(mocks.withdrawTickOnce).toHaveBeenCalledTimes(1);
  });

  it("hands the message leg the chains' way to move the CASH and the payment's floor", async () => {
    mocks.withdrawTickOnce.mockResolvedValue({ step: "deliver" });
    const engine = await engineWith({ "s-1": unsold(NOW + 3_600_000) });
    await engine.tickAllWithdraw();
    expect(mocks.withdrawTickOnce.mock.calls[0]![0]).toMatchObject({
      transfer: "teleport",
      minLanding: expect.any(Function),
    });
  });

  it("does not call a sale unfundable while an earlier submit may still land", async () => {
    const job = unsold(NOW + 3_600_000);
    job.submitting = { call: "withdraw", at: NOW - 60_000 };
    const engine = await engineWith({ "s-1": job });
    const { CommitmentUnfundableError } = await import("@getsome/withdraw");
    mocks.withdrawTickOnce.mockRejectedValue(new CommitmentUnfundableError(1n, 2n));
    await engine.tickAllWithdraw();
    expect(storedJob().failure).toBeUndefined();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    // Past the submit's mortality nothing more can land: the CASH goes home.
    vi.setSystemTime(NOW + 600_000);
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "unfundable" });
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
  });

  it("starts the way home again when its funding job failed, then leaves it stuck for a person", async () => {
    const engine = await engineWith({ "s-1": landedJob() });
    mocks.payRailExact.mockResolvedValue(undefined);
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    mocks.fundingStatus.mockResolvedValue({ phase: "failed", failure: "timeout", claim: null });
    for (let pass = 1; pass <= 3; pass += 1) {
      await engine.tickAllWithdraw();
      expect(mocks.startFunding).toHaveBeenCalledTimes(1 + pass);
      expect(storedJob().residue.rearms).toBe(pass);
    }
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(4);
    expect(storedJob().residue.stuck).toBe(true);
  });

  it("notes the way home over once its funding job claimed the funds, and reads it no more", async () => {
    const engine = await engineWith({ "s-1": landedJob() });
    mocks.payRailExact.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({ status: "complete" });
    await engine.tickAllWithdraw();
    await engine.tickAllWithdraw();
    mocks.fundingStatus.mockResolvedValue({ phase: "done", claim: { phase: "claimed" } });
    await engine.tickAllWithdraw();
    expect(storedJob().residue.returned).toBe(true);
    const reads = mocks.fundingStatus.mock.calls.length;
    await engine.tickAllWithdraw();
    expect(mocks.fundingStatus.mock.calls.length).toBe(reads);
  });

  it("sends the whole key home when this build cannot read the sale", async () => {
    mocks.railFor.mockReturnValue(null);
    const engine = await engineWith({ "s-1": landedJob() });
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "no-rail" });
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });

  it("keeps a later deadline a re-sent hand-off brings while a rail tick is reading the provider", async () => {
    const job = landedJob();
    job.leg.handoff = { ...job.leg.handoff, expiresAt: NOW + 1_800_000 };
    const engine = await engineWith({ "s-1": job });
    let release: (value: unknown) => void = () => {};
    mocks.channel.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    mocks.payRailExact.mockResolvedValue(undefined);
    const pass = engine.tickAllWithdraw();
    await vi.waitFor(() => expect(mocks.channel).toHaveBeenCalled());
    const later = NOW + 3_600_000;
    await engine.startWithdraw(handoff({ channel: { ...channel, expiresAt: later } }));
    release({
      depositAddress: DEPOSIT,
      payout: "off-chain",
      expired: false,
      expectedAmount: BigInt(AMOUNT),
    });
    await pass;
    expect(storedJob().leg.handoff.expiresAt).toBe(later);
  });

  it("refuses the stand-in sale's hand-off on a live network", async () => {
    vi.doMock("@getsome/core", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@getsome/core")>();
      return { ...actual, NETWORK: { ...actual.NETWORK, testnet: false } };
    });
    const engine = await engineWith({});
    expect(await engine.startWithdraw(handoff({ meld: { offline: true } }))).toMatchObject({
      error: "invalid",
      reason: expect.stringMatching(/test network/),
    });
  });
});

describe("a sale that fails before its provider is paid", () => {
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
    mocks.keyCash = 0n;
    mocks.keyReadHangs = false;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@getsome/core");
  });

  /** A sale's job the worker failed with `failure`, its funds on the key and nothing paid. */
  const failedWith = (failure: string): StoredJob => ({ ...landedJob(), phase: "failed", failure });

  it("sends the whole key home after any failure but a missed payment, a cancel or an unconfirmed one", async () => {
    for (const failure of [
      "rejected",
      "timeout",
      "no-rail",
      "rail-failed",
      "channel-expired",
      "unfundable",
    ]) {
      mocks.startFunding.mockClear();
      const engine = await engineWith({ "s-1": failedWith(failure) });
      await engine.tickAllWithdraw();
      expect(mocks.startFunding, failure).toHaveBeenCalledTimes(1);
      expect(storedJob().residue, failure).toMatchObject({ whole: true, returning: true });
    }
    for (const failure of ["expired", "cancelled", "unresolved"]) {
      mocks.startFunding.mockClear();
      const engine = await engineWith({ "s-1": failedWith(failure) });
      await engine.tickAllWithdraw();
      expect(mocks.startFunding, failure).not.toHaveBeenCalled();
      expect(storedJob().residue, failure).toBeUndefined();
    }
  });

  it("starts no way home for a key that holds nothing", async () => {
    mocks.keyFree = 0n;
    mocks.keyCash = 0n;
    const engine = await engineWith({ "s-1": failedWith("rejected") });
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    expect(storedJob().residue).toEqual({ whole: true, returning: false });
  });

  it("sends the CASH home from People when nothing reached Asset Hub", async () => {
    mocks.keyFree = 0n;
    mocks.keyCash = 99_000_000n;
    const engine = await engineWith({ "s-1": failedWith("rejected") });
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });

  it("keeps a sale off the fifteen-minute clock once its PAS has landed", async () => {
    // The adapter is not answering; the sale is held to its own deadline, not to worker time.
    mocks.channel.mockRejectedValue(new Error("adapter down"));
    const job = landedJob();
    job.state.workedMs = 3_600_000;
    job.lastTickAt = NOW - 1_000;
    const engine = await engineWith({ "s-1": job });
    await engine.tickAllWithdraw();
    expect(storedJob().phase).not.toBe("failed");
    expect(storedJob().state.workedMs).toBe(3_600_000);
  });

  it("still times a sale out before its PAS has landed, and sends its funds home", async () => {
    const job = landedJob();
    Object.assign(job, { landed: false, phase: "convert" });
    job.state.workedMs = 3_600_000;
    mocks.withdrawTickOnce.mockResolvedValue({ step: "deliver" });
    const engine = await engineWith({ "s-1": job });
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout" });
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
  });

  it("refuses a sale with a real adapter where the build does not sell for fiat", async () => {
    vi.doMock("@getsome/core", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@getsome/core")>();
      return { ...actual, NETWORK: { ...actual.NETWORK, testnet: false } };
    });
    const engine = await engineWith({});
    expect(await engine.startWithdraw(handoff())).toMatchObject({
      error: "invalid",
      reason: expect.stringMatching(/not open on this network/),
    });
  });
});

describe("a failed sale whose payment may still land", () => {
  beforeEach(() => {
    mocks.stored.clear();
    for (const fn of [mocks.railFor, mocks.exactPaymentOut, mocks.startFunding]) fn.mockReset();
    mocks.startFunding.mockResolvedValue({ sessionId: "s-1/residue" });
    mocks.keyFree = 7_000_000_000n;
    mocks.keyCash = 0n;
    mocks.keyReadHangs = false;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Failed while its payment was in flight: nothing knows yet whether the provider was paid. */
  const inFlight = (): StoredJob => {
    const job = { ...landedJob(), phase: "failed", failure: "no-rail" };
    job.leg = {
      ...job.leg,
      exact: { ...job.leg.exact, inFlight: true, balanceBefore: "28000000000" },
    };
    return job;
  };

  it("takes a payment the chain shows landed as paid, and sends only what is left home", async () => {
    mocks.exactPaymentOut.mockResolvedValue(true);
    const engine = await engineWith({ "s-1": inFlight() });
    await engine.tickAllWithdraw();
    expect(storedJob().leg.paid).toBe(true);
    expect(storedJob().residue).toMatchObject({ amount: "7000000000", returning: true });
  });

  it("sends the whole key home once the attempt outlived its mortality unlanded", async () => {
    mocks.exactPaymentOut.mockImplementation(async (_record, _amount, exact) => {
      exact.inFlight = false;
      return false;
    });
    const engine = await engineWith({ "s-1": inFlight() });
    await engine.tickAllWithdraw();
    expect(storedJob().leg.paid).toBe(false);
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });

  it("waits while the attempt may still land, sending nothing", async () => {
    const engine = await engineWith({ "s-1": inFlight() });
    await engine.tickAllWithdraw();
    expect(mocks.exactPaymentOut).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding).not.toHaveBeenCalled();
    expect(storedJob().residue).toBeUndefined();
  });

  it("stops for a person when the chain contradicts the payment", async () => {
    const { PaymentUnresolvedError } = await import("@getsome/withdraw");
    mocks.exactPaymentOut.mockRejectedValue(
      new PaymentUnresolvedError("nonce moved, balance did not"),
    );
    const engine = await engineWith({ "s-1": inFlight() });
    await engine.tickAllWithdraw();
    expect(storedJob().failure).toBe("unresolved");
    expect(mocks.startFunding).not.toHaveBeenCalled();
  });
});

describe("a sale on the PSM tier, in USDT", () => {
  const USDT_AMOUNT = 20_000_000n;
  const psmJob = (): StoredJob => ({
    ...landedJob(),
    tier: "psm",
    external: "USDT",
    feeRate: 5_000,
    channel: { ...channel, amount: USDT_AMOUNT.toString() },
  });

  beforeEach(() => {
    mocks.stored.clear();
    for (const fn of [
      mocks.railFor,
      mocks.payRailExact,
      mocks.exactPaymentOut,
      mocks.status,
      mocks.channel,
      mocks.startFunding,
      mocks.chooseRoute,
    ]) {
      fn.mockReset();
    }
    mocks.submits.length = 0;
    mocks.channel.mockResolvedValue({
      depositAddress: DEPOSIT,
      payout: "off-chain",
      expired: false,
      expectedAmount: USDT_AMOUNT,
    });
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.payRailExact.mockResolvedValue(undefined);
    mocks.exactPaymentOut.mockResolvedValue(false);
    mocks.status.mockResolvedValue({ status: "receiving" });
    mocks.startFunding.mockResolvedValue({ sessionId: "s-1/residue" });
    mocks.chooseRoute.mockResolvedValue({ tier: "psm", external: "USDT", feeRate: 5_000 });
    mocks.keyFree = 0n;
    mocks.keyToken = 27_000_000n;
    mocks.keyReadHangs = false;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pays the exact USDT figure through pallet-assets, the fee charged in USDT", async () => {
    const { TOKENS } = await import("@getsome/core");
    const providers = await vi.importActual<typeof import("../worker/src/providers.js")>(
      "../worker/src/providers.js",
    );
    const job = psmJob();
    // The key's first signature on Asset Hub, as the scripted account reports its nonce.
    const exact = { nonce: 1, inFlight: false, balanceBefore: null, anchor: null, rejections: 0 };
    await providers.payRailExact(job, job.leg.handoff, USDT_AMOUNT, exact);
    expect(mocks.submits).toEqual([
      {
        args: { id: 1984, target: { type: "Id", value: DEPOSIT }, amount: USDT_AMOUNT },
        options: {
          asset: TOKENS.USDT.location,
          at: "0xbest",
          nonce: 1,
          mortality: { mortal: true, period: 64 },
        },
      },
    ]);
    expect(exact).toMatchObject({ inFlight: true, balanceBefore: "27000000" });
  });

  it("sends the USDT residue home on the mint route the worker chose for it", async () => {
    const engine = await engineWith({ "s-1": psmJob() });
    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).toHaveBeenCalledTimes(1);
    expect(mocks.chooseRoute).toHaveBeenCalledTimes(1);
    expect(mocks.chooseRoute.mock.calls[0]![1]).toEqual({
      direction: "mint",
      internalAmount: 27_000_000n,
      deposit: "USDT",
    });
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({
      sessionId: "s-1/residue",
      burnerAddress: "5Key",
      tier: "psm",
      external: "USDT",
      feeRate: 5_000,
      quoteFloorPct: 5,
      claimIdOffset: 1_000_000,
    });
    expect(storedJob().residue).toEqual({
      amount: "27000000",
      returning: true,
      sessionId: "s-1/residue",
      route: { tier: "psm", external: "USDT", feeRate: 5_000 },
    });
  });

  it("keeps a USDT residue under a tenth of a dollar, choosing no route for it", async () => {
    mocks.keyToken = 99_999n;
    const engine = await engineWith({ "s-1": psmJob() });
    await engine.tickAllWithdraw();
    expect(mocks.chooseRoute).not.toHaveBeenCalled();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    expect(storedJob().residue).toEqual({ amount: "99999", returning: false });
  });
});
