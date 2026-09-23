// The worker withdrawal engine, offline: chain and pipeline seams are scripted, records and
// derivation are real. Mirrors tests/worker-engine.test.ts in style.

import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveKeypair } from "@getsome/ephemeral";

const mocks = vi.hoisted(() => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  stored: new Map<string, unknown>(),
  storageDown: false,
  withdrawTickOnce: vi.fn(),
}));

// The worker's host adapter is the seam to mock; the SDK behind it never loads here.
vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: mocks.deriveEntropy,
  getHostProvider: mocks.getHostProvider,
  getHostLocalStorage: async () => ({
    readJSON: async (key: string) => {
      if (mocks.storageDown) throw new Error("storage down");
      return mocks.stored.get(key) ?? null;
    },
    writeJSON: async (key: string, value: unknown) => {
      if (mocks.storageDown) throw new Error("storage down");
      mocks.stored.set(key, JSON.parse(JSON.stringify(value)));
    },
  }),
}));

// Only the tick itself is mocked; everything else (state persistence, the burner reader, the
// tick's own contracts) is the real package, so persistence and wiring are genuinely exercised.
vi.mock("@getsome/withdraw", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withdrawTickOnce: mocks.withdrawTickOnce,
}));

/** A 32-byte hash of one repeated byte. */
const hash32 = (fill: number) => `0x${fill.toString(16).padStart(2, "0").repeat(32)}`;
const ASSET_HUB_GENESIS = hash32(0x11);
const PEOPLE_GENESIS = hash32(0x22);
const BEST_BLOCK = hash32(0x33);

/** One fake typed API per chain, told apart by the client's own genesis (captured on the fake
 *  provider `connectChain` verifies against) — not by descriptor identity, which a `vi.resetModules`
 *  reload cannot be relied on to preserve across the test file's own import of the descriptors
 *  package. So the worker's own dispatch (asset hub API for the Asset Hub client, people API for
 *  the People one) is what is under test, not a mock shortcut. */
const assetHubApiFake = {
  query: {
    System: {
      Account: {
        getValue: async () => ({ data: { free: 42_000_000n }, nonce: 3 }),
      },
    },
  },
};
const peopleApiFake = { fake: "people-api" };

vi.mock("polkadot-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createClient: (provider: { genesis: string }) => ({
    getChainSpecData: async () => ({ genesisHash: provider.genesis }),
    getBestBlocks: async () => [{ hash: BEST_BLOCK }],
    getTypedApi: () => (provider.genesis === ASSET_HUB_GENESIS ? assetHubApiFake : peopleApiFake),
    destroy: () => {},
  }),
}));

const SEED = new Uint8Array(32).fill(9);
const KEY = deriveKeypair(SEED);
const KEY_HEX = `0x${Array.from(KEY.publicKey, (b) => b.toString(16).padStart(2, "0")).join("")}`;

const DESTINATION = { chain: "Asset Hub", asset: "PAS", address: "dest" };

const HANDOFF = {
  sessionId: "s-1",
  label: "wd:eph:pas-assethub:1",
  keyAddress: KEY.address,
  keyPublicKeyHex: KEY_HEX,
  amount: "21000000",
  destination: DESTINATION,
  landingHex: KEY_HEX,
  rail: "direct",
  assetHubGenesis: ASSET_HUB_GENESIS,
  peopleGenesis: PEOPLE_GENESIS,
  peopleParaId: 1502,
  assetHubParaId: 1500,
  poolAccount: "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B",
  slippagePct: 5,
  paymentExpiresAt: Date.now() + 1_800_000,
};

const MELD = {
  committedAmount: "900000000",
  providerPayoutAddress: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
  orderRef: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  meldFundingRequestId: "funding-req-1",
  quotedFiatAmount: "156.30",
  quotedFiatCurrency: "USD",
  cryptoCurrency: "DOT_ASSETHUB",
};

const MELD_HANDOFF = { ...HANDOFF, rail: "meld", meld: MELD };

type Engine = typeof import("../worker/src/withdraw-engine.js");
type StoredJob = { [key: string]: any };

/** Fresh engine module (module-scope caches reset), same persistent "host storage" — this is what
 *  stands in for a worker reload across the test. */
async function freshEngine(): Promise<Engine> {
  vi.resetModules();
  return await import("../worker/src/withdraw-engine.js");
}

const storedJob = (): StoredJob =>
  (mocks.stored.get("getsome.withdraw.jobs") as { [id: string]: StoredJob })["s-1"];

const outcome = (step: string, submitted = false) => ({
  step,
  balances: { cash: 0n, pas: 0n },
  submitted,
});

