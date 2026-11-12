// A swap sale's sweep and Chainflip's refund, with the real settling of the payment: the sweep
// empties the key and a failed swap fills it again, so the key alone must never decide that a
// sweep was not sent. Were it to, the worker would sweep the refund back into the channel.

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
  /** The key's USDT on Asset Hub. */
  keyUsdt: 0n,
  best: 100,
  finalized: 98,
  /** The hash the finalized chain holds for the sweep's block. */
  blockHash: "0xseen" as string | undefined,
}));

vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  proveLitePersonhood: vi.fn(),
  getHostLocalStorage: async () => ({
    readJSON: async (key: string) => {
      const value = mocks.stored.get(key);
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
    writeJSON: async (key: string, value: unknown) => {
      mocks.stored.set(key, JSON.parse(JSON.stringify(value)));
    },
  }),
}));

// The payment's settling is the real one; paying and the provider are scripted.
vi.mock("../worker/src/providers.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
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

vi.mock("@getsome/withdraw", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withdrawTickOnce: mocks.withdrawTickOnce,
}));

vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chooseCashTransfer: async () => "teleport",
  chooseRoute: async () => ({ tier: "pool", external: "USDT" }),
}));

vi.mock("../worker/src/shared.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  keypairFor: async () => ({ address: "5Key", signer: {} }),
  connectChain: async () => ({
    getBestBlocks: async () => [{ hash: "0xbest", number: mocks.best }],
    getFinalizedBlock: async () => ({ hash: "0xfin", number: mocks.finalized }),
    getTypedApi: () => ({
      query: {
        Assets: {
          Account: {
            getValue: (id: number) =>
              Promise.resolve({ balance: id === 1984 ? mocks.keyUsdt : 0n }),
          },
          Asset: { getValue: () => Promise.resolve({ min_balance: 70_000n }) },
        },
        System: {
          Account: { getValue: () => Promise.resolve({ data: { free: 0n }, nonce: 0 }) },
          Number: {
            getValue: (options?: { at?: string }) =>
              Promise.resolve(options?.at === "finalized" ? mocks.finalized : mocks.best),
          },
          BlockHash: { getValue: () => Promise.resolve(mocks.blockHash) },
        },
      },
    }),
    destroy: () => {},
  }),
}));

type Engine = typeof import("../worker/src/withdraw-engine.js");
type StoredJob = Record<string, any>;

const WITHDRAW_KEY = "getsome.withdraw.jobs";
const hash32 = (fill: number) => `0x${fill.toString(16).padStart(2, "0").repeat(32)}`;
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const DAY = 86_400_000;
const SOLANA_DEPOSIT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CF_DEPOSIT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
/** What Chainflip refunds to the key once the swap failed: the sweep less its fees. */
const REFUND = 99_000_000n;
const FAILED = { status: "failed", raw: "FAILED", refundEgress: { witnessedAt: 1 } };

const handoff = () => ({
  sessionId: "s-1",
  label: "wd:eph:meld-bank:1",
  keyAddress: "5Key",
  keyPublicKeyHex: hash32(0x07),
  amount: "100000000",
  destination: { chain: "Bank transfer", asset: "EUR", address: "" },
  landingHex: hash32(0x07),
  rail: "meld",
  tier: "psm",
  external: "USDT",
  feeRate: 1000,
  assetHubGenesis: hash32(0x11),
  peopleGenesis: hash32(0x22),
  peopleParaId: 1004,
  assetHubParaId: 1000,
  poolAccount: "5Pool",
  slippagePct: 5,
  paymentExpiresAt: NOW + DAY,
  channel: {
    id: "funding-sell-1",
    address: SOLANA_DEPOSIT,
    openedAt: NOW - 60_000,
    expiresAt: 0,
    expectedEgress: "9012",
    amount: "98850000",
  },
  swap: {
    id: "cf-channel-7",
    address: CF_DEPOSIT,
    openedAt: NOW - 60_000,
    expiresAt: NOW + DAY,
    expectedEgress: "99150000",
    amount: "99800000",
  },
  meld: { baseUrl: "https://adapter.test", productId: "getcash.dev" },
});

async function engineWith(jobs: Record<string, StoredJob>): Promise<Engine> {
  mocks.stored.set(WITHDRAW_KEY, jobs);
  vi.resetModules();
  return await import("../worker/src/withdraw-engine.js");
}

const storedJob = (): StoredJob =>
  (mocks.stored.get(WITHDRAW_KEY) as Record<string, StoredJob>)["s-1"]!;

/** A swap sale whose message leg is done and whose sweep into the channel left. */
async function sweptJob(): Promise<StoredJob> {
  const first = await engineWith({});
  await first.startWithdraw(handoff());
  const job = storedJob();
  Object.assign(job, { landed: true, phase: "handoff" });
  job.state.fundsSeenAt = NOW - 60_000;
  job.leg.sweep = { attempts: 1, rejections: 0 };
  return job;
}

describe("a swap sale's sweep and the refund of its swap", () => {
  beforeEach(() => {
    mocks.stored.clear();
    for (const fn of [mocks.railFor, mocks.payRail, mocks.status, mocks.channel]) fn.mockReset();
    mocks.channel.mockResolvedValue({
      depositAddress: CF_DEPOSIT,
      destinationAddress: SOLANA_DEPOSIT,
      expired: false,
    });
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.payRail.mockResolvedValue(undefined);
    mocks.fundingStatus.mockResolvedValue({ phase: "convert", claim: null });
    Object.assign(mocks, { keyUsdt: 0n, best: 100, finalized: 98, blockHash: "0xseen" });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("takes a sweep whose answer was lost as paid without watching it, so a later refund is read as the swap's, not swept again", async () => {
    const engine = await engineWith({ "s-1": await sweptJob() });
    await engine.tickAllWithdraw();
    expect(storedJob().leg).toMatchObject({ paid: true });
    expect(storedJob().leg.sweep.seen).toBeUndefined();

    // The swap failed and Chainflip refunded the USDT to the key; finality has moved on.
    mocks.status.mockResolvedValue(FAILED);
    Object.assign(mocks, { keyUsdt: REFUND, finalized: 100, best: 103 });
    await engine.tickAllWithdraw();
    expect(mocks.payRail).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "rail-failed" });
  });

  it("stands on a sweep whose block the chain no longer names, though a refund filled the key again", async () => {
    const job = await sweptJob();
    job.leg.paid = true;
    job.leg.sweep.seen = { number: 99, hash: "0xseen" };
    mocks.status.mockResolvedValue(FAILED);
    // The worker was away past the chain's memory of block hashes, and the refund came meanwhile.
    Object.assign(mocks, {
      keyUsdt: REFUND,
      finalized: 9_000,
      best: 9_003,
      blockHash: `0x${"00".repeat(32)}`,
    });
    const engine = await engineWith({ "s-1": job });
    await engine.tickAllWithdraw();
    expect(mocks.payRail).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "rail-failed" });
    expect(storedJob().leg).toMatchObject({ paid: true, sweep: { seen: null } });
  });
});
