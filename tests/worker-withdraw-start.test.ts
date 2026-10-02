// The worker's intake of a withdrawal hand-off: the sale it names is kept on the job as the
// surface froze it, and a hand-off without one, or with a tier this engine cannot sell through,
// is refused before anything is stored.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveKeypairWithSecret } from "@getsome/ephemeral";

const mocks = vi.hoisted(() => ({ stored: new Map<string, unknown>() }));

vi.mock("../worker/src/host.js", () => ({
  // Every label derives the same key; the test signs nothing.
  deriveEntropy: async () => ({ ok: true, value: new Uint8Array(32).fill(7) }),
  getHostProvider: vi.fn(),
  getHostLocalStorage: async () => ({
    readJSON: async (key: string) => mocks.stored.get(key) ?? null,
    writeJSON: async (key: string, value: unknown) => {
      mocks.stored.set(key, JSON.parse(JSON.stringify(value)));
    },
  }),
}));
vi.mock("../worker/src/providers.js", () => ({ railFor: vi.fn(), payRail: vi.fn() }));
vi.mock("@polkadot-api/descriptors", () => ({
  paseo_next_v2: { fake: "asset-hub" },
  paseo_people_next: { fake: "people" },
}));
vi.mock("@getsome/people", () => ({ CASH_LOCATION: { fake: "cash" } }));

type StoredJob = Record<string, unknown>;

const WITHDRAW_KEY = "getsome.withdraw.jobs";
const hash32 = (fill: number) => `0x${fill.toString(16).padStart(2, "0").repeat(32)}`;
const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
const KEY = deriveKeypairWithSecret(new Uint8Array(32).fill(7));

/** A direct hand-off as the page sends it, with the sale fields of `sale` on top. */
const handoff = (sale: Record<string, unknown>) => ({
  sessionId: "s-1",
  label: "wd:eph:usdc-assethub:1",
  keyAddress: KEY.address,
  keyPublicKeyHex: toHex(KEY.publicKey),
  amount: "21000000",
  destination: {
    chain: "Asset Hub",
    asset: "USDC",
    address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
  },
  landingHex: hash32(0xaa),
  rail: "direct",
  assetHubGenesis: hash32(0x11),
  peopleGenesis: hash32(0x22),
  peopleParaId: 1004,
  assetHubParaId: 1000,
  poolAccount: "5Pool",
  slippagePct: 5,
  paymentExpiresAt: Date.now() + 3_600_000,
  ...sale,
});

const storedJobs = () => (mocks.stored.get(WITHDRAW_KEY) ?? {}) as Record<string, StoredJob>;

async function freshEngine() {
  vi.resetModules();
  return await import("../worker/src/withdraw-engine.js");
}

describe("the worker's intake of a withdrawal", () => {
  beforeEach(() => {
    mocks.stored.clear();
  });

  it("keeps the sale the hand-off names, as the surface froze it", async () => {
    const engine = await freshEngine();
    const answer = await engine.startWithdraw(
      JSON.stringify(handoff({ tier: "pool", external: "USDC" })),
    );
    expect(answer).toMatchObject({ sessionId: "s-1", phase: "starting" });
    expect(storedJobs()["s-1"]).toMatchObject({ tier: "pool", external: "USDC", rail: "direct" });
  });

  it("refuses a hand-off without a sale, a tier it cannot sell through and a stable it does not know, storing nothing", async () => {
    const engine = await freshEngine();
    expect(await engine.startWithdraw(JSON.stringify(handoff({})))).toMatchObject({
      error: "invalid",
      reason: expect.stringMatching(/sale tier is required/),
    });
    expect(
      await engine.startWithdraw(
        JSON.stringify(handoff({ tier: "psm", external: "USDT", feeRate: 5_000 })),
      ),
    ).toMatchObject({ error: "invalid", reason: expect.stringMatching(/psm tier/) });
    expect(
      await engine.startWithdraw(JSON.stringify(handoff({ tier: "pool", external: "EUR" }))),
    ).toMatchObject({ error: "invalid", reason: expect.stringMatching(/unknown deposit asset/) });
    expect(storedJobs()).toEqual({});
  });
});
