// The worker funding engine, offline: chain and pipeline seams are scripted, records and
// derivation are real.

import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveKeypair, deriveKeypairWithSecret, toSchnorrkelSecret } from "@getsome/ephemeral";

const mocks = vi.hoisted(() => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  topUpFromBurner: vi.fn(),
  stored: new Map<string, unknown>(),
  storageDown: false,
  tickOnce: vi.fn(),
  discoverPool: vi.fn(),
  settlementBalance: vi.fn(),
}));

// The worker's host adapter is the seam to mock; the SDK behind it never loads here.
vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: mocks.deriveEntropy,
  getHostProvider: mocks.getHostProvider,
  topUpFromBurner: mocks.topUpFromBurner,
  getHostLocalStorage: async () => ({
    readJSON: async (key: string) => {
      if (mocks.storageDown) throw new Error("storage down");
      return mocks.stored.get(key) ?? null;
    },
    writeJSON: async (key: string, value: unknown) => {
      if (mocks.storageDown) throw new Error("storage down");
      // Snapshot, as real storage does.
      mocks.stored.set(key, JSON.parse(JSON.stringify(value)));
    },
  }),
}));

vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  tickOnce: mocks.tickOnce,
  discoverPool: mocks.discoverPool,
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

/** Fresh engine module (module-scope caches reset), same persistent "host storage". */
async function freshEngine(): Promise<Engine> {
  vi.resetModules();
  return await import("../worker/src/engine.js");
}

const storedJob = (): StoredJob =>
  (mocks.stored.get("getsome.funding.jobs") as { [id: string]: StoredJob })["s-1"];

const outcome = (step: string) => ({ step, balances: {}, submitted: false });

