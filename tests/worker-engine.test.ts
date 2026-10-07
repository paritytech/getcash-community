// The worker funding engine, offline: chain and pipeline seams are scripted, records and
// derivation are real.

import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveKeypair, deriveKeypairWithSecret, toSchnorrkelSecret } from "@getsome/ephemeral";
import { FundingHeldError } from "@getsome/funding";
import { PaymentTopUpErr, PaymentTopUpStatusErr } from "@novasamatech/host-api";
import { topUpIdFor } from "../worker/src/topup-id.js";

/** A status subscription the engine opened; the test plays the host through it. */
type Watch = {
  id: Uint8Array;
  onStatus: (status: unknown) => void;
  onInterrupt: (error: unknown) => void;
  stopped: boolean;
};

const mocks = vi.hoisted(() => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  registerTopUp: vi.fn(),
  watches: [] as Watch[],
  stored: new Map<string, unknown>(),
  storageDown: false,
  holdWrites: false,
  heldWrites: [] as Array<() => void>,
  tickOnce: vi.fn(),
  discoverPools: vi.fn(),
  chooseCashTransfer: vi.fn(),
  settlementBalance: vi.fn(),
}));

// The worker's host adapter is the seam to mock; the SDK behind it never loads here.
vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: mocks.deriveEntropy,
  getHostProvider: mocks.getHostProvider,
  registerTopUp: mocks.registerTopUp,
  followTopUpStatus: (
    id: Uint8Array,
    onStatus: Watch["onStatus"],
    onInterrupt: Watch["onInterrupt"],
  ) => {
    const watch: Watch = { id, onStatus, onInterrupt, stopped: false };
    mocks.watches.push(watch);
    return () => {
      watch.stopped = true;
    };
  },
  getHostLocalStorage: async () => ({
    readJSON: async (key: string) => {
      if (mocks.storageDown) throw new Error("storage down");
      return mocks.stored.get(key) ?? null;
    },
    writeJSON: async (key: string, value: unknown) => {
      if (mocks.storageDown) throw new Error("storage down");
      // Snapshot at the call, as the bridge does; a held write lands when the test releases it.
      const snapshot = JSON.parse(JSON.stringify(value));
      if (mocks.holdWrites) await new Promise<void>((land) => mocks.heldWrites.push(land));
      mocks.stored.set(key, snapshot);
    },
  }),
}));

vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  tickOnce: mocks.tickOnce,
  discoverPools: mocks.discoverPools,
  chooseCashTransfer: mocks.chooseCashTransfer,
}));

vi.mock("@getsome/people", () => ({
  CASH_SETTLEMENT: { kind: "foreign", id: "cash" },
  createPeopleChainPort: () => ({ settlementBalance: mocks.settlementBalance }),
}));

/** A 32-byte hash of one repeated byte. */
const hash32 = (fill: number) => `0x${fill.toString(16).padStart(2, "0").repeat(32)}`;
const ASSET_HUB_GENESIS = hash32(0x11);
const PEOPLE_GENESIS = hash32(0x22);
const BEST_BLOCK = hash32(0x33);
const OTHER_GENESIS = hash32(0x44);
const SWAP_TX = hash32(0x55);

vi.mock("polkadot-api", async (importOriginal) => ({
  // Partial mock: the ephemeral package needs AccountId and getPolkadotSigner from here.
  ...(await importOriginal<object>()),
  // The fake provider carries its genesis through to connectChain's check.
  createClient: (provider: { genesis: string }) => ({
    getChainSpecData: async () => ({ genesisHash: provider.genesis }),
    getBestBlocks: async () => [{ hash: BEST_BLOCK }],
    getTypedApi: () => ({ fake: "asset-hub-api" }),
    destroy: () => {},
  }),
}));

const SEED = new Uint8Array(32).fill(9);
const BURNER = deriveKeypair(SEED);
const SETTLE = 20_000_000n;

const HANDOFF = {
  sessionId: "s-1",
  label: "onramp:eph:dot-assethub:7",
  burnerAddress: BURNER.address,
  settleAmount: SETTLE.toString(),
  underlyingAssetId: 50_000_413,
  peopleParaId: 1004,
  assetHubGenesis: ASSET_HUB_GENESIS,
  peopleGenesis: PEOPLE_GENESIS,
};

type Engine = typeof import("../worker/src/engine.js");
type StoredJob = { [key: string]: any };

/** Fresh engine module (module-scope caches reset), same persistent "host storage". The old
 *  instance's subscriptions go with it. */
async function freshEngine(): Promise<Engine> {
  vi.resetModules();
  for (const watch of mocks.watches) watch.stopped = true;
  return await import("../worker/src/engine.js");
}

const storedJob = (sessionId = "s-1"): StoredJob =>
  (mocks.stored.get("getsome.funding.jobs") as { [id: string]: StoredJob })[sessionId];

const outcome = (step: string) => ({ step, balances: {}, submitted: false });

const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
const BURNER_ID = toHex(BURNER.publicKey);

const claimed = (finalized: boolean) => ({ type: "claimed", finalized });

const partially = (actualClaimed: bigint) => ({ type: "claimedPartially", actualClaimed });

const openWatches = () => mocks.watches.filter((watch) => !watch.stopped);

/** The one subscription the engine holds open. */
function openWatch(): Watch {
  const open = openWatches();
  expect(open).toHaveLength(1);
  return open[0]!;
}

/** The host pushes `status` on the open subscription. */
const pushStatus = (status: unknown) => openWatch().onStatus(status);

/** The host drops the open subscription with `error`; nothing more arrives on it. */
function interruptWatch(error: unknown) {
  const watch = openWatch();
  watch.stopped = true;
  watch.onInterrupt(error);
}

/** Waits for the engine's own save, made outside any pass, to land in storage. */
const saved = (check: () => void) => vi.waitFor(check, { interval: 10 });

/** A macrotask turn, so every microtask queued so far has run. Real timers only. */
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A landed job whose first attempt the host has registered; the status is still to come. */
async function engineWithRegisteredClaim(): Promise<Engine> {
  const engine = await engineWithLandedJob();
  mocks.settlementBalance.mockResolvedValueOnce(SETTLE);
  mocks.registerTopUp.mockResolvedValue(undefined);
  await engine.tickAllFunding();
  expect(storedJob().claim).toMatchObject({ phase: "claiming", attempt: 0 });
  return engine;
}

const sessionStatus = (engine: Engine) =>
  engine.fundingStatus(JSON.stringify({ sessionId: "s-1" }));

function armSeams() {
  // Reset first: a leftover mockImplementationOnce from an earlier test must not leak.
  mocks.deriveEntropy.mockReset();
  mocks.getHostProvider.mockReset();
  mocks.discoverPools.mockReset();
  mocks.tickOnce.mockReset();
  mocks.chooseCashTransfer.mockReset();
  mocks.registerTopUp.mockReset();
  mocks.settlementBalance.mockReset();
  mocks.deriveEntropy.mockResolvedValue({ ok: true, value: SEED });
  mocks.getHostProvider.mockImplementation(async (genesis: string) => ({ genesis }));
  mocks.discoverPools.mockImplementation(async (_api: unknown, ids: number[]) =>
    ids.map(() => ({ native: "N", underlying: "U" })),
  );
  mocks.chooseCashTransfer.mockResolvedValue("teleport");
  mocks.watches.length = 0;
  mocks.stored.clear();
  mocks.storageDown = false;
  mocks.holdWrites = false;
  mocks.heldWrites.length = 0;
}

