// The worker's side of a fiat sale through an offramp lane, offline: the hand-off carries the
// Chainflip channel the key pays, the key pays all its USDT into it once Chainflip's record names
// the factory its proxy derives from, and a swap that failed after the key paid waits for its refund
// to reach the key before the key goes home. And a direct sale of USDT, which runs the same redeem
// with no swap: the key pays the provider the exact USDT figure, and what is left goes home as
// USDT. The PSM in this script has no room to mint the USDT back, so every way home takes the pool.

import {
  predictSaleVaultProxy,
  SALE_SWAP_RETRY_MINUTES,
  SALE_VAULT_PROXY_CHAIN_ID,
  saleVaultProxyDelaysMs,
} from "@getsome/chainflip/sale-vault-proxy";
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
    // The claimer only the job's own claim label derives
    claimerFor: async (label: string) =>
      `0x${(label === "wd:clm:meld-bank:1" ? "55" : "99").repeat(20)}`,
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
const { releaseDelayMs, staleDelayMs } = saleVaultProxyDelaysMs(SALE_VAULT_PROXY_CHAIN_ID)!;
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

/** Moves the clock past a residue wait's read cadence: 15 s, or hourly for a provider refund. */
const waitOut = (everyMs = 15_000) => vi.setSystemTime(Date.now() + everyMs);
const HOUR = 60 * 60 * 1000;

const ARBITRUM_DEPOSIT = `0x${"81".repeat(20)}`;
const CF_DEPOSIT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const FACTORY = `0x${"11".repeat(20)}`;
const IMPLEMENTATION = `0x${"22".repeat(20)}`;
const CLAIMER = `0x${"55".repeat(20)}`;
const PROXY = predictSaleVaultProxy(FACTORY, IMPLEMENTATION, hash32(0x07), CLAIMER);
const swap = {
  id: "cf-channel-7",
  address: CF_DEPOSIT,
  openedAt: NOW - 60_000,
  expiresAt: NOW + DAY,
  expectedEgress: "99150000",
  amount: "99800000",
  proxyChainId: 421614,
  proxyFactory: FACTORY,
  proxyImplementation: IMPLEMENTATION,
  proxyAddress: PROXY,
  claimerAddress: CLAIMER,
  paymentExpiresAt: NOW + DAY,
};

/** A lane sale's hand-off: the provider's Arbitrum deposit, and the swap that pays it. */
const swapHandoff = (overrides: Record<string, unknown> = {}) =>
  handoff({
    channel: { ...channel, address: ARBITRUM_DEPOSIT, amount: "98850000" },
    tier: "psm",
    external: "USDT",
    feeRate: 1000,
    swap,
    ...overrides,
  });

const SALE_URL = "https://adapter.test/offramp/sale/funding-sell-1";
const RETURN_URL = "https://adapter.test/offramp/returns/funding-sell-1";
const fetchMock = vi.fn();

