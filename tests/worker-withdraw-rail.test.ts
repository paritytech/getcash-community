// The worker's rail leg, offline: the provider and the hand that pays it are scripted, the leg
// itself and the records are real. What this pins is the glue the leg's own tests cannot see:
// which failure the engine writes when the provider's channel has closed, and that nothing is
// paid on the way there.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stableTxOptions } from "@getsome/funding";

const mocks = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  railFor: vi.fn(),
  payRail: vi.fn(),
  status: vi.fn(),
  channel: vi.fn(),
  /** What the key holds on Asset Hub, in whichever token the hand that pays reads. */
  keyHolds: 0n,
  /** The transfers the hand that pays signed, when it is the real one. */
  submits: [] as { pallet: string; args: unknown; options: unknown }[],
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

// The provider and the sweep are the seams; the leg between them is the code under test.
vi.mock("../worker/src/providers.js", () => ({
  PAY_TIMEOUT_MS: 300_000,
  railFor: mocks.railFor,
  payRail: mocks.payRail,
}));

// Where a test lets the real hand pay, the chain it pays on is scripted: the key's holding and
// a transfer that records what it was asked to sign.
vi.mock("../worker/src/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker/src/shared.js")>();
  const transferAll = (pallet: string) => (args: unknown) => ({
    signAndSubmit: async (_signer: unknown, options: unknown) => {
      mocks.submits.push({ pallet, args, options });
      return { ok: true, txHash: "0x1", block: { number: 7 } };
    },
  });
  return {
    ...actual,
    keypairFor: async () => ({ address: "5Key", signer: {} }),
    connectChain: async () => ({
      getBestBlocks: async () => [{ hash: "0xbest", number: 1 }],
      getTypedApi: () => ({
        query: { Assets: { Account: { getValue: async () => ({ balance: mocks.keyHolds }) } } },
        tx: {
          Balances: { transfer_all: transferAll("Balances") },
          Assets: { transfer_all: transferAll("Assets") },
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

/** A job whose message leg is done: the sale's token is on the key, the channel is still to be
 *  paid. */
function landedJob(
  overrides: { leg?: unknown; channel?: unknown; sale?: Record<string, unknown> } = {},
): StoredJob {
  const channel = {
    id: "ch-1",
    address: "5Channel",
    openedAt: NOW - DAY,
    expiresAt: NOW + DAY,
    expectedEgress: "123456",
  };
  return {
    v: 1,
    sessionId: "s-1",
    label: "wd:eph:btc:1",
    keyAddress: "5Key",
    keyPublicKeyHex: hash32(0x07),
    amount: "21000000",
    destination: { chain: "Bitcoin", asset: "BTC", address: "bc1qw508" },
    landingHex: hash32(0x07),
    rail: "chainflip",
    ...(overrides.sale ?? { tier: "pool" }),
    assetHubGenesis: hash32(0x11),
    peopleGenesis: hash32(0x22),
    peopleParaId: 1004,
    assetHubParaId: 1000,
    poolAccount: "5Pool",
    slippagePct: 5,
    paymentExpiresAt: NOW + DAY,
    channel: overrides.channel === undefined ? channel : overrides.channel,
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
            sweep: { attempts: 0, rejections: 0 },
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
    mocks.railFor.mockReset();
    mocks.payRail.mockReset();
    mocks.status.mockReset();
    mocks.channel.mockReset();
    // The provider's record of the channel agrees with the job unless a test says otherwise.
    mocks.channel.mockResolvedValue({
      depositAddress: "5Channel",
      destinationAddress: "bc1qw508",
      expired: false,
    });
    mocks.railFor.mockReturnValue({ status: mocks.status, channel: mocks.channel });
    mocks.payRail.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({ status: "swapping" });
    mocks.keyHolds = 0n;
    mocks.submits.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps the USDT a PSM sale landed to the channel, the fee charged in it", async () => {
    const { payRail } = await vi.importActual<typeof import("../worker/src/providers.js")>(
      "../worker/src/providers.js",
    );
    mocks.payRail.mockImplementation(payRail);
    mocks.keyHolds = 20_000_000n;
    const engine = await engineWith(
      landedJob({ sale: { tier: "psm", external: "USDT", feeRate: 5_000 } }),
    );

    await engine.tickAllWithdraw();
    expect(mocks.submits).toEqual([
      {
        pallet: "Assets",
        args: { id: 1984, dest: { type: "Id", value: "5Channel" }, keep_alive: false },
        options: { ...stableTxOptions("USDT"), at: "0xbest" },
      },
    ]);
    expect(storedJob()).toMatchObject({ phase: "handoff", leg: { paid: true } });
    expect(storedJob().txs).toEqual([{ call: "sweep", txHash: "0x1", block: 7 }]);
  });

  it("pays a channel that is open, and follows the swap after it", async () => {
    const engine = await engineWith(landedJob());
    await engine.tickAllWithdraw();
    expect(mocks.payRail).toHaveBeenCalledTimes(1);
    expect(storedJob()).toMatchObject({ phase: "handoff", leg: { paid: true } });

    await engine.tickAllWithdraw();
    expect(mocks.payRail).toHaveBeenCalledTimes(1); // never paid twice
    expect(storedJob()).toMatchObject({
      phase: "follow",
      leg: { reading: { status: "swapping" } },
    });
  });

  it("refuses a closed channel, pays nothing, and fails the job retryably", async () => {
    const job = landedJob();
    job.leg.handoff.expiresAt = NOW - 1;
    job.channel.expiresAt = NOW - 1;
    const engine = await engineWith(job);

    await engine.tickAllWithdraw();
    expect(mocks.payRail).not.toHaveBeenCalled();
    const stored = storedJob();
    expect(stored).toMatchObject({ phase: "failed", failure: "channel-expired" });
    expect(stored.lastError).toMatch(/channel ch-1 closes at/);
    // Nothing moved, so the leg is still unpaid and a fresh channel can carry it.
    expect(stored.leg.paid).toBe(false);
    expect(stored.txs).toEqual([]);
  });

  it("holds a job to the record's channel when its leg was stored without an expiry", async () => {
    // A job written before the leg carried the expiry: the record still knows it.
    const job = landedJob({
      leg: {
        handoff: { id: "ch-1", address: "5Channel", openedAt: NOW - DAY },
        paid: false,
        sweep: { attempts: 0, rejections: 0 },
        reading: null,
      },
    });
    job.channel.expiresAt = NOW - 1;
    const engine = await engineWith(job);

    await engine.tickAllWithdraw();
    expect(mocks.payRail).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "channel-expired" });
  });

  it("pays a job whose channel named no expiry at all", async () => {
    const job = landedJob();
    job.leg.handoff.expiresAt = 0;
    job.channel.expiresAt = 0;
    const engine = await engineWith(job);

    await engine.tickAllWithdraw();
    expect(mocks.payRail).toHaveBeenCalledTimes(1);
    expect(storedJob().phase).toBe("handoff");
    expect(storedJob().failure).toBeUndefined();
  });

  it("re-arms a job the channel closed under, and pays the fresh channel", async () => {
    const job = landedJob();
    job.leg.handoff.expiresAt = NOW - 1;
    job.channel.expiresAt = NOW - 1;
    const engine = await engineWith(job);
    await engine.tickAllWithdraw();
    expect(storedJob().failure).toBe("channel-expired");

    // What the surface's retry sends: the same job, carrying the channel it just opened.
    const fresh = {
      id: "ch-2",
      address: "5Fresh",
      openedAt: NOW,
      expiresAt: NOW + DAY,
      expectedEgress: "123456",
    };
    const stored = storedJob();
    await engine.startWithdraw(
      JSON.stringify({
        sessionId: "s-1",
        keyAddress: stored.keyAddress,
        channel: fresh,
        paymentExpiresAt: NOW + DAY,
      }),
    );
    expect(storedJob()).toMatchObject({
      phase: "starting",
      channel: { id: "ch-2" },
      leg: { handoff: { id: "ch-2", expiresAt: NOW + DAY }, paid: false },
    });

    // The provider knows the fresh channel, at its own address.
    mocks.channel.mockResolvedValue({
      depositAddress: "5Fresh",
      destinationAddress: "bc1qw508",
      expired: false,
    });
    await engine.tickAllWithdraw();
    expect(mocks.payRail).toHaveBeenCalledTimes(1);
    expect(mocks.payRail.mock.calls[0]?.[1]).toMatchObject({ id: "ch-2", address: "5Fresh" });
    expect(storedJob()).toMatchObject({ phase: "handoff", leg: { paid: true } });
  });

  it("refuses when the provider's record of the channel disagrees, and pays nothing", async () => {
    mocks.channel.mockResolvedValue({
      depositAddress: "5SomewhereElse",
      destinationAddress: "bc1qw508",
      expired: false,
    });
    const engine = await engineWith(landedJob());

    await engine.tickAllWithdraw();
    expect(mocks.payRail).not.toHaveBeenCalled();
    const stored = storedJob();
    expect(stored).toMatchObject({ phase: "failed", failure: "channel-mismatch" });
    expect(stored.lastError).toMatch(/takes deposits at 5SomewhereElse/);
    expect(stored.leg.paid).toBe(false);
    expect(stored.txs).toEqual([]);
  });

  it("checks the address the user asked for, not just the one it is about to pay", async () => {
    mocks.channel.mockResolvedValue({
      depositAddress: "5Channel",
      destinationAddress: "bc1qsomeoneelse",
      expired: false,
    });
    const engine = await engineWith(landedJob());

    await engine.tickAllWithdraw();
    expect(mocks.payRail).not.toHaveBeenCalled();
    expect(storedJob().lastError).toMatch(/pays out to bc1qsomeoneelse/);
  });

  it("keeps a job whose provider cannot be reached for the next tick, unpaid", async () => {
    mocks.channel.mockRejectedValue(new Error("provider unreachable"));
    const engine = await engineWith(landedJob());

    await engine.tickAllWithdraw();
    expect(mocks.payRail).not.toHaveBeenCalled();
    const stored = storedJob();
    // Transient: the job is still live and the next tick asks again.
    expect(stored.phase).toBe("handoff");
    expect(stored.failure).toBeUndefined();
    expect(stored.lastError).toMatch(/provider unreachable/);
  });
});
