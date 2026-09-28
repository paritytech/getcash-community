// How the withdraw engine handles a key whose CASH cannot buy the fees' PAS. The tick is mocked
// to throw WithdrawUnderfundedError; the engine and its stored records are real. The job fails
// only once the whole payment is on the key. Before that the rest may still be arriving, and
// failing early would strand it on a key nothing sizes again.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  tick: vi.fn(),
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

// No chain is reached: the tick is the mocked seam.
vi.mock("../worker/src/shared.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  keypairFor: async () => ({ address: "5Key", publicKey: new Uint8Array(32).fill(7), signer: {} }),
  connectChain: async () => ({ getTypedApi: () => ({}), destroy: () => {} }),
  signOptionsFor: async () => ({}),
}));

vi.mock("@getsome/withdraw", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withdrawTickOnce: mocks.tick,
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
const NOW = Date.now();
const AMOUNT = 21_000_000n;

function paidJob(): StoredJob {
  return {
    v: 1,
    sessionId: "s-1",
    label: "wd:eph:direct:1",
    keyAddress: "5Key",
    keyPublicKeyHex: hash32(0x07),
    amount: AMOUNT.toString(),
    destination: { chain: "Polkadot", asset: "DOT", address: "5Dest" },
    landingHex: hash32(0xaa),
    rail: "direct",
    assetHubGenesis: hash32(0x11),
    peopleGenesis: hash32(0x22),
    peopleParaId: 1004,
    assetHubParaId: 1000,
    poolAccount: "5Pool",
    slippagePct: 5,
    paymentExpiresAt: NOW + 86_400_000,
    phase: "await-cash",
    landed: false,
    done: false,
    createdAt: NOW,
    armedAt: NOW,
    lastTickAt: null,
    state: {
      attempts: 0,
      rejections: 0,
      submitted: false,
      destinationPasBefore: null,
      expectedLanding: null,
      fundsSeenAt: null,
      workedMs: 0,
    },
    txs: [],
  };
}

async function engineWith(job: StoredJob): Promise<Engine> {
  mocks.stored.set(WITHDRAW_KEY, { "s-1": job });
  vi.resetModules();
  return await import("../worker/src/withdraw-engine.js");
}

const storedJob = (): StoredJob =>
  (mocks.stored.get(WITHDRAW_KEY) as Record<string, StoredJob>)["s-1"]!;

describe("the withdraw engine and an underfunded key", () => {
  beforeEach(() => {
    mocks.stored.clear();
    mocks.tick.mockReset();
  });

  it("fails the job 'underfunded' once the whole payment is on the key", async () => {
    const { WithdrawUnderfundedError } = await import("@getsome/withdraw");
    mocks.tick.mockRejectedValue(new WithdrawUnderfundedError(AMOUNT, 1_041_559_000n));
    const engine = await engineWith(paidJob());
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "underfunded" });
  });

  it("keeps waiting while only part of the payment has reached the key", async () => {
    const { WithdrawUnderfundedError } = await import("@getsome/withdraw");
    mocks.tick.mockRejectedValue(new WithdrawUnderfundedError(AMOUNT / 100n, 1_041_559_000n));
    const engine = await engineWith(paidJob());
    await engine.tickAllWithdraw();
    const job = storedJob();
    expect(job.phase).not.toBe("failed");
    expect(job.failure).toBeUndefined();
    expect(job.lastError).toContain("cannot buy");
  });
});
