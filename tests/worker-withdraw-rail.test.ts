// The worker's rail leg, offline: the provider and the hand that pays it are scripted, the leg
// itself and the records are real. What this pins is the glue the leg's own tests cannot see:
// which failure the engine writes when the provider's channel has closed, and that nothing is
// paid on the way there.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  railFor: vi.fn(),
  payRail: vi.fn(),
  status: vi.fn(),
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
  railFor: mocks.railFor,
  payRail: mocks.payRail,
}));

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

/** A job whose message leg is done: the native is on the key, the channel is still to be paid. */
function landedJob(overrides: { leg?: unknown; channel?: unknown } = {}): StoredJob {
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
      destinationPasBefore: "0",
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
    mocks.railFor.mockReturnValue({ status: mocks.status });
    mocks.payRail.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({ status: "swapping" });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
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

    await engine.tickAllWithdraw();
    expect(mocks.payRail).toHaveBeenCalledTimes(1);
    expect(mocks.payRail.mock.calls[0]?.[1]).toMatchObject({ id: "ch-2", address: "5Fresh" });
    expect(storedJob()).toMatchObject({ phase: "handoff", leg: { paid: true } });
  });
});
