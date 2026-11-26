// The worker's side of a direct fiat sale of USDT, offline: the PSM redeems the CASH for USDT on
// the key, the key pays the provider the exact USDT figure once its record matches, and what is
// left goes home as USDT. A sale whose time ran out before anything reached its key waits for the
// purse's payment window before it closes its books, and sends home whatever CASH lands meanwhile.
// The PSM in this script has no room to mint the USDT back, so every way home of USDT takes the
// pool.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  railFor: vi.fn(),
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
// so is what a key's balance converts to on its way home.
vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chooseCashTransfer: async () => "teleport",
  chooseRoute: async () => ({ tier: "pool", external: "USDT" }),
  quoteDepositValue: async () => ({
    receive: 1_000_000n,
    remoteFeeBuffer: 1_000n,
    keepNativeForFees: 0n,
  }),
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

describe("a direct fiat sale of USDT", () => {
  /** The provider's channel, for the exact 25 USDT the sale commits to. */
  const usdtChannel = { ...channel, amount: "25000000" };
  const usdtHandoff = (overrides: Record<string, unknown> = {}) =>
    handoff({
      channel: usdtChannel,
      tier: "psm",
      external: "USDT",
      feeRate: 1000,
      ...overrides,
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

  it("keeps an exact payment for the provider", async () => {
    const engine = await engineWith({});
    expect(await engine.startWithdraw(usdtHandoff())).toMatchObject({ sessionId: "s-1" });
    const job = storedJob();
    expect(job).toMatchObject({ tier: "psm", external: "USDT" });
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

  it("keeps reading a key that failed before the purse paid, and sends the CASH home once it lands", async () => {
    // Twelve minutes left to pay the provider: inside the worker's own margin as the hand-off
    // arrives, so the sale is never sold.
    const engine = await engineWith({});
    await engine.startWithdraw(
      usdtHandoff({ channel: { ...usdtChannel, expiresAt: NOW + 12 * 60_000 } }),
    );
    await engine.tickAllWithdraw();
    expect(mocks.withdrawTickOnce).not.toHaveBeenCalled();
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
      usdtHandoff({
        channel: { ...usdtChannel, expiresAt: NOW + 12 * 60_000 },
        paymentExpiresAt: NOW + 60_000,
      }),
    );
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    vi.setSystemTime(NOW + 60_000 + 10 * 60_000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({ whole: true, returning: false });
    expect(mocks.startFunding).not.toHaveBeenCalled();
  });
});