function armSeams() {
  // Reset first: a leftover mockImplementationOnce from an earlier test must not leak.
  mocks.deriveEntropy.mockReset();
  mocks.getHostProvider.mockReset();
  mocks.discoverPool.mockReset();
  mocks.tickOnce.mockReset();
  mocks.topUpFromBurner.mockReset();
  mocks.settlementBalance.mockReset();
  mocks.deriveEntropy.mockResolvedValue({ ok: true, value: SEED });
  mocks.getHostProvider.mockImplementation(async (genesis: string) => ({ genesis }));
  mocks.discoverPool.mockResolvedValue({ native: "N", underlying: "U" });
  mocks.stored.clear();
  mocks.storageDown = false;
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

  it("persists the submitting marker before the submit, and the tx after it", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startFunding(JSON.stringify(HANDOFF));
    mocks.tickOnce.mockImplementationOnce(async (input) => {
      await input.onBeforeSubmit("swap");
      // The marker is durable before a broadcast could leave.
      expect(storedJob().submitting).toMatchObject({ call: "swap" });
      input.onTx({ call: "swap", txHash: SWAP_TX, block: 42 });
      return { ...outcome("await-arrival"), submitted: true };
    });
    await engine.tickAllFunding();
    expect(storedJob().submitting).toBeUndefined();
    expect(storedJob().txs).toEqual([{ call: "swap", txHash: SWAP_TX, block: 42 }]);
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
      state.fundsSeenAt = Date.now();
      throw new funding.FundingShortfallError(SETTLE - 5_000n, SETTLE);
    });
    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({
      phase: "failed",
      failure: "shortfall",
      state: { xcmSubmitted: true, peopleAtXcm: "100" },
    });

    await engine.startFunding(JSON.stringify(HANDOFF));
    expect(storedJob().state).toMatchObject({
      attempts: 0,
      xcmSubmitted: false,
      peopleAtXcm: "0",
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
    mocks.topUpFromBurner.mockResolvedValue(undefined);

    await engine.tickAllFunding();
    expect(storedJob()).toMatchObject({ done: true, claim: { phase: "claimed" } });
    expect(storedJob().failure).toBeUndefined();
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("takes the host's answer as the verdict: claimed the moment the top-up resolves", async () => {
    armSeams();
    const engine = await engineWithLandedJob();
    // The burner still reads full after the call; the claim is recorded on the host's answer.
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.topUpFromBurner.mockResolvedValue(undefined);

    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(mocks.topUpFromBurner).toHaveBeenCalledTimes(1);
    // One read sized the claim; nothing is read back after the host answered.
    expect(mocks.settlementBalance).toHaveBeenCalledTimes(1);
    const status = await engine.fundingStatus(JSON.stringify({ sessionId: "s-1" }));
    expect(status.claim).toMatchObject({ phase: "claimed", amount: SETTLE.toString() });
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("claims the landed CASH itself, in the same tick, and only then retires the job", async () => {
    armSeams();
    const engine = await engineWithLandedJob();
    // 20.005 CASH on People: the claim floors to the coin unit, dust stays.
    mocks.settlementBalance.mockResolvedValueOnce(SETTLE + 5_000n);
    mocks.topUpFromBurner.mockResolvedValue(undefined);

    expect((await engine.tickAllFunding()).ticked).toBe(1);

    // The host is handed the burner's secret in schnorrkel's canonical layout.
    const { secretKey } = deriveKeypairWithSecret(SEED);
    expect(mocks.topUpFromBurner).toHaveBeenCalledExactlyOnceWith(
      SETTLE,
      toSchnorrkelSecret(secretKey),
    );
    const status = await engine.fundingStatus(JSON.stringify({ sessionId: "s-1" }));
    expect(status).toMatchObject({
      done: true,
      claim: { phase: "claimed", amount: SETTLE.toString() },
    });
    // Finished: nothing left to drive.
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("keeps a job alive while its claim is unsettled, and reads an empty burner as landed", async () => {
    armSeams();
    vi.useFakeTimers();
    const engine = await engineWithLandedJob();
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.topUpFromBurner.mockRejectedValueOnce(new Error("host busy"));

    expect((await engine.tickAllFunding()).ticked).toBe(1);
    let status = await engine.fundingStatus(JSON.stringify({ sessionId: "s-1" }));
    // Durable marker survives the failure; the job is still live.
    expect(status.claim).toMatchObject({
      phase: "claiming",
      amount: SETTLE.toString(),
      attempts: 1,
      error: "host busy",
    });
    expect(status.lastError).toBe("host busy");

    // Inside the retry window nothing is re-called.
    vi.advanceTimersByTime(120_000);
    await engine.tickAllFunding();
    expect(mocks.topUpFromBurner).toHaveBeenCalledTimes(1);

    // Past the window the burner reads empty: the failed-looking call had landed.
    vi.advanceTimersByTime(61_000);
    mocks.settlementBalance.mockResolvedValue(0n);
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(mocks.topUpFromBurner).toHaveBeenCalledTimes(1);
    status = await engine.fundingStatus(JSON.stringify({ sessionId: "s-1" }));
    expect(status.claim).toMatchObject({ phase: "claimed", amount: SETTLE.toString() });
    expect((await engine.tickAllFunding()).ticked).toBe(0);
  });

  it("does not retire a job on an empty read it has no marker for", async () => {
    // An empty read with no marker proves nothing; the job waits for a read it can act on.
    armSeams();
    const engine = await engineWithLandedJob();
    mocks.settlementBalance.mockResolvedValueOnce(0n);
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(mocks.topUpFromBurner).not.toHaveBeenCalled();
    expect(storedJob()).toMatchObject({ done: true });
    expect(storedJob().claim).toBeUndefined();

    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.topUpFromBurner.mockResolvedValue(undefined);
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(storedJob().claim).toMatchObject({ phase: "claimed", amount: SETTLE.toString() });
  });

  it("gives a claim up when it has used the run bound of worker time, and a re-sent hand-off tries again", async () => {
    armSeams();
    vi.useFakeTimers();
    const engine = await engineWithLandedJob();
    mocks.settlementBalance.mockResolvedValue(SETTLE);
    mocks.topUpFromBurner.mockRejectedValue(new Error("host busy"));

    // Ticks every 30s (each gap counts in full) for the whole bound, retrying every 3 minutes.
    const ticks = Math.ceil(900_000 / 30_000) + 2;
    for (let tick = 0; tick < ticks; tick += 1) {
      await engine.tickAllFunding();
      vi.advanceTimersByTime(30_000);
    }
    expect(mocks.topUpFromBurner).toHaveBeenCalledTimes(6);
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout", done: true });
    expect(storedJob().lastError).toContain("claim exceeded");
    expect((await engine.tickAllFunding()).ticked).toBe(0);

    // Re-opening the request re-arms the claim: no retry window to wait out.
    mocks.topUpFromBurner.mockResolvedValue(undefined);
    const rearmed = await engine.startFunding(JSON.stringify(HANDOFF));
    expect(rearmed).toMatchObject({ phase: "done", done: true });
    expect((await engine.tickAllFunding()).ticked).toBe(1);
    expect(storedJob().claim).toMatchObject({ phase: "claimed", attempts: 1 });
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
