// The worker's side of a fiat sale through an offramp lane, offline: the hand-off carries the
// Chainflip channel the key pays, the key pays all its USDT into it once Chainflip's record names
// the provider's deposit address, and a swap that failed after the key paid waits for its refund
// to reach the key before the key goes home. And a direct sale of USDT, which runs the same redeem
// with no swap: the key pays the provider the exact USDT figure, and what is left goes home as
// USDT. The PSM in this script has no room to mint the USDT back, so every way home takes the pool.

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
  keyFree: 0n,
  /** The key's USDT on Asset Hub, and its CASH there. */
  keyUsdt: 0n,
  keyCash: 0n,
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

// How the CASH moves to Asset Hub is the chains' answer, and the scripted leg does not read it.
vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chooseCashTransfer: async () => "teleport",
  chooseRoute: async () => ({ tier: "pool", external: "USDT" }),
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
        apis: {
          AssetConversionApi: {
            quote_price_tokens_for_exact_tokens: async (_a: unknown, _b: unknown, fee: bigint) =>
              fee / 1_000n,
          },
        },
        tx: {
          Assets: { transfer_keep_alive: () => ({ getEstimatedFees: async () => 160_000_000n }) },
        },
        query: {
          Assets: {
            Account: {
              getValue: (id: number) =>
                Promise.resolve({ balance: id === 1984 ? mocks.keyUsdt : mocks.keyCash }),
            },
            Asset: { getValue: () => Promise.resolve({ min_balance: 70_000n }) },
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

const SOLANA_DEPOSIT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CF_DEPOSIT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const swap = {
  id: "cf-channel-7",
  address: CF_DEPOSIT,
  openedAt: NOW - 60_000,
  expiresAt: NOW + DAY,
  expectedEgress: "99150000",
  amount: "99800000",
};

/** A lane sale's hand-off: the provider's Solana deposit, and the swap that pays it. */
const swapHandoff = (overrides: Record<string, unknown> = {}) =>
  handoff({
    channel: { ...channel, address: SOLANA_DEPOSIT, amount: "98850000" },
    tier: "psm",
    external: "USDT",
    feeRate: 1000,
    swap,
    ...overrides,
  });

describe("a fiat sale through an offramp lane", () => {
  beforeEach(() => {
    mocks.stored.clear();
    for (const fn of [
      mocks.railFor,
      mocks.payRail,
      mocks.payRailExact,
      mocks.status,
      mocks.channel,
      mocks.startFunding,
    ]) {
      fn.mockReset();
    }
    mocks.channel.mockResolvedValue({
      depositAddress: CF_DEPOSIT,
      destinationAddress: SOLANA_DEPOSIT,
      expired: false,
    });
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.payRail.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({ status: "receiving" });
    mocks.startFunding.mockResolvedValue({ sessionId: "s-1/residue" });
    mocks.keyFree = 0n;
    mocks.keyUsdt = 0n;
    mocks.keyCash = 0n;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The lane sale with its USDT landed on the key. */
  async function landed() {
    const first = await engineWith({});
    await first.startWithdraw(swapHandoff());
    const job = storedJob();
    Object.assign(job, { landed: true, phase: "handoff" });
    job.state.fundsSeenAt = NOW - 60_000;
    return engineWith({ "s-1": job });
  }

  it("refuses a swap without the USDT it must land, or that does not redeem for USDT", async () => {
    const engine = await engineWith({});
    const { amount: _dropped, ...noAmount } = swap;
    expect(await engine.startWithdraw(swapHandoff({ swap: noAmount }))).toMatchObject({
      error: "invalid",
      reason: expect.stringMatching(/USDT it must land/),
    });
    expect(
      await engine.startWithdraw(swapHandoff({ tier: "pool", external: undefined })),
    ).toMatchObject({
      error: "invalid",
      reason: expect.stringMatching(/redeems its CASH for USDT/),
    });
  });

  it("pays the swap's channel, not the provider, with no exact payment", async () => {
    const engine = await engineWith({});
    expect(await engine.startWithdraw(swapHandoff())).toMatchObject({ sessionId: "s-1" });
    const job = storedJob();
    expect(job.swap).toMatchObject({ id: "cf-channel-7", amount: "99800000" });
    expect(job.leg.handoff).toMatchObject({ id: "cf-channel-7", address: CF_DEPOSIT });
    expect(job.leg.exact).toBeUndefined();
  });

  it("holds the message to the USDT the swap was quoted on", async () => {
    const engine = await engineWith({});
    await engine.startWithdraw(swapHandoff());
    mocks.withdrawTickOnce.mockResolvedValue({ step: "await-cash" });
    await engine.tickAllWithdraw();
    const [input] = mocks.withdrawTickOnce.mock.calls[0]!;
    expect(await input.minLanding()).toBe(99_800_000n);
  });

  it("sweeps the key into the swap once Chainflip's record pays the provider's address", async () => {
    const engine = await landed();
    await engine.tickAllWithdraw();
    expect(mocks.channel).toHaveBeenCalledWith("cf-channel-7");
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(mocks.payRail).toHaveBeenCalledTimes(1);
    expect(mocks.payRail.mock.calls[0]![1]).toMatchObject({
      id: "cf-channel-7",
      address: CF_DEPOSIT,
    });
    expect(storedJob().leg.paid).toBe(true);
  });

  it("pays nothing into a swap that pays out anywhere but the provider", async () => {
    mocks.channel.mockResolvedValue({
      depositAddress: CF_DEPOSIT,
      destinationAddress: "Some0therSo1anaAddressThatIsNotTheProv1der",
      expired: false,
    });
    const engine = await landed();
    await engine.tickAllWithdraw();
    expect(mocks.payRail).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-mismatch" });
  });

  it("waits for a failed swap's refund, then sends the USDT home through the pool", async () => {
    const engine = await landed();
    await engine.tickAllWithdraw(); // the key pays the swap
    mocks.status.mockResolvedValue({ status: "failed", raw: "FAILED" });
    await engine.tickAllWithdraw(); // Chainflip refunds it
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "rail-failed" });
    expect(storedJob().residueError).toMatch(/refund/);
    expect(mocks.startFunding).not.toHaveBeenCalled();
    mocks.keyUsdt = 99_000_000n; // the refund lands on the key
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({ tier: "pool", external: "USDT" });
    expect(storedJob().residue).toMatchObject({ amount: "99000000", returning: true });
  });

  it("waits for no refund once Chainflip has delivered to the provider", async () => {
    const engine = await landed();
    await engine.tickAllWithdraw();
    mocks.status.mockResolvedValue({ status: "failed", raw: "failed", swapDelivered: true });
    await engine.tickAllWithdraw();
    expect(storedJob().residueError).toBeUndefined();
    expect(storedJob().residue).toEqual({ amount: "0", returning: false });
  });

  it("reads a sweep whose answer was lost off the chain before Meld's closed order", async () => {
    await landed();
    const job = storedJob();
    job.leg.sweep = { attempts: 1, rejections: 0 }; // the sweep left; its answer did not come back
    mocks.keyUsdt = 0n; // and the key is empty behind it
    mocks.channel.mockResolvedValue({
      depositAddress: CF_DEPOSIT,
      destinationAddress: SOLANA_DEPOSIT,
      expired: true, // Meld closed the order once the swap paid it
    });
    const resumed = await engineWith({ "s-1": job });
    await resumed.tickAllWithdraw();
    expect(storedJob().phase).not.toBe("failed");
    expect(storedJob().leg.paid).toBe(true);
    expect(mocks.channel).not.toHaveBeenCalled();
    expect(mocks.payRail).not.toHaveBeenCalled();
  });

  it("still checks Meld before paying when the key holds the USDT a tried sweep left", async () => {
    await landed();
    const job = storedJob();
    job.leg.sweep = { attempts: 1, rejections: 1 }; // refused at inclusion: nothing left
    mocks.keyUsdt = 99_000_000n;
    const resumed = await engineWith({ "s-1": job });
    await resumed.tickAllWithdraw();
    expect(mocks.channel).toHaveBeenCalledWith("cf-channel-7");
    expect(mocks.payRail).toHaveBeenCalledTimes(1);
  });

  it("keeps reading a key that failed before the purse paid, and sends the CASH home once it lands", async () => {
    // Twelve minutes left on the channel: inside the worker's own margin as the hand-off arrives.
    const engine = await engineWith({});
    await engine.startWithdraw(swapHandoff({ swap: { ...swap, expiresAt: NOW + 12 * 60_000 } }));
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-expired" });
    // Nothing on the key yet, and the purse's window is open: no books closed on an empty key.
    expect(storedJob().residue).toBeUndefined();
    expect(storedJob().residueError).toMatch(/purse's payment window/);
    mocks.keyCash = 100_000_000n; // the purse pays a moment later
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    // CASH that never redeemed goes home as it is.
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({ tier: "dotusd" });
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });

  it("closes an empty key's books once the purse's window is over", async () => {
    const engine = await engineWith({});
    await engine.startWithdraw(
      swapHandoff({
        swap: { ...swap, expiresAt: NOW + 12 * 60_000 },
        paymentExpiresAt: NOW + 60_000,
      }),
    );
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    vi.setSystemTime(NOW + 60_000 + 10 * 60_000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({ whole: true, returning: false });
  });

  it("re-arms a sale that failed before any CASH arrived on the fresh swap the page re-sends", async () => {
    const engine = await engineWith({});
    await engine.startWithdraw(swapHandoff({ swap: { ...swap, expiresAt: NOW + 12 * 60_000 } }));
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-expired" });
    const fresh = { ...swap, id: "cf-channel-8", expiresAt: NOW + DAY };
    await engine.startWithdraw(swapHandoff({ swap: fresh }));
    expect(storedJob().phase).toBe("starting");
    expect(storedJob().swap).toMatchObject({ id: "cf-channel-8" });
    expect(storedJob().leg.handoff).toMatchObject({ id: "cf-channel-8", expiresAt: NOW + DAY });
  });

  it("never swaps the channel under a key that may already have paid it", async () => {
    const engine = await landed();
    await engine.tickAllWithdraw(); // the key pays the swap
    await engine.startWithdraw(swapHandoff({ swap: { ...swap, id: "cf-channel-8" } }));
    expect(storedJob().leg.handoff.id).toBe("cf-channel-7");
    expect(storedJob().swap.id).toBe("cf-channel-7");
  });

  it("waits as long as Chainflip's refund is pending, two hours and well past", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const engine = await landed();
      await engine.tickAllWithdraw();
      mocks.status.mockResolvedValue({ status: "failed", raw: "FAILED" });
      await engine.tickAllWithdraw();
      vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000); // an egress incident
      await engine.tickAllWithdraw();
      expect(storedJob().residue).toBeUndefined();
      expect(storedJob().residueError).toMatch(/refund/);
      mocks.keyUsdt = 99_000_000n; // the refund lands at last
      await engine.tickAllWithdraw();
      expect(storedJob().residue).toMatchObject({ amount: "99000000", returning: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting once Chainflip witnessed the refund and the key still reads empty", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const engine = await landed();
      await engine.tickAllWithdraw();
      mocks.status.mockResolvedValue({
        status: "failed",
        raw: "FAILED",
        refundEgress: { witnessedAt: Date.now() },
      });
      await engine.tickAllWithdraw();
      expect(storedJob().residueError).toMatch(/refund/);
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      await engine.tickAllWithdraw();
      expect(storedJob().residue).toEqual({ amount: "0", returning: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a refund Chainflip could not send for a person", async () => {
    const engine = await landed();
    await engine.tickAllWithdraw();
    mocks.status.mockResolvedValue({
      status: "failed",
      raw: "FAILED",
      refundEgress: { failure: { mode: "TRANSACTION_REJECTED_BY_BROKER" } },
    });
    await engine.tickAllWithdraw();
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({ amount: "0", returning: false, stuck: true });
    expect(mocks.startFunding).not.toHaveBeenCalled();
  });
});

describe("a direct fiat sale of USDT", () => {
  const usdtHandoff = (overrides: Record<string, unknown> = {}) =>
    handoff({
      channel: { ...channel, amount: "25000000" },
      tier: "psm",
      external: "USDT",
      feeRate: 1000,
      ...overrides,
    });

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
      expectedAmount: 25_000_000n,
    });
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.payRailExact.mockResolvedValue(undefined);
    mocks.exactPaymentOut.mockResolvedValue(false);
    mocks.status.mockResolvedValue({ status: "receiving" });
    mocks.startFunding.mockResolvedValue({ sessionId: "s-1/residue" });
    mocks.keyFree = 0n;
    mocks.keyUsdt = 0n;
    mocks.keyCash = 0n;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The sale with its USDT landed on the key. */
  async function landed() {
    const first = await engineWith({});
    await first.startWithdraw(usdtHandoff());
    const job = storedJob();
    Object.assign(job, { landed: true, phase: "handoff" });
    job.state.fundsSeenAt = NOW - 60_000;
    return engineWith({ "s-1": job });
  }

  it("keeps an exact payment for the provider, and no swap", async () => {
    const engine = await engineWith({});
    expect(await engine.startWithdraw(usdtHandoff())).toMatchObject({ sessionId: "s-1" });
    const job = storedJob();
    expect(job).toMatchObject({ tier: "psm", external: "USDT" });
    expect(job.swap).toBeUndefined();
    expect(job.leg.handoff).toMatchObject({ id: "funding-sell-1", address: DEPOSIT });
    expect(job.leg.exact).toMatchObject({ nonce: 0, inFlight: false });
  });

  it("refuses a direct sale that lands anything but PAS from the pool or USDT from the PSM", async () => {
    const engine = await engineWith({});
    const refused = { error: "invalid", reason: expect.stringMatching(/lands PAS .* or USDT/) };
    expect(await engine.startWithdraw(usdtHandoff({ external: "USDC" }))).toMatchObject(refused);
    expect(await engine.startWithdraw(usdtHandoff({ tier: "dotusd" }))).toMatchObject(refused);
    expect(await engine.startWithdraw(usdtHandoff({ tier: "pool" }))).toMatchObject(refused);
    expect(mocks.stored.get(WITHDRAW_KEY)).toEqual({});
  });

  it("holds the message to the payment, its fee priced in USDT and USDT's minimum balance", async () => {
    const engine = await engineWith({});
    await engine.startWithdraw(usdtHandoff());
    mocks.withdrawTickOnce.mockResolvedValue({ step: "await-cash" });
    await engine.tickAllWithdraw();
    const [input] = mocks.withdrawTickOnce.mock.calls[0]!;
    // The 0.16 USDT fee with its quarter of headroom, and the minimum balance.
    expect(await input.minLanding()).toBe(25_000_000n + 200_000n + 70_000n);
  });

  it("pays the provider exactly the USDT figure once its record matches", async () => {
    const engine = await landed();
    await engine.tickAllWithdraw();
    expect(mocks.channel).toHaveBeenCalledWith("funding-sell-1");
    expect(mocks.payRail).not.toHaveBeenCalled();
    expect(mocks.payRailExact).toHaveBeenCalledTimes(1);
    const [, handoffPaid, amount] = mocks.payRailExact.mock.calls[0]!;
    expect(handoffPaid).toMatchObject({ id: "funding-sell-1", address: DEPOSIT });
    expect(amount).toBe(25_000_000n);
    expect(storedJob().leg.paid).toBe(true);
  });

  it("pays nothing when the provider expects another figure", async () => {
    mocks.channel.mockResolvedValue({
      depositAddress: DEPOSIT,
      payout: "off-chain",
      expired: false,
      expectedAmount: 25_000_001n,
    });
    const engine = await landed();
    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-mismatch" });
  });

  it("sends what the payment left home as USDT through the pool", async () => {
    const engine = await landed();
    mocks.keyUsdt = 1_500_000n; // 1.5 USDT left on the key once it paid
    await engine.tickAllWithdraw(); // the key pays the provider, then what is left goes home
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({ tier: "pool", external: "USDT" });
    expect(storedJob().residue).toMatchObject({ amount: "1500000", returning: true });
  });

  it("keeps less than a USDT on the key rather than pay the way home", async () => {
    const engine = await landed();
    mocks.keyUsdt = 170_000n;
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    expect(storedJob().residue).toEqual({ amount: "170000", returning: false });
  });

  it("sends the whole key home as USDT when the sale ends before the provider is paid", async () => {
    mocks.channel.mockResolvedValue(null);
    const engine = await landed();
    mocks.keyUsdt = 25_300_000n;
    await engine.tickAllWithdraw();
    expect(mocks.payRailExact).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-mismatch" });
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({ tier: "pool", external: "USDT" });
    expect(storedJob().residue).toMatchObject({ whole: true, returning: true });
  });
});