/** The adapter answers both the sale read and a return request with `sale`. */
const proxySays = (sale: Record<string, unknown>) =>
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ sale })));
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

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
      destinationAddress: FACTORY,
      expired: false,
    });
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.payRail.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({ status: "receiving" });
    mocks.startFunding.mockResolvedValue({ sessionId: "s-1/residue" });
    mocks.keyFree = 0n;
    mocks.keyUsdt = 0n;
    mocks.keyCash = 0n;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // The swap never reached the proxy unless a test says it did.
    proxySays({ status: "none" });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
    const { paymentExpiresAt: _sealed, ...noDeadline } = swap;
    expect(await engine.startWithdraw(swapHandoff({ swap: noDeadline }))).toMatchObject({
      error: "invalid",
      reason: expect.stringMatching(/payment deadline its message seals/),
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

  it("sweeps the key into the swap once Chainflip's record pays the worker's factory", async () => {
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

  it("pays nothing into a swap that pays out anywhere but the factory, the provider too", async () => {
    mocks.channel.mockResolvedValue({
      depositAddress: CF_DEPOSIT,
      destinationAddress: ARBITRUM_DEPOSIT,
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
    // Read again only once the wait's cadence has passed
    expect(mocks.startFunding).not.toHaveBeenCalled();
    waitOut();
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({ tier: "pool", external: "USDT" });
    expect(storedJob().residue).toMatchObject({ amount: "99000000", returning: true });
  });

  it("waits for no swap refund once Chainflip has delivered to the proxy that paid", async () => {
    proxySays({ status: "paid" });
    const engine = await landed();
    await engine.tickAllWithdraw();
    mocks.status.mockResolvedValue({ status: "complete", swapDelivered: true });
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
      destinationAddress: FACTORY,
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
    waitOut();
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
    const fresh = { ...swap, id: "cf-channel-8", expiresAt: NOW + DAY / 2 };
    await engine.startWithdraw(swapHandoff({ swap: fresh }));
    expect(storedJob().phase).toBe("starting");
    expect(storedJob().swap).toMatchObject({ id: "cf-channel-8" });
    expect(storedJob().leg.handoff).toMatchObject({ id: "cf-channel-8", expiresAt: NOW + DAY / 2 });
  });

  it("stops paying a swap in time for a retried price to land by the sealed deadline", async () => {
    const engine = await engineWith({});
    const sealed = NOW + SALE_SWAP_RETRY_MINUTES * 60_000 + 12 * 60_000;
    await engine.startWithdraw(swapHandoff({ swap: { ...swap, paymentExpiresAt: sealed } }));
    expect(storedJob().leg.handoff).toMatchObject({
      expiresAt: sealed - SALE_SWAP_RETRY_MINUTES * 60_000,
    });
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-expired" });
    expect(storedJob().leg.paid).toBe(false);
  });

  it("takes no fresh swap that names no payment deadline for its message", async () => {
    const engine = await engineWith({});
    await engine.startWithdraw(swapHandoff({ swap: { ...swap, expiresAt: NOW + 12 * 60_000 } }));
    await engine.tickAllWithdraw();
    const { paymentExpiresAt: _sealed, ...fresh } = { ...swap, id: "cf-channel-8" };
    await engine.startWithdraw(swapHandoff({ swap: fresh }));
    expect(storedJob().swap).toMatchObject({ id: "cf-channel-7", paymentExpiresAt: NOW + DAY });
    expect(storedJob().leg.handoff.id).toBe("cf-channel-7");
  });

  it("takes no fresh swap that pays through another proxy", async () => {
    const engine = await engineWith({});
    await engine.startWithdraw(swapHandoff({ swap: { ...swap, expiresAt: NOW + 12 * 60_000 } }));
    await engine.tickAllWithdraw();
    const fresh = { ...swap, id: "cf-channel-8", proxyAddress: `0x${"44".repeat(20)}` };
    await engine.startWithdraw(swapHandoff({ swap: fresh }));
    expect(storedJob().swap).toMatchObject({ id: "cf-channel-7", proxyAddress: PROXY });
    expect(storedJob().leg.handoff.id).toBe("cf-channel-7");
  });

  it("takes no fresh swap whose claimer the worker does not derive", async () => {
    const engine = await engineWith({});
    await engine.startWithdraw(swapHandoff({ swap: { ...swap, expiresAt: NOW + 12 * 60_000 } }));
    await engine.tickAllWithdraw();
    const other = `0x${"66".repeat(20)}`;
    const fresh = {
      ...swap,
      id: "cf-channel-8",
      claimerAddress: other,
      proxyAddress: predictSaleVaultProxy(FACTORY, IMPLEMENTATION, hash32(0x07), other),
    };
    await engine.startWithdraw(swapHandoff({ swap: fresh }));
    expect(storedJob().swap).toMatchObject({ id: "cf-channel-7", claimerAddress: CLAIMER });
    expect(storedJob().leg.handoff.id).toBe("cf-channel-7");
  });

  it("refuses a new swap sale whose claimer the worker does not derive, storing nothing", async () => {
    const engine = await engineWith({});
    const other = `0x${"66".repeat(20)}`;
    const proxyAddress = predictSaleVaultProxy(FACTORY, IMPLEMENTATION, hash32(0x07), other);
    expect(
      await engine.startWithdraw(
        swapHandoff({ swap: { ...swap, claimerAddress: other, proxyAddress } }),
      ),
    ).toMatchObject({
      error: "invalid",
      reason: expect.stringMatching(`claimer is ${other}, the worker derives ${CLAIMER}`),
    });
    expect(mocks.stored.get(WITHDRAW_KEY)).toEqual({});
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
      waitOut();
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

describe("a fiat sale through its SaleVaultProxy", () => {
  beforeEach(() => {
    mocks.stored.clear();
    for (const fn of [
      mocks.railFor,
      mocks.payRail,
      mocks.status,
      mocks.channel,
      mocks.startFunding,
    ]) {
      fn.mockReset();
    }
    mocks.channel.mockResolvedValue({
      depositAddress: CF_DEPOSIT,
      destinationAddress: FACTORY,
      expired: false,
    });
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.payRail.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({ status: "receiving" });
    mocks.startFunding.mockResolvedValue({ sessionId: "s-1/residue" });
    mocks.keyFree = 0n;
    mocks.keyUsdt = 0n;
    mocks.keyCash = 0n;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A stored lane sale with its USDT landed on the key, `edit` applied before it is resumed. */
  async function landedJob(edit: (job: StoredJob) => void = () => {}) {
    const first = await engineWith({});
    await first.startWithdraw(swapHandoff());
    const job = storedJob();
    Object.assign(job, { landed: true, phase: "handoff" });
    job.state.fundsSeenAt = NOW - 60_000;
    edit(job);
    return engineWith({ "s-1": job });
  }

  /** A proxy sale whose key paid the swap, and whose Meld sale then failed. */
  async function failedAfterDelivery(delivered = true) {
    const engine = await landedJob();
    await engine.tickAllWithdraw(); // the key pays the swap
    expect(fetchMock).not.toHaveBeenCalled();
    // The rail names only a delivery, never its absence
    mocks.status.mockResolvedValue({
      status: "failed",
      raw: "failed",
      ...(delivered ? { swapDelivered: true } : {}),
    });
    return engine;
  }

  /** The keeper's last call for the sale. */
  const call = (action: string, status: string, at = NOW) => ({
    action,
    status,
    txHash: "0xcall",
    at,
  });

  it("pays only a channel that delivers to the factory the key's proxy derives from", async () => {
    mocks.channel.mockResolvedValue({
      depositAddress: CF_DEPOSIT,
      destinationAddress: `0x${"33".repeat(20)}`,
      expired: false,
    });
    const engine = await landedJob();
    await engine.tickAllWithdraw();
    expect(mocks.payRail).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-mismatch" });
  });

  it("asks for a return while the proxy holds funds, and waits for it", async () => {
    proxySays({ status: "held", balance: "98000000", returnable: true, attempts: 0 });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(fetchMock).toHaveBeenCalledWith(SALE_URL, {
      headers: { accept: "application/json", "x-dev-product-id": "getcash.dev" },
      signal: expect.any(AbortSignal),
    });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![0]).toBe(RETURN_URL);
    expect(posts()[0]![1]).toMatchObject({ method: "POST", body: "{}" });
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "rail-failed" });
    expect(storedJob().proxyReturnSince).toBe(NOW);
    expect(storedJob().residue).toBeUndefined();
    expect(storedJob().residueError).toMatch(/sale vault proxy's return/);
    expect(mocks.startFunding).not.toHaveBeenCalled();
  });

  it("reads the proxy and asks the keeper once per cadence, holding the job meanwhile", async () => {
    proxySays({ status: "held", balance: "98000000", returnable: true });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    const reads = fetchMock.mock.calls.length;
    expect(posts()).toHaveLength(1);
    for (const at of [NOW + 6_000, NOW + 12_000]) {
      vi.setSystemTime(at);
      // Still owed, so the keep-alive stays held between reads
      expect((await engine.tickAllWithdraw()).ticked).toBe(1);
    }
    expect(fetchMock.mock.calls.length).toBe(reads);
    vi.setSystemTime(NOW + 15_000);
    await engine.tickAllWithdraw();
    expect(posts()).toHaveLength(2);
  });

  it.each(["sending", "sent"])("waits on a return %s without asking again", async (status) => {
    proxySays({ status: "held", returnable: true, call: call("return", status) });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(0);
    expect(storedJob().residueError).toMatch(/sale vault proxy's return/);
  });

  it("takes a return the adapter refuses for now as a wait, and reports any other", async () => {
    let refusal = 503;
    fetchMock.mockImplementation(async (url: string) =>
      url === RETURN_URL
        ? new Response("{}", { status: refusal })
        : new Response(JSON.stringify({ sale: { status: "held", returnable: true } })),
    );
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(storedJob().residueError).toMatch(/sale vault proxy's return/);
    refusal = 409;
    waitOut();
    await engine.tickAllWithdraw();
    expect(storedJob().residueError).toMatch(/sale vault proxy's return/);
    refusal = 500;
    waitOut();
    await engine.tickAllWithdraw();
    expect(storedJob().residueError).toMatch(/500/);
    expect(posts()).toHaveLength(3);
    expect(storedJob().residue).toBeUndefined();
  });

  it("sends the returned USDT home as CASH once it lands on the key", async () => {
    proxySays({ status: "held", call: call("return", "mined", NOW - 60_000) });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    expect(storedJob().residueError).toMatch(/return to reach the key/);
    expect(storedJob().proxyReturnSeenAt).toBe(NOW - 60_000);
    expect(mocks.startFunding).not.toHaveBeenCalled();
    mocks.keyUsdt = 98_000_000n; // the return lands on the key
    vi.setSystemTime(NOW + 60_000);
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({
      sessionId: "s-1/residue",
      tier: "pool",
      external: "USDT",
    });
    expect(storedJob().residue).toMatchObject({ amount: "98000000", returning: true });
    expect(storedJob().residueError).toBeUndefined();
  });

  it("leaves a return that never reaches the key for a person after the proxy's release delay", async () => {
    proxySays({ status: "held", call: call("return", "mined") });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    vi.setSystemTime(NOW + releaseDelayMs - 15_000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    vi.setSystemTime(NOW + releaseDelayMs);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({
      amount: "0",
      returning: false,
      stuck: true,
      onProxy: true,
    });
    expect(mocks.startFunding).not.toHaveBeenCalled();
  });

  it("keeps a return that landed under the floor as the withdrawal's dust, not stuck on the proxy", async () => {
    proxySays({ status: "held", balance: "0", pending: "0", call: call("return", "mined") });
    const engine = await failedAfterDelivery();
    // A testnet return of the 1 USDC least, less its fees, lands under the 1 USDT floor
    mocks.keyUsdt = 980_000n;
    await engine.tickAllWithdraw();
    expect(storedJob().residueError).toMatch(/return to reach the key/);
    vi.setSystemTime(NOW + 3 * HOUR - 15_000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    vi.setSystemTime(NOW + 3 * HOUR);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({ amount: "980000", returning: false });
    expect(mocks.startFunding).not.toHaveBeenCalled();
  });

  it("leaves a proxy waiting to release to the claimer for a person at once", async () => {
    proxySays({ status: "held", balance: "400000", waiting: "400000" });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({
      amount: "0",
      returning: false,
      stuck: true,
      onProxy: true,
    });
    expect(storedJob().residueError).toBeUndefined();
    expect(posts()).toHaveLength(0);
  });

  it("waits three hours for the proxy to book a delivery, then leaves it for a person", async () => {
    proxySays({ status: "none" });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    expect(storedJob().residueError).toMatch(/book the delivery/);
    expect(storedJob().proxyDeliverySince).toBe(NOW);
    vi.setSystemTime(NOW + 3 * 60 * 60 * 1000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({
      amount: "0",
      returning: false,
      stuck: true,
      onProxy: true,
    });
  });

  it("leaves a return the keeper never sends for a person after a week", async () => {
    // The keeper never tries, as when it is blocked: the wait still ends.
    proxySays({ status: "held", returnable: true, attempts: 0 });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    vi.setSystemTime(NOW + 7 * DAY - 15_000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    vi.setSystemTime(NOW + 7 * DAY);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({
      amount: "0",
      returning: false,
      stuck: true,
      onProxy: true,
    });
    expect(posts()).toHaveLength(2);
  });

  it("starts the return's clock even when the ask fails", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === RETURN_URL
        ? new Response("{}", { status: 500 })
        : new Response(JSON.stringify({ sale: { status: "held", returnable: true } })),
    );
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(storedJob().residueError).toMatch(/500/);
    expect(storedJob().proxyReturnSince).toBe(NOW);
    vi.setSystemTime(NOW + 7 * DAY);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({
      amount: "0",
      returning: false,
      stuck: true,
      onProxy: true,
    });
  });

  it("judges a second return by its own clock, not the first's", async () => {
    proxySays({ status: "paid", returnable: true });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(storedJob().proxyReturnSince).toBe(NOW);
    // A first chunk is mined and the proxy still holds a second.
    vi.setSystemTime(NOW + 6 * DAY);
    proxySays({ status: "paid", returnable: true, call: call("return", "mined", NOW + 6 * DAY) });
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({
      proxyReturnSince: NOW + 6 * DAY,
      proxyReturnSeenAt: NOW + 6 * DAY,
      proxyReturnTx: "0xcall",
    });
    vi.setSystemTime(NOW + 7 * DAY);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    // The second return is mined later, under its own transaction.
    vi.setSystemTime(NOW + 8 * DAY);
    proxySays({
      status: "paid",
      call: { ...call("return", "mined", NOW + 8 * DAY), txHash: "0xsecond" },
    });
    await engine.tickAllWithdraw();
    expect(storedJob().proxyReturnSeenAt).toBe(NOW + 8 * DAY);
    expect(storedJob().proxyReturnSince).toBeUndefined();
    expect(storedJob().residueError).toMatch(/return to reach the key/);
    expect(storedJob().residue).toBeUndefined();
  });

  it("asks the keeper to deliver a sale the factory deferred, and waits for it", async () => {
    proxySays({ status: "none", deferred: "98000000", pending: "0", returnable: false });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![0]).toBe(RETURN_URL);
    expect(storedJob().proxyDeliverySince).toBe(NOW);
    expect(storedJob().residueError).toMatch(/keeper to deliver/);
    expect(storedJob().residue).toBeUndefined();
    // The keeper's deliver is on its way: no second ask.
    proxySays({ status: "none", deferred: "98000000", call: call("deliver", "sent") });
    waitOut();
    await engine.tickAllWithdraw();
    expect(posts()).toHaveLength(1);
    // Delivered short of the sale's terms, the sale is held and goes home.
    proxySays({
      status: "held",
      balance: "98000000",
      returnable: true,
      call: call("deliver", "mined"),
    });
    waitOut();
    await engine.tickAllWithdraw();
    expect(posts()).toHaveLength(2);
    expect(storedJob().residueError).toMatch(/sale vault proxy's return/);
  });

  it("leaves a deferred delivery the keeper never makes for a person after three hours", async () => {
    proxySays({ status: "none", deferred: "98000000" });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    vi.setSystemTime(NOW + 3 * 60 * 60 * 1000 - 15_000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    vi.setSystemTime(NOW + 3 * 60 * 60 * 1000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({
      amount: "0",
      returning: false,
      stuck: true,
      onProxy: true,
    });
  });

  it("starts the deferred delivery's clock even when the ask fails", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === RETURN_URL
        ? new Response("{}", { status: 500 })
        : new Response(JSON.stringify({ sale: { status: "none", deferred: "98000000" } })),
    );
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(storedJob().residueError).toMatch(/500/);
    expect(storedJob().proxyDeliverySince).toBe(NOW);
    vi.setSystemTime(NOW + 3 * 60 * 60 * 1000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({
      amount: "0",
      returning: false,
      stuck: true,
      onProxy: true,
    });
  });

  it("takes funds-only factory pending as a return to ask for", async () => {
    proxySays({ status: "none", pending: "98000000", returnable: true });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(posts()).toHaveLength(1);
    expect(storedJob().residueError).toMatch(/sale vault proxy's return/);
    expect(storedJob().residue).toBeUndefined();
  });

  it("leaves an answer read on another chain than the sale's for a person", async () => {
    proxySays({ status: "paid", chainId: 42161 });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(posts()).toHaveLength(0);
    expect(storedJob().residue).toEqual({
      amount: "0",
      returning: false,
      stuck: true,
      onProxy: true,
    });
  });

  it("decides the residue as today once the proxy paid and only dust is left", async () => {
    proxySays({ status: "paid", balance: "30000", leftover: "30000" });
    const engine = await landedJob();
    await engine.tickAllWithdraw();
    mocks.status.mockResolvedValue({ status: "complete", swapDelivered: true });
    await engine.tickAllWithdraw();
    expect(posts()).toHaveLength(0);
    expect(storedJob().residueError).toBeUndefined();
    expect(storedJob().residue).toEqual({ amount: "0", returning: false });
  });

  it("follows Chainflip's refund, not the adapter, when the swap never reached the proxy", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
    const engine = await failedAfterDelivery(false);
    await engine.tickAllWithdraw();
    vi.setSystemTime(NOW + 3 * 60 * 60 * 1000);
    await engine.tickAllWithdraw();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedJob().residue).toBeUndefined();
    expect(storedJob().residueError).toMatch(/swap's refund/);
  });

  it.each([
    [
      "the adapter cannot name the proxy",
      () => fetchMock.mockResolvedValue(new Response("{}", { status: 404 })),
    ],
    [
      "the proxy waits to release to the claimer",
      () => proxySays({ status: "held", balance: "400000", waiting: "400000" }),
    ],
  ])("sends home what reached the key when %s, rather than leave it", async (_, adapter) => {
    adapter();
    const engine = await failedAfterDelivery();
    mocks.keyUsdt = 98_000_000n;
    await engine.tickAllWithdraw();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedJob().residue).toMatchObject({ amount: "98000000", returning: true });
  });

  it("sends a refund that reaches the key after its residue home, under a round of its own", async () => {
    proxySays({ status: "paid", balance: "30000", leftover: "30000" });
    const engine = await landedJob();
    await engine.tickAllWithdraw();
    mocks.status.mockResolvedValue({ status: "complete", swapDelivered: true });
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({ amount: "0", returning: false });
    expect(storedJob().residueSettledAt).toBe(NOW);
    expect(storedJob().lateWatch).toEqual({ checkedAt: NOW });
    // The keeper returns a provider refund the proxy got later.
    mocks.keyUsdt = 60_000_000n;
    vi.setSystemTime(NOW + 60 * 60 * 1000 - 1);
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 60 * 60 * 1000);
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({
      sessionId: "s-1/residue/1",
      claimIdOffset: 2_000_000,
    });
    expect(storedJob().residue).toMatchObject({
      amount: "60000000",
      returning: true,
      sessionId: "s-1/residue/1",
      round: 1,
    });
    expect(storedJob().lateWatch).toBeUndefined();
    // Claimed, the key is watched again from then.
    mocks.fundingStatus.mockResolvedValue({ phase: "done", claim: { phase: "claimed" } });
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toMatchObject({ round: 1, returned: true });
    expect(storedJob().lateWatch).toEqual({ checkedAt: NOW + 60 * 60 * 1000 });
  });

  it("never watches a residue that settled before this worker kept when it did", async () => {
    proxySays({ status: "paid", balance: "30000", leftover: "30000" });
    const engine = await landedJob();
    await engine.tickAllWithdraw();
    mocks.status.mockResolvedValue({ status: "complete", swapDelivered: true });
    await engine.tickAllWithdraw();
    const job = storedJob();
    delete job.residueSettledAt;
    delete job.lateWatch;
    const upgraded = await engineWith({ "s-1": job });
    mocks.keyUsdt = 60_000_000n;
    vi.setSystemTime(NOW + DAY);
    expect((await upgraded.tickAllWithdraw()).ticked).toBe(0);
    expect(storedJob().lateWatch).toBeUndefined();
    expect(mocks.startFunding).not.toHaveBeenCalled();
  });

  it("stops watching a key once its watch is over", async () => {
    proxySays({ status: "paid", balance: "30000", leftover: "30000" });
    const engine = await landedJob();
    await engine.tickAllWithdraw();
    mocks.status.mockResolvedValue({ status: "complete", swapDelivered: true });
    await engine.tickAllWithdraw();
    expect(storedJob().lateWatch).toEqual({ checkedAt: NOW });
    // The keeper's last return lands within the release delay after its watch
    const end = NOW + staleDelayMs + releaseDelayMs;
    mocks.keyUsdt = 0n;
    vi.setSystemTime(end - 1);
    await engine.tickAllWithdraw();
    expect(storedJob().lateWatch).toEqual({ checkedAt: end - 1 });
    mocks.keyUsdt = 60_000_000n;
    vi.setSystemTime(end);
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    expect(storedJob().lateWatch).toEqual({ checkedAt: end - 1 });
  });

  it("waits for the provider's refund through the proxy once it failed paid, then sends it home", async () => {
    proxySays({ status: "paid" });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(storedJob().providerRefundSince).toBe(NOW);
    expect(storedJob().residueError).toMatch(/provider's refund/);
    // The refund reaches the proxy, and the keeper returns it.
    proxySays({ status: "paid", balance: "60000000", returnable: true });
    vi.setSystemTime(NOW + DAY);
    await engine.tickAllWithdraw();
    expect(posts()).toHaveLength(1);
    expect(storedJob().residueError).toMatch(/sale vault proxy's return/);
    proxySays({ status: "paid", call: call("return", "mined", NOW + DAY) });
    mocks.keyUsdt = 60_000_000n;
    vi.setSystemTime(NOW + DAY + 60_000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toMatchObject({ amount: "60000000", returning: true });
  });

  it("leaves a provider refund that never comes for a person after two weeks", async () => {
    proxySays({ status: "paid" });
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    vi.setSystemTime(NOW + 14 * DAY - HOUR);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    vi.setSystemTime(NOW + 14 * DAY);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({
      amount: "0",
      returning: false,
      stuck: true,
      onProxy: true,
    });
  });

  it("follows Chainflip's refund when the swap never reached the proxy", async () => {
    proxySays({ status: "none" });
    const engine = await failedAfterDelivery(false);
    await engine.tickAllWithdraw();
    expect(storedJob().residueError).toMatch(/swap's refund/);
    mocks.keyUsdt = 99_000_000n; // the refund lands on the key
    waitOut();
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toMatchObject({ amount: "99000000", returning: true });
  });

  it("waits when the adapter cannot say", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    expect(storedJob().residueError).toMatch(/404/);
    fetchMock.mockRejectedValue(new Error("network down"));
    waitOut();
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    expect(storedJob().residueError).toMatch(/network down/);
  });

  it.each([
    ["has no record of the sale", 404, {}],
    ["says the sale has no proxy", 409, { error: "SALE_NOT_PROXY" }],
  ])("leaves a proxy for a person three hours after the adapter %s", async (_, status, body) => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(storedJob().proxyUnreadSince).toBe(NOW);
    expect(storedJob().residueError).toMatch(/waiting for the sale vault proxy/);
    vi.setSystemTime(NOW + 3 * 60 * 60 * 1000 - 15_000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    vi.setSystemTime(NOW + 3 * 60 * 60 * 1000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({
      amount: "0",
      returning: false,
      stuck: true,
      onProxy: true,
    });
    expect(mocks.startFunding).not.toHaveBeenCalled();
  });

  it("leaves a proxy for a person a week after the adapter keeps failing", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 503 }));
    const engine = await failedAfterDelivery();
    await engine.tickAllWithdraw();
    expect(storedJob().proxyUnreadSince).toBe(NOW);
    expect(storedJob().residueError).toMatch(/503/);
    vi.setSystemTime(NOW + 7 * DAY - 15_000);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    vi.setSystemTime(NOW + 7 * DAY);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({
      amount: "0",
      returning: false,
      stuck: true,
      onProxy: true,
    });
  });

  it("never pays, nor reads the adapter for, a sale stored without a proxy", async () => {
    const engine = await landedJob((job) => {
      delete job.swap.proxyFactory;
      delete job.swap.proxyAddress;
    });
    await engine.tickAllWithdraw();
    mocks.status.mockResolvedValue({ status: "failed", raw: "failed", swapDelivered: true });
    await engine.tickAllWithdraw();
    expect(mocks.payRail).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-mismatch" });
    expect(storedJob().residue).toEqual({ whole: true, returning: false });
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
    mocks.status.mockResolvedValue({ status: "complete" });
    await engine.tickAllWithdraw(); // the key pays the provider
    await engine.tickAllWithdraw(); // the sale settles, then what is left goes home
    expect(mocks.startFunding).toHaveBeenCalledTimes(1);
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({ tier: "pool", external: "USDT" });
    expect(storedJob().residue).toMatchObject({ amount: "1500000", returning: true });
  });

  it("keeps less than a USDT on the key rather than pay the way home", async () => {
    const engine = await landed();
    mocks.keyUsdt = 170_000n;
    mocks.status.mockResolvedValue({ status: "complete" });
    await engine.tickAllWithdraw();
    await engine.tickAllWithdraw();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    expect(storedJob().residue).toEqual({ amount: "170000", returning: false });
  });

  it("sends nothing home while the paid sale is live", async () => {
    const engine = await landed();
    mocks.keyUsdt = 1_500_000n;
    await engine.tickAllWithdraw();
    await engine.tickAllWithdraw();
    expect(storedJob().leg.paid).toBe(true);
    expect(storedJob().residue).toBeUndefined();
    expect(mocks.startFunding).not.toHaveBeenCalled();
  });

  /** The provider's ending for a sale it refunded instead of paying out. */
  const refunded = {
    status: "failed",
    depositFailure: { reason: { code: "refunded" }, kind: "unknown" },
  };

  it("waits for a refunded sale's refund on the key, then sends it home", async () => {
    const engine = await landed();
    mocks.keyUsdt = 170_000n;
    await engine.tickAllWithdraw(); // the key pays the provider
    mocks.status.mockResolvedValue(refunded);
    await engine.tickAllWithdraw(); // the provider refunds to the key, its sending address
    expect(storedJob()).toMatchObject({ phase: "failed" });
    expect(storedJob().residue).toBeUndefined();
    expect(storedJob().residueError).toMatch(/provider's refund/);
    mocks.keyUsdt = 25_170_000n; // the refund lands
    waitOut(HOUR);
    await engine.tickAllWithdraw();
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({ tier: "pool", external: "USDT" });
    expect(storedJob().residue).toMatchObject({ amount: "25170000", returning: true });
  });

  it("waits for the refund even when the payment left a residue worth sending", async () => {
    const first = await engineWith({});
    await first.startWithdraw(usdtHandoff());
    const job = storedJob();
    Object.assign(job, { landed: true, phase: "handoff" });
    job.state.fundsSeenAt = NOW - 60_000;
    job.leg.exact.balanceBefore = "26500000"; // what the key held as the payment left
    const engine = await engineWith({ "s-1": job });
    mocks.keyUsdt = 1_500_000n;
    await engine.tickAllWithdraw(); // the key pays the provider, 1.5 USDT left on it
    mocks.status.mockResolvedValue({
      status: "failed",
      depositFailure: { reason: { code: "failed" }, kind: "unknown" },
    });
    await engine.tickAllWithdraw(); // any failure once paid may still be refunded
    expect(storedJob().residue).toBeUndefined();
    expect(mocks.startFunding).not.toHaveBeenCalled();
    mocks.keyUsdt = 26_500_000n; // the refund lands on top of the residue
    waitOut(HOUR);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toMatchObject({ amount: "26500000", returning: true });
  });

  it("leaves a refund that never reaches the key for a person after two weeks", async () => {
    const engine = await landed();
    await engine.tickAllWithdraw();
    mocks.status.mockResolvedValue(refunded);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    expect(storedJob().providerRefundSince).toBe(NOW);
    vi.setSystemTime(NOW + 14 * DAY - HOUR);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toBeUndefined();
    vi.setSystemTime(NOW + 14 * DAY);
    await engine.tickAllWithdraw();
    expect(storedJob().residue).toEqual({ amount: "0", returning: false, stuck: true });
    expect(mocks.startFunding).not.toHaveBeenCalled();
    // The refund comes after all, inside the key's watch.
    mocks.keyUsdt = 25_000_000n;
    vi.setSystemTime(NOW + 14 * DAY + 60 * 60 * 1000);
    await engine.tickAllWithdraw();
    expect(mocks.startFunding.mock.calls[0]![0]).toMatchObject({ sessionId: "s-1/residue/1" });
    expect(storedJob().residue).toMatchObject({ amount: "25000000", returning: true, round: 1 });
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
