// The worker's side of a fiat sale through an offramp lane, offline: the hand-off carries the
// Chainflip channel the key pays, the key pays all its USDT into it once Chainflip's record names
// the provider's deposit address, and a swap that failed after the key paid waits for its refund
// to reach the key before the key goes home through the pool.

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
          Assets: {
            Account: { getValue: () => Promise.resolve({ balance: mocks.keyCash }) },
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
    mocks.keyCash = 99_000_000n; // the refund lands on the key
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({ tier: "pool", external: "USDT" });
    expect(storedJob().residue).toMatchObject({ amount: "99000000", returning: true });
  });
});