function armSeams() {
  mocks.deriveEntropy.mockReset();
  mocks.getHostProvider.mockReset();
  mocks.withdrawTickOnce.mockReset();
  mocks.deriveEntropy.mockResolvedValue({ ok: true, value: SEED });
  mocks.getHostProvider.mockImplementation(async (genesis: string) => ({ genesis }));
  mocks.stored.clear();
  mocks.storageDown = false;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("worker withdrawal engine: meld rail", () => {
  it("accepts a meld hand-off and refuses one missing its sale details", async () => {
    armSeams();
    const engine = await freshEngine();
    const started = await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));
    expect(started).toMatchObject({ sessionId: "s-1", phase: "starting" });
    expect(storedJob()).toMatchObject({ rail: "meld", meld: MELD });

    const noMeld = await engine.startWithdraw(
      JSON.stringify({ ...HANDOFF, sessionId: "s-2", rail: "meld" }),
    );
    expect(noMeld).toMatchObject({ error: "invalid" });
    expect(noMeld.reason).toContain("sale details");

    const missingField = await engine.startWithdraw(
      JSON.stringify({
        ...MELD_HANDOFF,
        sessionId: "s-3",
        meld: { ...MELD, providerPayoutAddress: "" },
      }),
    );
    expect(missingField).toMatchObject({ error: "invalid" });
    expect(missingField.reason).toContain("providerPayoutAddress");

    const badAmount = await engine.startWithdraw(
      JSON.stringify({
        ...MELD_HANDOFF,
        sessionId: "s-4",
        meld: { ...MELD, committedAmount: "0" },
      }),
    );
    expect(badAmount).toMatchObject({ error: "invalid" });
    expect(badAmount.reason).toContain("committedAmount");
  });

  it("refuses a payout address that does not decode to an Asset Hub account, before anything is watched", async () => {
    // Both surface call sites canonicalise before this is ever reached, but the worker checks it
    // too: a bad value that got here anyway must be refused outright, not surface deep inside a
    // dry run as a plain exception `tickAllWithdraw` would retry forever, never counting against
    // `payAttempts` since that only advances past a passing dry run.
    armSeams();
    const engine = await freshEngine();
    const refused = await engine.startWithdraw(
      JSON.stringify({
        ...MELD_HANDOFF,
        sessionId: "s-5",
        meld: { ...MELD, providerPayoutAddress: "not an address" },
      }),
    );
    expect(refused).toMatchObject({ error: "invalid" });
    expect(refused.reason).toContain("providerPayoutAddress");
    expect(refused.reason).toContain("not a valid Asset Hub account");
    // A refused hand-off never lands in the job store at all.
    expect(mocks.stored.get("getsome.withdraw.jobs")).toBeUndefined();
  });

  it("still refuses an unknown rail, unaffected by meld's addition", async () => {
    armSeams();
    const engine = await freshEngine();
    const refused = await engine.startWithdraw(
      JSON.stringify({ ...HANDOFF, rail: "unknown-rail" }),
    );
    expect(refused).toMatchObject({ error: "invalid" });
    expect(refused.reason).toContain("direct, chainflip or meld");
  });

  it("gives the tick a commitment, the same signer paired with it, the burner reader and an Asset Hub anchor", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));
    mocks.withdrawTickOnce.mockResolvedValueOnce(outcome("await-cash"));
    await engine.tickAllWithdraw();

    const meldInput = mocks.withdrawTickOnce.mock.calls[0][0];
    expect(meldInput.commitment).toEqual({
      planck: 900_000_000n,
      payoutAddress: MELD.providerPayoutAddress,
    });
    // Paired, never one without the other: the tick refuses a commitment with no signer (see
    // packages/withdraw/src/tick.test.ts), so the worker must never hand it one alone.
    expect(meldInput.key.assetHubSigner).toBeDefined();
    expect(meldInput.key.assetHubSigner).toBe(meldInput.key.signer);
    expect(meldInput.assetHubSignOptions).toEqual({ at: BEST_BLOCK });
    expect(typeof meldInput.readBurnerOnAssetHub).toBe("function");
    // The reader is genuinely wired to the Asset Hub api, not a stand-in: it answers from the
    // fake asset-hub account, not the people one.
    await expect(meldInput.readBurnerOnAssetHub(KEY_HEX)).resolves.toEqual({
      free: 42_000_000n,
      nonce: 3,
    });
  });

  it("leaves the self-custody path exactly as it was: no commitment, no Asset Hub signer, no burner reader", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startWithdraw(JSON.stringify(HANDOFF));
    mocks.withdrawTickOnce.mockResolvedValueOnce(outcome("await-cash"));
    await engine.tickAllWithdraw();

    const directInput = mocks.withdrawTickOnce.mock.calls[0][0];
    expect(directInput.commitment).toBeUndefined();
    expect(directInput.key.assetHubSigner).toBeUndefined();
    expect(directInput.readBurnerOnAssetHub).toBeUndefined();
    expect(directInput.assetHubSignOptions).toBeUndefined();
  });

  it("drives a meld withdrawal to pay-provider and persists the phase", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));
    mocks.withdrawTickOnce.mockResolvedValueOnce(outcome("pay-provider", true));
    await engine.tickAllWithdraw();
    expect(storedJob().phase).toBe("pay-provider");
    expect(storedJob().done).toBe(false);

    mocks.withdrawTickOnce.mockResolvedValueOnce(outcome("done"));
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "done", done: true });
  });

  it("round-trips the pinned nonce and the payment fields through a simulated reload", async () => {
    armSeams();
    const started = await freshEngine();
    await started.startWithdraw(JSON.stringify(MELD_HANDOFF));
    mocks.withdrawTickOnce.mockImplementationOnce(async (_input: unknown, state: any) => {
      // What payProvider itself would have set, taken as given here: this test is about the
      // engine's persistence, not the package's own pin logic (see tick.test.ts for that).
      state.payNonce = 3;
      state.payAmount = 900_000_000n;
      state.payFreeBefore = 950_000_000n;
      state.payAttempts = 1;
      return outcome("pay-provider", true);
    });
    await started.tickAllWithdraw();
    // Persisted boxed, generically — the whole point of the package's own serialiser.
    expect(storedJob().state.payNonce).toBe(3);
    expect(storedJob().state.payAmount).toEqual({ $bigint: "900000000" });

    // The reload: a fresh module, no memory but the store.
    const revived = await freshEngine();
    mocks.withdrawTickOnce.mockImplementationOnce(async (_input: unknown, state: any) => {
      // The pin survived the round trip untouched.
      expect(state.payNonce).toBe(3);
      expect(state.payAmount).toBe(900_000_000n);
      expect(state.payFreeBefore).toBe(950_000_000n);
      expect(state.payAttempts).toBe(1);
      return outcome("pay-provider", false);
    });
    await revived.tickAllWithdraw();
  });

  it("never lets a second pass run concurrently with the first (single writer)", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));
    let release: (() => void) | null = null;
    mocks.withdrawTickOnce.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(outcome("await-cash"));
        }),
    );
    const first = engine.tickAllWithdraw();
    // Let the first pass actually reach the (mocked) tick before racing a second entry against
    // it -- `ticking` is set synchronously at the top of tickAllWithdraw, well before this point.
    await vi.waitFor(() => expect(mocks.withdrawTickOnce).toHaveBeenCalledTimes(1));
    // A pass already running answers a concurrent entry with busy, and ticks nothing.
    await expect(engine.tickAllWithdraw()).resolves.toEqual({ ticked: 0, busy: true });
    release!();
    await first;
    // The concurrent entry never reached the tick at all -- only the first pass drove it.
    expect(mocks.withdrawTickOnce).toHaveBeenCalledTimes(1);
  });
});

describe("packages/withdraw contract the worker's wiring depends on", () => {
  it("refuses a commitment with no Asset Hub signer, before anything is signed", async () => {
    // The real package, not the mock above: this pins the contract the wiring test relies on —
    // that pairing commitment with assetHubSigner is not optional, it is what the tick enforces.
    const real = await vi.importActual<typeof import("@getsome/withdraw")>("@getsome/withdraw");
    await expect(
      real.withdrawTickOnce(
        {
          peopleApi: peopleApiFake as never,
          assetHubApi: assetHubApiFake as never,
          key: { address: KEY.address, publicKeyHex: KEY_HEX, signer: KEY.signer },
          destinationHex: KEY_HEX,
          commitment: { planck: 1n, payoutAddress: "5x" },
          assetHubParaId: 1500,
          peopleParaId: 1502,
          poolAccount: "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B",
          slippagePct: 5,
          tickTimeoutMs: 1_000,
          submitTimeoutMs: 1_000,
          readKeyOnPeople: async () => ({ cash: 0n, pas: 0n }),
          readDestinationOnAssetHub: async () => 0n,
          now: Date.now,
        },
        real.freshWithdrawTickState(),
      ),
    ).rejects.toThrow(/needs an Asset Hub signer/);
  });
});