/** A started job whose funding leg is done on the first tick; only the claim is left. */
async function engineWithLandedJob(): Promise<Engine> {
  const engine = await freshEngine();
  await engine.startFunding(JSON.stringify(HANDOFF));
  mocks.tickOnce.mockResolvedValueOnce(outcome("done"));
  return engine;
}

/** Fail the job from outside the pipeline, keeping whatever latches it holds. */
async function cancelled(engine: Engine): Promise<void> {
  await engine.cancelFunding(JSON.stringify({ sessionId: "s-1" }));
  expect(storedJob()).toMatchObject({ phase: "failed", failure: "cancelled" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("worker funding engine", () => {
  it("records a handoff durably, idempotently, and refuses a malformed one", async () => {
    armSeams();
    const engine = await freshEngine();
    const first = await engine.startFunding(JSON.stringify(HANDOFF));
    expect(first).toMatchObject({ sessionId: "s-1", phase: "starting", done: false });
    // Idempotent: a relaunch re-sending the handoff must not reset a live job.
    const again = await engine.startFunding(JSON.stringify({ ...HANDOFF, settleAmount: "990000" }));
    expect(again.settleAmount).toBe(SETTLE.toString());
    // Durable: the record is in product storage, not module memory.
    expect(storedJob()).toMatchObject({ v: 2, label: HANDOFF.label });
    // Refusals are data; the surface receives them as WorkerCallError("invalid", reason).
    const noSession = await engine.startFunding(JSON.stringify({ ...HANDOFF, sessionId: "" }));
    expect(noSession).toMatchObject({ error: "invalid" });
    expect(noSession.reason).toContain("sessionId");
    // Below one coin unit: refused up front.
    const dust = await engine.startFunding(
      JSON.stringify({ ...HANDOFF, sessionId: "s-2", settleAmount: "9999" }),
    );
    expect(dust).toMatchObject({ error: "invalid" });
    expect(dust.reason).toContain("at least");
    // Any six-decimal amount above the unit is accepted.
    const sixDecimals = await engine.startFunding(
      JSON.stringify({ ...HANDOFF, sessionId: "s-3", settleAmount: "1234567" }),
    );
    expect(sixDecimals).toMatchObject({ sessionId: "s-3", phase: "starting" });
  });

  it("converts through the recorded route, never a fresh decision, and reads a record without one as pool", async () => {
    armSeams();
    const engine = await freshEngine();
    const quotedPsm = { ...HANDOFF, tier: "psm", external: "USDT", feeRate: 5_000 };
    await engine.startFunding(JSON.stringify(quotedPsm));
    expect(storedJob()).toMatchObject({ tier: "psm", external: "USDT", feeRate: 5_000 });

    // The tick converts through the recorded tier: the pipeline is handed the route as recorded,
    // and no pool is looked for on a tier that has none.
    mocks.tickOnce.mockResolvedValue(outcome("swap"));
    await engine.tickAllFunding();
    expect(mocks.tickOnce).toHaveBeenCalledTimes(1);
    expect(mocks.tickOnce.mock.calls[0]![0]).toMatchObject({
      route: { tier: "psm", external: "USDT", feeRate: 5_000 },
      pool: undefined,
    });
    expect(mocks.discoverPools).not.toHaveBeenCalled();
    expect(storedJob().phase).toBe("swap");

    // A restart re-sending the hand-off under another tier changes nothing: the record's stands.
    const revived = await freshEngine();
    await revived.startFunding(JSON.stringify({ ...HANDOFF, tier: "pool" }));
    await revived.tickAllFunding();
    expect(storedJob().tier).toBe("psm");
    expect(mocks.tickOnce).toHaveBeenCalledTimes(2);
    expect(mocks.tickOnce.mock.calls[1]![0]).toMatchObject({ route: { tier: "psm" } });
    expect(mocks.discoverPools).not.toHaveBeenCalled();

    // A record from before routes were recorded is a pool one, which is what it was: the pool is
    // discovered and handed over with the route.
    delete storedJob().tier;
    delete storedJob().external;
    delete storedJob().feeRate;
    const legacy = await freshEngine();
    await legacy.tickAllFunding();
    expect(mocks.tickOnce).toHaveBeenCalledTimes(3);
    expect(mocks.tickOnce.mock.calls[2]![0]).toMatchObject({
      route: { tier: "pool" },
      pool: { native: "N", underlying: "U" },
    });
    expect(mocks.discoverPools).toHaveBeenCalledTimes(1);
    expect(mocks.discoverPools.mock.calls[0]![1]).toEqual([50_000_413]);
    expect(storedJob().phase).toBe("swap");

    // A psm hand-off without the fee the buyer was quoted is refused up front.
    const noFee = await legacy.startFunding(
      JSON.stringify({ ...HANDOFF, sessionId: "s-2", tier: "psm", external: "USDT" }),
    );
    expect(noFee).toMatchObject({ error: "invalid" });
    expect(noFee.reason).toContain("fee rate");
  });

  it("discovers both pools for a pool job fed with a stable, and refuses a stable it does not know", async () => {
    armSeams();
    mocks.discoverPools.mockImplementation(async (_api: unknown, ids: number[]) =>
      ids.map((id) => ({ native: "N", underlying: id === 1337 ? "S" : "U" })),
    );
    const engine = await freshEngine();
    await engine.startFunding(
      JSON.stringify({ ...HANDOFF, tier: "pool", external: "USDC", quotedDeposit: "5300000" }),
    );
    expect(storedJob()).toMatchObject({ tier: "pool", external: "USDC", quotedDeposit: "5300000" });
    mocks.tickOnce.mockResolvedValue(outcome("swap"));
    await engine.tickAllFunding();
    // The CASH pool under the underlying's id and the stable pool under USDC's, in one read.
    expect(mocks.discoverPools.mock.calls.map((call) => call[1])).toEqual([[50_000_413, 1337]]);
    expect(mocks.tickOnce.mock.calls[0]![0]).toMatchObject({
      route: { tier: "pool", external: "USDC" },
      pool: { underlying: "U" },
      stablePool: { underlying: "S" },
      quotedDeposit: 5_300_000n,
    });
    const unknown = await engine.startFunding(
      JSON.stringify({ ...HANDOFF, sessionId: "s-2", tier: "pool", external: "DAI" }),
    );
    expect(unknown).toMatchObject({ error: "invalid" });
    expect(unknown.reason).toContain("deposit asset");
  });

  it("hands a dotUSD job its route and frozen deposit with no pool to find", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(
      JSON.stringify({ ...HANDOFF, tier: "dotusd", quotedDeposit: "5143041" }),
    );
    expect(storedJob()).toMatchObject({ tier: "dotusd", quotedDeposit: "5143041" });
    mocks.tickOnce.mockResolvedValue(outcome("swap"));
    await engine.tickAllFunding();
    expect(mocks.discoverPools).not.toHaveBeenCalled();
    expect(mocks.tickOnce.mock.calls[0]![0]).toMatchObject({
      route: { tier: "dotusd" },
      pool: undefined,
      stablePool: undefined,
      quotedDeposit: 5_143_041n,
    });
  });

  it("holds a job the PSM refused three times, keeps its deposit and counter, and re-arms it with a fresh counter", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(
      JSON.stringify({ ...HANDOFF, tier: "psm", external: "USDT", feeRate: 5_000 }),
    );
    // Two refusals so far: the tick throws as any transient, and the counter it bumped persists.
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      state.psmRefusals = 2;
      throw new Error("not submitted: Asset Hub rejects the program: Psm.MintingStopped");
    });
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({
      phase: "starting",
      state: { psmRefusals: 2 },
      lastError: expect.stringContaining("Psm.MintingStopped"),
    });
    // The next wake restores the counter, and the third refusal is terminal: held, not failed
    // through the pool.
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      expect(state.psmRefusals).toBe(2);
      state.psmRefusals = 3;
      throw new FundingHeldError("Psm.MintingStopped");
    });
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({
      phase: "failed",
      failure: "held",
      state: { psmRefusals: 3 },
      lastError: expect.stringContaining("funding held"),
    });
    // A held job is not ticked again on its own.
    await engine.tickAllFunding();
    expect(mocks.tickOnce).toHaveBeenCalledTimes(2);
    // A re-sent hand-off re-arms it with a fresh counter, for a ceiling raised since.
    await engine.startFunding(
      JSON.stringify({ ...HANDOFF, tier: "psm", external: "USDT", feeRate: 5_000 }),
    );
    expect(storedJob()).toMatchObject({ phase: "starting", state: { psmRefusals: 0 } });
    expect(storedJob().failure).toBeUndefined();
  });

  it("refuses a hand-off whose burner is not the one it derives, before and after the record exists", async () => {
    armSeams();
    const engine = await freshEngine();
    const other = deriveKeypair(new Uint8Array(32).fill(3)).address;
    const refused = await engine.startFunding(JSON.stringify({ ...HANDOFF, burnerAddress: other }));
    expect(refused).toMatchObject({ error: "invalid" });
    expect(refused.reason).toContain("burner mismatch");
    expect(mocks.stored.get("getsome.funding.jobs")).toBeUndefined();

    await engine.startFunding(JSON.stringify(HANDOFF));
    const resent = await engine.startFunding(JSON.stringify({ ...HANDOFF, burnerAddress: other }));
    expect(resent).toMatchObject({ error: "invalid" });
    expect(storedJob().burnerAddress).toBe(BURNER.address);
  });

  it("checks a record from before addresses were exchanged against a fresh derivation", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    delete storedJob().burnerAddress;
    const legacy = await freshEngine();

    const other = deriveKeypair(new Uint8Array(32).fill(3)).address;
    const refused = await legacy.startFunding(JSON.stringify({ ...HANDOFF, burnerAddress: other }));
    expect(refused).toMatchObject({ error: "invalid" });
    expect(storedJob().burnerAddress).toBeUndefined();

    const accepted = await legacy.startFunding(JSON.stringify(HANDOFF));
    expect(accepted).toMatchObject({ sessionId: "s-1", phase: "starting" });
    expect(storedJob().burnerAddress).toBe(BURNER.address);
  });

  it("retires an unfunded job by the rail's own deposit deadline when the surface passes one", async () => {
    armSeams();
    vi.useFakeTimers();
    const engine = await freshEngine();
    const threeDays = 3 * 86_400_000;
    await engine.startFunding(
      JSON.stringify({ ...HANDOFF, depositExpiresAt: Date.now() + threeDays }),
    );
    mocks.tickOnce.mockResolvedValue(outcome("await-native"));

    vi.advanceTimersByTime(86_400_000 + 1); // past the default window, inside the rail's
    await engine.tickAllFunding();
    expect(storedJob().phase).toBe("await-native");

    vi.advanceTimersByTime(threeDays);
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "expired" });
  });

  it("drives a job with the surface's exact burner and persists what the tick learned", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));

    const seenAt = Date.now();
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      state.fundsSeenAt = seenAt;
      return outcome("swap");
    });
    const { ticked, busy } = await engine.tickAllFunding();
    expect({ ticked, busy }).toEqual({ ticked: 1, busy: false });

    const input = mocks.tickOnce.mock.calls[0][0];
    // Identity: re-derived per wake from the label, and its own beneficiary.
    expect(input.address).toBe(BURNER.address);
    expect(input.beneficiaryHex).toBe(
      `0x${Array.from(BURNER.publicKey, (b) => b.toString(16).padStart(2, "0")).join("")}`,
    );
    expect(input.settleAmount).toBe(SETTLE);
    expect(input.signOptions).toEqual({ at: BEST_BLOCK });

    expect(storedJob()).toMatchObject({ phase: "swap", state: { fundsSeenAt: seenAt } });

    // Next wake: the persisted state is what tickOnce receives back.
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      expect(state.fundsSeenAt).toBe(seenAt);
      state.attempts = 1;
      state.xcmSubmitted = true;
      return { ...outcome("await-arrival"), submitted: true };
    });
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({
      phase: "await-arrival",
      state: { attempts: 1, xcmSubmitted: true },
    });
  });

  it("persists the submitting marker and the pre-send state before the submit, and the tx after it", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    mocks.tickOnce.mockImplementationOnce(async (input, state) => {
      state.attempts = 1;
      state.nonceAtSubmit = 5;
      state.peopleAtXcm = 100n;
      await input.onBeforeSubmit("swap");
      // The marker and the state are durable before a broadcast could leave.
      expect(storedJob().submitting).toMatchObject({ call: "swap" });
      expect(storedJob().state).toMatchObject({
        attempts: 1,
        nonceAtSubmit: 5,
        peopleAtXcm: "100",
      });
      input.onTx({ call: "swap", txHash: SWAP_TX, block: 42 });
      state.nonceAtSubmit = null;
      state.xcmSubmitted = true;
      return { ...outcome("await-arrival"), submitted: true };
    });
    await engine.tickAllFunding();
    expect(storedJob().submitting).toBeUndefined();
    expect(storedJob().txs).toEqual([{ call: "swap", txHash: SWAP_TX, block: 42 }]);
    expect(storedJob().state).toMatchObject({ nonceAtSubmit: null, xcmSubmitted: true });
  });

  it("resumes a job killed mid-send knowing a conversion may be in flight", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    mocks.tickOnce.mockImplementationOnce(async (input, state) => {
      state.attempts = 1;
      state.nonceAtSubmit = 5;
      state.peopleAtXcm = 100n;
      state.fundsSeenAt = Date.now();
      await input.onBeforeSubmit("swap");
      throw new Error("funding program submit not in a block after 60s");
    });
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({
      submitting: { call: "swap" },
      state: { attempts: 1, nonceAtSubmit: 5, peopleAtXcm: "100", xcmSubmitted: false },
      lastError: expect.stringContaining("not in a block"),
    });

    // A restarted worker hands the tick what it recorded; the tick settles it from the chain.
    const revived = await freshEngine();
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      expect(state).toMatchObject({ attempts: 1, nonceAtSubmit: 5, peopleAtXcm: 100n });
      state.nonceAtSubmit = null;
      state.xcmSubmitted = true;
      return outcome("await-arrival");
    });
    await revived.tickAllFunding();
    expect(storedJob().submitting).toBeUndefined();
    expect(storedJob()).toMatchObject({
      phase: "await-arrival",
      state: { attempts: 1, nonceAtSubmit: null, xcmSubmitted: true },
    });

    // A record from before the field existed is handed to the tick without a submit owed.
    delete storedJob().state.nonceAtSubmit;
    const legacy = await freshEngine();
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      expect(state.nonceAtSubmit).toBeNull();
      return outcome("await-arrival");
    });
    await legacy.tickAllFunding();
    expect(storedJob().state.nonceAtSubmit).toBeNull();
  });

  it("persists the block the conversion was seen in, and restores a record from before it without one", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      state.attempts = 1;
      state.xcmSubmitted = true;
      state.nonceAtSubmit = 5;
      state.inclusionBlock = 1_234;
      return { ...outcome("await-arrival"), submitted: true };
    });
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({
      phase: "await-arrival",
      state: { xcmSubmitted: true, nonceAtSubmit: 5, inclusionBlock: 1_234 },
    });

    const revived = await freshEngine();
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      expect(state).toMatchObject({ xcmSubmitted: true, nonceAtSubmit: 5, inclusionBlock: 1_234 });
      return outcome("await-arrival");
    });
    await revived.tickAllFunding();
    expect(storedJob()).toMatchObject({
      phase: "await-arrival",
      state: { nonceAtSubmit: 5, inclusionBlock: 1_234 },
    });

    delete storedJob().state.inclusionBlock;
    const legacy = await freshEngine();
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      expect(state).toMatchObject({ nonceAtSubmit: 5, inclusionBlock: null });
      return outcome("await-arrival");
    });
    await legacy.tickAllFunding();
    expect(storedJob()).toMatchObject({
      phase: "await-arrival",
      state: { nonceAtSubmit: 5, inclusionBlock: null },
    });
  });

  it("reads the CASH behind done, and behind sizing every claim attempt, from the finalized People block", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    mocks.tickOnce.mockImplementationOnce(async (input) => {
      expect(await input.readFinalizedUnderlyingOnPeople(BURNER.address)).toBe(SETTLE);
      return outcome("done");
    });
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.registerTopUp.mockResolvedValue(undefined);
    await engine.tickAllFunding();
    expect(storedJob().claim).toMatchObject({ phase: "claiming", attempt: 0 });
    // The tick's own read, then the one that sized the claim.
    expect(mocks.settlementBalance).toHaveBeenCalledTimes(2);

    // A short verdict sizes the next attempt the same way.
    pushStatus(partially(SETTLE / 2n));
    mocks.settlementBalance.mockResolvedValue(SETTLE / 2n);
    await engine.tickAllFunding();
    expect(storedJob().claim).toMatchObject({ phase: "claiming", attempt: 1 });
    expect(mocks.settlementBalance).toHaveBeenCalledTimes(3);
    for (const call of mocks.settlementBalance.mock.calls) {
      expect(call).toEqual([BURNER.address, { kind: "foreign", id: "cash" }, { at: "finalized" }]);
    }
  });

  it("ticks the next job while the first one waits for its CASH to be final", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    const second = { ...HANDOFF, sessionId: "s-2", settleAmount: "30000000" };
    await engine.startFunding(JSON.stringify(second));
    mocks.tickOnce.mockImplementation(async (input, state) => {
      if (input.settleAmount === 30_000_000n) return outcome("await-native");
      if (!state.xcmSubmitted) {
        state.xcmSubmitted = true;
        return outcome("await-arrival");
      }
      return outcome("done");
    });
    expect(await engine.tickAllFunding()).toEqual({ ticked: 2, busy: false });
    expect(mocks.tickOnce).toHaveBeenCalledTimes(2);
    expect(storedJob()).toMatchObject({ phase: "await-arrival", state: { xcmSubmitted: true } });
    expect(storedJob("s-2")).toMatchObject({ phase: "await-native" });

    mocks.settlementBalance.mockResolvedValueOnce(0n);
    expect(await engine.tickAllFunding()).toEqual({ ticked: 2, busy: false });
    expect(storedJob()).toMatchObject({ done: true });
    expect(storedJob("s-2")).toMatchObject({ phase: "await-native" });
  });

  it("keeps transient errors retryable, makes shortfall terminal, and survives a restart", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));

    mocks.tickOnce.mockRejectedValueOnce(new Error("rpc blip"));
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({ phase: "starting", lastError: "rpc blip" }); // still live

    // Worker restarted: a fresh module instance resumes from storage alone.
    const revived = await freshEngine();
    const funding = await import("@getsome/funding");
    mocks.tickOnce.mockRejectedValueOnce(
      new funding.FundingShortfallError(SETTLE - 5_000n, SETTLE),
    );
    expect((await revived.tickAllFunding()).ticked).toBe(1);
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "shortfall" });
    expect(storedJob().lastError).toContain("shortfall");

    // Terminal: no further driving.
    expect((await revived.tickAllFunding()).ticked).toBe(0);
  });

  it("records a host that routed the wrong chain as the job's error, and retries next wake", async () => {
    armSeams();
    mocks.getHostProvider.mockImplementation(async () => ({ genesis: OTHER_GENESIS }));
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    await engine.tickAllFunding();
    expect(storedJob().lastError).toContain("genesis mismatch");
    expect(storedJob().phase).toBe("starting"); // transient: the next wake tries again
  });

  it("never lets a failed storage read stand in for the job map", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    const before = mocks.stored.get("getsome.funding.jobs");

    // A fresh instance whose first read fails must not answer from, or save, an empty map.
    mocks.storageDown = true;
    const revived = await freshEngine();
    await expect(revived.tickAllFunding()).rejects.toThrow("storage down");
    await expect(
      revived.startFunding(JSON.stringify({ ...HANDOFF, sessionId: "s-2" })),
    ).rejects.toThrow("storage down");

    mocks.storageDown = false;
    expect(mocks.stored.get("getsome.funding.jobs")).toEqual(before);
    // Once storage answers, the same instance sees the real records.
    mocks.tickOnce.mockResolvedValueOnce(outcome("await-native"));
    expect((await revived.tickAllFunding()).ticked).toBe(1);
  });

  it("re-arms a failed job on a re-sent handoff, keeping the double-buy latches", async () => {
    armSeams();
    const started = await freshEngine();
    await started.startFunding(JSON.stringify(HANDOFF));
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      state.attempts = 1;
      state.xcmSubmitted = true;
      state.fundsSeenAt = Date.now();
      return { ...outcome("await-arrival"), submitted: true };
    });
    await started.tickAllFunding();
    // A restart over a record that has already used up its worker time.
    storedJob().state.workedMs = 900_001;
    const engine = await freshEngine();
    mocks.tickOnce.mockResolvedValueOnce(outcome("await-arrival"));
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout" });
    expect((await engine.tickAllFunding()).ticked).toBe(0);

    const rearmed = await engine.startFunding(JSON.stringify(HANDOFF));
    expect(rearmed).toMatchObject({ phase: "starting", done: false });
    expect(storedJob().lastError).toBeUndefined();
    expect(storedJob().failure).toBeUndefined();
    expect(storedJob().state).toMatchObject({
      attempts: 1,
      xcmSubmitted: true,
      fundsSeenAt: null,
    });

    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      expect(state.xcmSubmitted).toBe(true);
      return outcome("await-arrival");
    });
    expect((await engine.tickAllFunding()).ticked).toBe(1);
  });

  it("releases the latches when re-arming after a shortfall, so the deficit can be re-bought", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    const funding = await import("@getsome/funding");
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      state.attempts = 1;
      state.xcmSubmitted = true;
      state.peopleAtXcm = 100n;
      state.nonceAtSubmit = 5;
      state.inclusionBlock = 1_234;
      state.fundsSeenAt = Date.now();
      throw new funding.FundingShortfallError(SETTLE - 5_000n, SETTLE);
    });
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({
      phase: "failed",
      failure: "shortfall",
      state: { xcmSubmitted: true, peopleAtXcm: "100", nonceAtSubmit: 5, inclusionBlock: 1_234 },
    });

    await engine.startFunding(JSON.stringify(HANDOFF));
    expect(storedJob().state).toMatchObject({
      attempts: 0,
      xcmSubmitted: false,
      peopleAtXcm: "0",
      nonceAtSubmit: null,
      inclusionBlock: null,
      fundsSeenAt: null,
    });
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      expect(state.xcmSubmitted).toBe(false);
      return outcome("swap");
    });
    expect((await engine.tickAllFunding()).ticked).toBe(1);
  });

  it("retires a job whose deposit never arrives, and re-arms it on the next hand-off", async () => {
    armSeams();
    vi.useFakeTimers();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    mocks.tickOnce.mockResolvedValue(outcome("await-native"));
    await engine.tickAllFunding();
    expect(storedJob().phase).toBe("await-native");

    vi.advanceTimersByTime(86_400_000 + 1);
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "expired" });
    // Nothing left to hold the keep-alive for.
    expect((await engine.tickAllFunding()).ticked).toBe(0);

    // A late deposit re-opens the request through the usual hand-off: a fresh window.
    await engine.startFunding(JSON.stringify(HANDOFF));
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(storedJob().phase).toBe("await-native");
  });

  it("amends a job still waiting for its deposit with new terms, and refuses once funds are seen", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(
      JSON.stringify({ ...HANDOFF, tier: "pool", external: "USDC", quotedDeposit: "10300000" }),
    );
    const amended = await engine.amendFunding(
      JSON.stringify({
        ...HANDOFF,
        settleAmount: "7900000",
        tier: "dotusd",
        quotedDeposit: "8000000",
      }),
    );
    expect(amended.error).toBeUndefined();
    const job = storedJob();
    expect(job).toMatchObject({
      settleAmount: "7900000",
      tier: "dotusd",
      quotedDeposit: "8000000",
    });
    // The old route's stable is gone with it, and the job's identity is kept.
    expect(job.external).toBeUndefined();
    expect(job).toMatchObject({ sessionId: "s-1", label: HANDOFF.label, phase: "starting" });

    // Once the worker has seen funds the job is no longer amended.
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      state.fundsSeenAt = Date.now();
      return outcome("await-native");
    });
    await engine.tickAllFunding();
    const refused = await engine.amendFunding(
      JSON.stringify({ ...HANDOFF, settleAmount: "5000000" }),
    );
    expect(refused).toMatchObject({ error: "invalid" });
    expect(refused.reason).toContain("no longer waiting");
    expect(storedJob().settleAmount).toBe("7900000");

    // Nor is a job that does not exist, or one for another burner.
    expect(
      await engine.amendFunding(JSON.stringify({ ...HANDOFF, sessionId: "s-9" })),
    ).toMatchObject({ error: "invalid" });
  });

  it("refuses to amend a job whose deposit window closed", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify({ ...HANDOFF, depositExpiresAt: 1 }));
    mocks.tickOnce.mockResolvedValue(outcome("await-native"));
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "expired" });
    const expired = await engine.amendFunding(
      JSON.stringify({ ...HANDOFF, settleAmount: "7900000", tier: "dotusd" }),
    );
    expect(expired).toMatchObject({ error: "invalid" });
    expect(storedJob().settleAmount).toBe(HANDOFF.settleAmount);
  });

  it("cancels a job still waiting for its deposit, and answers known:false for one it never had", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    expect(await engine.cancelFunding(JSON.stringify({ sessionId: "s-9" }))).toEqual({
      sessionId: "s-9",
      known: false,
    });
    await cancelled(engine);
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("refuses to cancel a job whose funds are in motion", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      state.fundsSeenAt = Date.now();
      return outcome("swap");
    });
    await engine.tickAllFunding();
    const answer = await engine.cancelFunding(JSON.stringify({ sessionId: "s-1" }));
    expect(answer).toMatchObject({ phase: "swap" });
    expect(storedJob().failure).toBeUndefined();
    expect((await engine.tickAllFunding()).ticked).toBe(1);
  });

  it("keeps a cancel that lands while a tick is reading the chain", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    mocks.tickOnce.mockImplementationOnce(async () => {
      await engine.cancelFunding(JSON.stringify({ sessionId: "s-1" }));
      return outcome("await-native");
    });
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "cancelled" });
  });

  it("counts only the time the worker was running toward the run bound", async () => {
    // The gap between ticks is capped; a suspended hour counts as one capped gap.
    armSeams();
    vi.useFakeTimers();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    mocks.tickOnce.mockImplementation(async (_input, state) => {
      if (state.fundsSeenAt === null) state.fundsSeenAt = Date.now();
      return outcome("await-arrival");
    });
    await engine.tickAllFunding();
    expect(storedJob().state.workedMs).toBe(0);

    vi.advanceTimersByTime(3_600_000); // suspended for an hour
    await engine.tickAllFunding();
    expect(storedJob().state.workedMs).toBe(30_000); // one capped gap, not an hour
    expect(storedJob().phase).toBe("await-arrival");

    // Running for the whole bound fails the job, after the chain was read.
    const ticks = Math.ceil(900_000 / 30_000);
    for (let i = 0; i < ticks; i += 1) {
      vi.advanceTimersByTime(30_000);
      await engine.tickAllFunding();
    }
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout" });
    expect(mocks.tickOnce).toHaveBeenCalledTimes(ticks + 2);
  });

  it("reads the chain before judging the bound: a conversion finished while frozen is done", async () => {
    armSeams();
    vi.useFakeTimers();
    const started = await freshEngine();
    await started.startFunding(JSON.stringify(HANDOFF));
    mocks.tickOnce.mockImplementationOnce(async (_input, state) => {
      state.fundsSeenAt = Date.now();
      return outcome("await-arrival");
    });
    await started.tickAllFunding();
    // A restart over a record whose worker time is used up: the tick that finds it done
    // wins over the bound.
    storedJob().state.workedMs = 900_001;
    vi.advanceTimersByTime(7_200_000);
    const engine = await freshEngine();
    mocks.tickOnce.mockResolvedValueOnce(outcome("done"));
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.registerTopUp.mockResolvedValue(undefined);

    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({ done: true, claim: { phase: "claiming" } });
    expect(storedJob().failure).toBeUndefined();
    pushStatus(claimed(true));
    await saved(() => expect(storedJob()).toMatchObject({ claim: { phase: "claimed" } }));
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("registers the landed CASH under the burner's public key and follows the claim over one subscription", async () => {
    armSeams();
    const engine = await engineWithLandedJob();
    // 20.005 CASH on People: the claim floors to the coin unit, dust stays.
    mocks.settlementBalance.mockResolvedValueOnce(SETTLE + 5_000n);
    mocks.registerTopUp.mockResolvedValue(undefined);

    expect((await engine.tickAllFunding()).ticked).toBe(1);

    // The host is handed the burner's secret in schnorrkel's canonical layout.
    const { secretKey } = deriveKeypairWithSecret(SEED);
    expect(mocks.registerTopUp).toHaveBeenCalledExactlyOnceWith(
      SETTLE,
      toSchnorrkelSecret(secretKey),
      BURNER.publicKey,
    );
    expect(storedJob()).toMatchObject({
      done: true,
      claim: {
        phase: "claiming",
        attempt: 0,
        id: BURNER_ID,
        amount: SETTLE.toString(),
        attempts: 1,
      },
    });
    expect(storedJob().claim.registeredAt).toEqual(expect.any(Number));
    // Registered: the attempt's status is followed under its id from the same tick.
    expect(mocks.watches).toHaveLength(1);
    expect(openWatch().id).toEqual(BURNER.publicKey);

    // One read sized the claim; every word the host pushes is on the record, and in storage,
    // without a pass.
    for (const status of [{ type: "detecting" }, { type: "claiming" }, claimed(false)]) {
      pushStatus(status);
      expect((await sessionStatus(engine)).claim).toMatchObject({
        phase: "claiming",
        status: status.type,
      });
      await saved(() =>
        expect(storedJob().claim).toMatchObject({ phase: "claiming", status: status.type }),
      );
    }
    expect(mocks.settlementBalance).toHaveBeenCalledTimes(1);
    // A pass in between keeps the one subscription.
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(mocks.watches).toHaveLength(1);

    // The final word settles the job and closes the subscription.
    pushStatus(claimed(true));
    expect((await sessionStatus(engine)).claim).toMatchObject({
      phase: "claimed",
      amount: SETTLE.toString(),
    });
    expect(openWatches()).toHaveLength(0);
    await saved(() => expect(storedJob().claim.phase).toBe("claimed"));
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("claims a key sent home whole under ids past the ones it was paid under, held to the quote", async () => {
    armSeams();
    const engine = await freshEngine();
    const OFFSET = 1_000_000;
    // Refused up front: an offset the id's counter cannot hold, and a floor that is not a share.
    for (const bad of [{ claimIdOffset: -1 }, { claimIdOffset: 2.5 }, { claimIdOffset: 2 ** 32 }]) {
      const refused = await engine.startFunding(JSON.stringify({ ...HANDOFF, ...bad }));
      expect(refused).toMatchObject({ error: "invalid" });
      expect(refused.reason).toContain("claimIdOffset");
    }
    const noShare = await engine.startFunding(JSON.stringify({ ...HANDOFF, quoteFloorPct: 100 }));
    expect(noShare.reason).toContain("quoteFloorPct");

    await engine.startFunding(
      JSON.stringify({
        ...HANDOFF,
        settleAmount: "10000",
        claimIdOffset: OFFSET,
        quoteFloorPct: 2.5,
      }),
    );
    expect(storedJob()).toMatchObject({ claimIdOffset: OFFSET, quoteFloorPct: 2.5 });
    mocks.tickOnce.mockResolvedValueOnce(outcome("done"));
    mocks.settlementBalance.mockResolvedValueOnce(SETTLE);
    mocks.registerTopUp.mockResolvedValue(undefined);
    await engine.tickAllFunding();
    expect(mocks.tickOnce.mock.calls[0]![0]).toMatchObject({ quoteFloorPct: 2.5 });
    // Never the key's own public key, which its first payment was registered under.
    const firstId = topUpIdFor(BURNER.publicKey, OFFSET);
    expect(firstId).not.toEqual(BURNER.publicKey);
    expect(mocks.registerTopUp.mock.calls[0]![2]).toEqual(firstId);
    expect(storedJob().claim).toMatchObject({ phase: "claiming", attempt: 0, id: toHex(firstId) });

    // The subscription follows the same id, and a short settle moves on to the next one past it.
    expect(openWatch().id).toEqual(firstId);
    pushStatus(partially(SETTLE / 2n));
    expect((await sessionStatus(engine)).claim).toMatchObject({ phase: "sizing", attempt: 1 });
    mocks.settlementBalance.mockResolvedValueOnce(SETTLE / 2n);
    await engine.tickAllFunding();
    const nextId = topUpIdFor(BURNER.publicKey, OFFSET + 1);
    expect(mocks.registerTopUp.mock.calls[1]![2]).toEqual(nextId);
    expect(openWatch().id).toEqual(nextId);
  });

  it("keeps the registering marker across a failed call and takes AlreadyExists as registered", async () => {
    armSeams();
    vi.useFakeTimers();
    const engine = await engineWithLandedJob();
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.registerTopUp.mockRejectedValueOnce(new Error("host busy"));

    expect((await engine.tickAllFunding()).ticked).toBe(1);
    let status = await sessionStatus(engine);
    expect(status.claim).toMatchObject({
      phase: "registering",
      id: BURNER_ID,
      amount: SETTLE.toString(),
      attempts: 1,
      error: "host busy",
    });
    expect(status.lastError).toBe("host busy");
    // Nothing is followed until the host has the claim.
    expect(mocks.watches).toHaveLength(0);

    // Inside the retry window nothing is re-called.
    vi.advanceTimersByTime(120_000);
    await engine.tickAllFunding();
    expect(mocks.registerTopUp).toHaveBeenCalledTimes(1);

    // Past the window the host already knows the id: the failed-looking call had registered.
    vi.advanceTimersByTime(61_000);
    mocks.registerTopUp.mockRejectedValueOnce(new PaymentTopUpErr.AlreadyExists());
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(mocks.registerTopUp).toHaveBeenCalledTimes(2);
    status = await sessionStatus(engine);
    expect(status.claim).toMatchObject({ phase: "claiming", attempts: 2 });
    expect(status.claim.error).toBeUndefined();
    expect(mocks.watches).toHaveLength(1);
    // The burner was sized once; the amount is fixed at registration.
    expect(mocks.settlementBalance).toHaveBeenCalledTimes(1);

    pushStatus(claimed(true));
    await saved(() =>
      expect(storedJob().claim).toMatchObject({ phase: "claimed", amount: SETTLE.toString() }),
    );
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("fails the job when the host refuses the burner as a top-up source", async () => {
    armSeams();
    const engine = await engineWithLandedJob();
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.registerTopUp.mockRejectedValueOnce(new PaymentTopUpErr.InvalidSource());

    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "claim", done: true });
    expect(storedJob().claim).toMatchObject({ phase: "registering", attempts: 1 });
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("re-registers a claim the host does not know", async () => {
    armSeams();
    const engine = await engineWithLandedJob();
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.registerTopUp.mockResolvedValue(undefined);
    await engine.tickAllFunding();
    expect(storedJob().claim.phase).toBe("claiming");

    interruptWatch(new PaymentTopUpStatusErr.NotFound());
    await saved(() =>
      expect(storedJob().claim).toMatchObject({ phase: "registering", attempts: 1 }),
    );
    expect(storedJob().lastError).toBeUndefined();

    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(mocks.registerTopUp).toHaveBeenCalledTimes(2);
    expect(storedJob().claim).toMatchObject({ phase: "claiming", attempts: 2 });
    expect(mocks.watches).toHaveLength(2);
    expect(openWatch().id).toEqual(BURNER.publicKey);
  });

  it("records a dropped subscription on the job and reopens it on the next pass", async () => {
    armSeams();
    const engine = await engineWithLandedJob();
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.registerTopUp.mockResolvedValue(undefined);
    await engine.tickAllFunding();

    interruptWatch(new Error("bridge down"));
    await saved(() =>
      expect(storedJob().claim).toMatchObject({ phase: "claiming", error: "bridge down" }),
    );
    expect(storedJob().lastError).toBe("bridge down");
    expect(openWatches()).toHaveLength(0);

    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(mocks.watches).toHaveLength(2);
    pushStatus(claimed(true));
    await saved(() => expect(storedJob().claim).toMatchObject({ phase: "claimed" }));
    expect(storedJob().claim.error).toBeUndefined();
  });

  it("reopens the subscription after a restart, and only then", async () => {
    armSeams();
    const engine = await engineWithRegisteredClaim();
    await engine.tickAllFunding();
    expect(mocks.watches).toHaveLength(1);

    // A restarted worker holds none; its first pass opens one, and the host replays into it.
    mocks.getHostProvider.mockClear();
    const revived = await freshEngine();
    expect((await revived.tickAllFunding()).ticked).toBe(1);
    expect(mocks.watches).toHaveLength(2);
    expect(openWatch().id).toEqual(BURNER.publicKey);
    expect(mocks.getHostProvider).not.toHaveBeenCalled();
    pushStatus(claimed(true));
    await saved(() => expect(storedJob().claim.phase).toBe("claimed"));
  });

  it("ignores a word about an attempt that is no longer the live one", async () => {
    armSeams();
    const engine = await engineWithRegisteredClaim();
    const first = openWatch();
    pushStatus(partially(SETTLE / 4n));
    mocks.settlementBalance.mockResolvedValueOnce(SETTLE - SETTLE / 4n);
    await engine.tickAllFunding();
    expect(storedJob().claim).toMatchObject({ phase: "claiming", attempt: 1 });

    first.onStatus(claimed(true));
    first.onInterrupt(new PaymentTopUpStatusErr.NotFound());
    const { claim } = await sessionStatus(engine);
    expect(claim).toMatchObject({ phase: "claiming", attempt: 1 });
    expect(claim.status).toBeUndefined();

    pushStatus(claimed(true));
    await saved(() =>
      expect(storedJob().claim).toMatchObject({ phase: "claimed", amount: SETTLE.toString() }),
    );
  });

  it("claims what a partial top-up left on the burner under a fresh id, and sums the credit", async () => {
    armSeams();
    const engine = await engineWithRegisteredClaim();

    // The short verdict ends the attempt and its subscription; the next attempt is sized.
    pushStatus(partially(SETTLE / 4n));
    expect((await sessionStatus(engine)).claim).toMatchObject({
      phase: "sizing",
      attempt: 1,
      credited: (SETTLE / 4n).toString(),
    });
    expect(openWatches()).toHaveLength(0);

    // The remainder is still on the burner; the next pass registers it under its own id and
    // follows it there.
    const remainder = SETTLE - SETTLE / 4n;
    mocks.settlementBalance.mockResolvedValueOnce(remainder);
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    const { secretKey } = deriveKeypairWithSecret(SEED);
    expect(mocks.registerTopUp).toHaveBeenLastCalledWith(
      remainder,
      toSchnorrkelSecret(secretKey),
      topUpIdFor(BURNER.publicKey, 1),
    );
    expect(storedJob().claim).toMatchObject({
      phase: "claiming",
      attempt: 1,
      id: toHex(topUpIdFor(BURNER.publicKey, 1)),
      amount: remainder.toString(),
    });
    expect(storedJob().phase).toBe("done");
    expect(openWatch().id).toEqual(topUpIdFor(BURNER.publicKey, 1));

    pushStatus(claimed(true));
    await saved(() =>
      expect(storedJob().claim).toMatchObject({
        phase: "claimed",
        amount: SETTLE.toString(),
        credited: SETTLE.toString(),
      }),
    );
    expect(storedJob().claim.partial).toBeUndefined();
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("settles on what was credited when the remainder is below the claim unit", async () => {
    armSeams();
    const engine = await engineWithRegisteredClaim();
    const credited = SETTLE - 5_000n;

    pushStatus(partially(credited));
    mocks.settlementBalance.mockResolvedValueOnce(5_000n);
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(mocks.registerTopUp).toHaveBeenCalledTimes(1);
    expect(storedJob().claim).toMatchObject({
      phase: "claimed",
      amount: credited.toString(),
      partial: true,
    });
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("retries a top-up the host never saw funds for while the burner still holds them", async () => {
    armSeams();
    const engine = await engineWithRegisteredClaim();

    pushStatus({ type: "notClaimed" });
    expect((await sessionStatus(engine)).claim).toMatchObject({
      phase: "sizing",
      attempt: 1,
      credited: "0",
    });

    mocks.settlementBalance.mockResolvedValueOnce(SETTLE);
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(mocks.registerTopUp).toHaveBeenLastCalledWith(
      SETTLE,
      expect.any(Uint8Array),
      topUpIdFor(BURNER.publicKey, 1),
    );
    expect(storedJob().claim).toMatchObject({ phase: "claiming", attempt: 1 });
  });

  it("fails a claim nothing was credited for once the burner reads empty, and a re-sent hand-off sizes it again", async () => {
    armSeams();
    const engine = await engineWithRegisteredClaim();

    pushStatus({ type: "notClaimed" });
    mocks.settlementBalance.mockResolvedValueOnce(0n);
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "claim", done: true });
    expect(storedJob().claim).toMatchObject({ phase: "sizing", attempt: 1 });
    expect((await engine.tickAllFunding()).ticked).toBe(0);

    await engine.startFunding(JSON.stringify(HANDOFF));
    mocks.settlementBalance.mockResolvedValueOnce(SETTLE);
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(storedJob().claim).toMatchObject({
      phase: "claiming",
      attempt: 1,
      id: toHex(topUpIdFor(BURNER.publicKey, 1)),
    });
  });

  it("stops registering after three short attempts and settles on the credit, until re-armed", async () => {
    armSeams();
    const engine = await engineWithRegisteredClaim();
    const slice = SETTLE / 10n;

    for (const attempt of [1, 2]) {
      pushStatus(partially(slice));
      expect((await sessionStatus(engine)).claim).toMatchObject({ phase: "sizing", attempt });
      mocks.settlementBalance.mockResolvedValueOnce(SETTLE - slice * BigInt(attempt));
      await engine.tickAllFunding();
      expect(storedJob().claim).toMatchObject({ phase: "claiming", attempt });
    }
    expect(mocks.registerTopUp).toHaveBeenCalledTimes(3);
    expect(mocks.watches).toHaveLength(3);

    // The third short verdict is the last one acted on by the worker itself.
    pushStatus(partially(slice));
    await saved(() =>
      expect(storedJob().claim).toMatchObject({
        phase: "claimed",
        attempt: 2,
        amount: (slice * 3n).toString(),
        partial: true,
      }),
    );
    expect(openWatches()).toHaveLength(0);
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("re-arms a claim that credited nothing in three attempts with a fourth", async () => {
    armSeams();
    const engine = await engineWithRegisteredClaim();

    for (const attempt of [1, 2]) {
      pushStatus({ type: "notClaimed" });
      mocks.settlementBalance.mockResolvedValueOnce(SETTLE);
      await engine.tickAllFunding();
      expect(storedJob().claim).toMatchObject({ phase: "claiming", attempt });
    }
    pushStatus({ type: "notClaimed" });
    await saved(() => expect(storedJob()).toMatchObject({ phase: "failed", failure: "claim" }));
    expect(storedJob().claim).toMatchObject({ phase: "claiming", attempt: 2 });
    // A failed job holds no subscription.
    expect(openWatches()).toHaveLength(0);

    await engine.startFunding(JSON.stringify(HANDOFF));
    expect(storedJob().claim).toMatchObject({ phase: "sizing", attempt: 3 });
    mocks.settlementBalance.mockResolvedValueOnce(SETTLE);
    await engine.tickAllFunding();
    expect(mocks.registerTopUp).toHaveBeenLastCalledWith(
      SETTLE,
      expect.any(Uint8Array),
      topUpIdFor(BURNER.publicKey, 3),
    );
    expect(storedJob().claim).toMatchObject({ phase: "claiming", attempt: 3 });
  });

  it("does not register a claim on an empty read", async () => {
    // Nothing to claim yet; the job waits for a read it can act on.
    armSeams();
    const engine = await engineWithLandedJob();
    mocks.settlementBalance.mockResolvedValueOnce(0n);
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(mocks.registerTopUp).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ done: true });
    expect(storedJob().claim).toBeUndefined();

    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.registerTopUp.mockResolvedValue(undefined);
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(storedJob().claim).toMatchObject({ phase: "claiming", amount: SETTLE.toString() });
  });

  it("gives up registering after the run bound of worker time, and a re-sent hand-off tries again", async () => {
    armSeams();
    vi.useFakeTimers();
    const engine = await engineWithLandedJob();
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.registerTopUp.mockRejectedValue(new Error("host busy"));

    // Ticks every 30s (each gap counts in full) for the whole bound, retrying every 3 minutes.
    const ticks = Math.ceil(900_000 / 30_000) + 2;
    for (let tick = 0; tick < ticks; tick += 1) {
      await engine.tickAllFunding();
      vi.advanceTimersByTime(30_000);
    }
    expect(mocks.registerTopUp).toHaveBeenCalledTimes(6);
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout", done: true });
    expect(storedJob().lastError).toContain("claim exceeded");
    expect((await engine.tickAllFunding()).ticked).toBe(0);

    // Re-opening the request re-arms the registration: no retry window to wait out.
    mocks.registerTopUp.mockResolvedValue(undefined);
    const rearmed = await engine.startFunding(JSON.stringify(HANDOFF));
    expect(rearmed).toMatchObject({ phase: "done", done: true });
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(storedJob().claim).toMatchObject({ phase: "claiming", attempts: 1 });
  });

  it("stops the worker's clock once the host owns the claim, and fails it only past the tracking window", async () => {
    armSeams();
    vi.useFakeTimers();
    const engine = await engineWithLandedJob();
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.registerTopUp.mockResolvedValue(undefined);
    await engine.tickAllFunding();
    expect(storedJob().claim.phase).toBe("claiming");
    pushStatus({ type: "claiming" });

    // Well past the run bound the job is still live: the host is claiming, not the worker.
    const ticks = Math.ceil(900_000 / 30_000) + 2;
    for (let tick = 0; tick < ticks; tick += 1) {
      vi.advanceTimersByTime(30_000);
      await engine.tickAllFunding();
    }
    expect(storedJob().phase).toBe("done");
    expect(storedJob().state.workedMs).toBe(0);
    expect(mocks.watches).toHaveLength(1);

    // Ninety minutes after registration with no verdict, the job is failed and let go of,
    // subscription included.
    vi.advanceTimersByTime(5_400_000 - ticks * 30_000);
    await engine.tickAllFunding();
    expect(storedJob().phase).toBe("done");
    vi.advanceTimersByTime(30_000);
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout" });
    expect(storedJob().lastError).toContain("has not settled");
    expect(openWatches()).toHaveLength(0);
    expect((await engine.tickAllFunding()).ticked).toBe(0);

    // A re-sent hand-off re-arms the tracking and the subscription; the host's verdict settles
    // the job.
    await engine.startFunding(JSON.stringify(HANDOFF));
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(mocks.watches).toHaveLength(2);
    pushStatus(claimed(true));
    await saved(() =>
      expect(storedJob().claim).toMatchObject({ phase: "claimed", amount: SETTLE.toString() }),
    );
    expect(mocks.registerTopUp).toHaveBeenCalledTimes(1);
  });

  it("connects to no chain while the host has the claim, and to People alone to size one", async () => {
    armSeams();
    vi.useFakeTimers();
    const engine = await engineWithLandedJob();
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.registerTopUp.mockRejectedValueOnce(new Error("host busy"));
    // The landing tick converts over both chains and sizes over its own People connection.
    await engine.tickAllFunding();
    expect(storedJob().claim.phase).toBe("registering");
    expect(mocks.getHostProvider.mock.calls.map((call) => call[0])).toEqual([
      ASSET_HUB_GENESIS,
      PEOPLE_GENESIS,
    ]);
    mocks.getHostProvider.mockClear();

    // A registration retry needs the host alone.
    vi.advanceTimersByTime(180_001);
    mocks.registerTopUp.mockResolvedValue(undefined);
    await engine.tickAllFunding();
    expect(storedJob().claim.phase).toBe("claiming");
    expect(mocks.getHostProvider).not.toHaveBeenCalled();

    // So does following the claim.
    pushStatus({ type: "claiming" });
    await engine.tickAllFunding();
    expect(mocks.getHostProvider).not.toHaveBeenCalled();
    expect(mocks.settlementBalance).toHaveBeenCalledTimes(1);

    // Sizing the next attempt reads People, and People only.
    pushStatus({ type: "notClaimed" });
    await engine.tickAllFunding();
    expect(storedJob().claim).toMatchObject({ phase: "claiming", attempt: 1 });
    expect(mocks.getHostProvider.mock.calls.map((call) => call[0])).toEqual([PEOPLE_GENESIS]);
  });

  it("keeps a word that lands while the pass is saving the same job", async () => {
    armSeams();
    const engine = await engineWithRegisteredClaim();
    mocks.holdWrites = true;
    const pass = engine.tickAllFunding();
    await vi.waitFor(() => expect(mocks.heldWrites).toHaveLength(1));

    // The pass's write is in flight with a snapshot from before the word arrived.
    pushStatus(claimed(false));
    expect((await sessionStatus(engine)).claim.status).toBe("claimed");
    await turn();
    expect(mocks.heldWrites).toHaveLength(1);

    mocks.heldWrites.shift()!();
    await pass;
    expect(storedJob().claim.status).toBeUndefined();
    await vi.waitFor(() => expect(mocks.heldWrites).toHaveLength(1));
    mocks.heldWrites.shift()!();
    await saved(() => expect(storedJob().claim.status).toBe("claimed"));
  });

  it("loads the job map once, however many callers race for it at boot", async () => {
    armSeams();
    const engine = await freshEngine();
    await Promise.all([
      engine.startFunding(JSON.stringify(HANDOFF)),
      engine.startFunding(JSON.stringify({ ...HANDOFF, sessionId: "s-2" })),
      engine.tickAllFunding(),
    ]);
    const stored = mocks.stored.get("getsome.funding.jobs") as { [id: string]: unknown };
    expect(Object.keys(stored).sort()).toEqual(["s-1", "s-2"]);
  });
});

describe("worker job store", () => {
  it("writes one save at a time, in order, so a later map never lands under an earlier one", async () => {
    armSeams();
    vi.resetModules();
    const { createJobStore } = await import("../worker/src/shared.js");
    const store = createJobStore("jobs", "test");
    const jobs: { [key: string]: number } = await store.load();
    mocks.holdWrites = true;

    jobs.a = 1;
    const first = store.save();
    await vi.waitFor(() => expect(mocks.heldWrites).toHaveLength(1));
    jobs.b = 2;
    const second = store.save();
    await turn();
    // The second write waits for the first to land.
    expect(mocks.heldWrites).toHaveLength(1);

    mocks.heldWrites.shift()!();
    await first;
    expect(mocks.stored.get("jobs")).toEqual({ a: 1 });
    await vi.waitFor(() => expect(mocks.heldWrites).toHaveLength(1));
    mocks.heldWrites.shift()!();
    await second;
    expect(mocks.stored.get("jobs")).toEqual({ a: 1, b: 2 });
  });
});
