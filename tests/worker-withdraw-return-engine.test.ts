// The worker's residue return, offline: chain and pipeline seams are scripted, records and
// derivation are real. Mirrors tests/worker-withdraw-engine.test.ts and tests/worker-engine.test.ts
// in style -- this engine sits between the two, reusing the withdrawal job store and the funding
// pipeline's own tick.

import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveKeypair, deriveKeypairWithSecret, toSchnorrkelSecret } from "@getsome/ephemeral";
import { RETURN_FLOOR_PLANCK } from "@getsome/withdraw";
import { PaymentTopUpErr, PaymentTopUpStatusErr } from "@novasamatech/host-api";

const mocks = vi.hoisted(() => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  stored: new Map<string, unknown>(),
  storageDown: false,
  withdrawTickOnce: vi.fn(),
  tickOnce: vi.fn(),
  discoverPool: vi.fn(),
  registerTopUp: vi.fn(),
  readTopUpStatus: vi.fn(),
  settlementBalance: vi.fn(),
  burnerAhFree: 0n,
  burnerAhNonce: 0,
}));

// The worker's host adapter is the seam to mock; the SDK behind it never loads here.
vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: mocks.deriveEntropy,
  getHostProvider: mocks.getHostProvider,
  registerTopUp: mocks.registerTopUp,
  readTopUpStatus: mocks.readTopUpStatus,
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

// Only the payment tick is mocked; the residue engine drives the REAL paymentResolved,
// restoreWithdrawTickState and readBurnerOnAssetHub against the scripted asset-hub api below, so
// the gate this file exists to prove is genuinely exercised, not assumed.
vi.mock("@getsome/withdraw", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withdrawTickOnce: mocks.withdrawTickOnce,
}));

vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  tickOnce: mocks.tickOnce,
  discoverPool: mocks.discoverPool,
}));

vi.mock("@getsome/people", () => ({
  CASH_LOCATION: { fake: "cash-location" },
  CASH_SETTLEMENT: { kind: "foreign", id: "cash" },
  createPeopleChainPort: () => ({ settlementBalance: mocks.settlementBalance }),
}));

/** A 32-byte hash of one repeated byte. */
const hash32 = (fill: number) => `0x${fill.toString(16).padStart(2, "0").repeat(32)}`;
const ASSET_HUB_GENESIS = hash32(0x11);
const PEOPLE_GENESIS = hash32(0x22);
const BEST_BLOCK = hash32(0x33);

const assetHubApiFake = {
  query: {
    System: {
      Account: {
        getValue: async () => ({
          data: { free: mocks.burnerAhFree },
          nonce: mocks.burnerAhNonce,
        }),
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
const KEY_SECRET = deriveKeypairWithSecret(SEED);
const KEY_HEX = `0x${Array.from(KEY.publicKey, (b) => b.toString(16).padStart(2, "0")).join("")}`;

const DESTINATION = { chain: "Asset Hub", asset: "PAS", address: "dest" };

const MELD = {
  committedAmount: "900000000",
  providerPayoutAddress: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
  orderRef: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  meldFundingRequestId: "funding-req-1",
  quotedFiatAmount: "156.30",
  quotedFiatCurrency: "USD",
  cryptoCurrency: "DOT_ASSETHUB",
};

const MELD_HANDOFF = {
  sessionId: "s-1",
  label: "wd:eph:pas-assethub:1",
  keyAddress: KEY.address,
  keyPublicKeyHex: KEY_HEX,
  amount: "21000000",
  destination: DESTINATION,
  landingHex: KEY_HEX,
  rail: "meld",
  meld: MELD,
  assetHubGenesis: ASSET_HUB_GENESIS,
  peopleGenesis: PEOPLE_GENESIS,
  peopleParaId: 1502,
  assetHubParaId: 1500,
  poolAccount: "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B",
  slippagePct: 5,
  paymentExpiresAt: Date.now() + 1_800_000,
};

type Engine = typeof import("../worker/src/withdraw-engine.js");
type StoredJob = { [key: string]: any };

/** Fresh engine module (module-scope caches reset), same persistent "host storage" -- what stands
 *  in for a worker reload across a test. */
async function freshEngine(): Promise<Engine> {
  vi.resetModules();
  return await import("../worker/src/withdraw-engine.js");
}

const storedJob = (): StoredJob =>
  (mocks.stored.get("getsome.withdraw.jobs") as { [id: string]: StoredJob })["s-1"];

const paymentOutcome = (step: string, submitted = false) => ({
  step,
  balances: { cash: 0n, pas: 0n },
  submitted,
});

const fundingOutcome = (step: string, submitted = false) => ({
  step,
  balances: { nativeAh: 0n, underlyingPeople: 0n },
  submitted,
});

const claimed = (finalized: boolean) => ({ type: "claimed", finalized });

function armSeams() {
  mocks.deriveEntropy.mockReset();
  mocks.getHostProvider.mockReset();
  mocks.withdrawTickOnce.mockReset();
  mocks.tickOnce.mockReset();
  mocks.discoverPool.mockReset();
  mocks.registerTopUp.mockReset();
  mocks.readTopUpStatus.mockReset();
  mocks.settlementBalance.mockReset();
  mocks.deriveEntropy.mockResolvedValue({ ok: true, value: SEED });
  mocks.getHostProvider.mockImplementation(async (genesis: string) => ({ genesis }));
  mocks.discoverPool.mockResolvedValue({ native: "N", underlying: "U" });
  mocks.stored.clear();
  mocks.storageDown = false;
  mocks.burnerAhFree = 0n;
  mocks.burnerAhNonce = 0;
}

/** Drives a meld withdrawal to `done`, its provider paid, with `residue` PAS left on the burner
 *  -- the ordinary case a return is for. */
async function landedPaidJob(engine: Engine, residue: bigint): Promise<void> {
  await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));
  mocks.withdrawTickOnce.mockResolvedValueOnce(paymentOutcome("pay-provider", true));
  await engine.tickAllWithdraw();
  mocks.withdrawTickOnce.mockResolvedValueOnce(paymentOutcome("done"));
  await engine.tickAllWithdraw();
  expect(storedJob()).toMatchObject({ phase: "done", done: true });
  mocks.burnerAhFree = residue;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("worker withdrawal residue return", () => {
  it("a run bound tripping over an outstanding pin fails 'unresolved', not 'timeout' -- kept off the return's coarse filter entirely", async () => {
    armSeams();
    vi.useFakeTimers();
    const engine = await freshEngine();
    await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));

    // Reach pay-provider with a pin taken and no answer yet: exactly what payProvider leaves
    // behind when a submit's answer is lost. The commitment is genuinely in flight.
    mocks.withdrawTickOnce.mockImplementationOnce(async (_input: unknown, state: any) => {
      state.payNonce = 3;
      state.payAmount = 900_000_000n;
      state.payFreeBefore = 950_000_000n;
      state.payAttempts = 1;
      state.fundsSeenAt = Date.now();
      return paymentOutcome("pay-provider", true);
    });
    await engine.tickAllWithdraw();
    expect(storedJob().phase).toBe("pay-provider");

    // The run bound trips while that payment is still unresolved. judgeBounds must not file this
    // as an ordinary "timeout" -- eligibleForReturn's coarse filter admits everything that is not
    // "unresolved", so an outstanding pin filed under "timeout" would reach the return engine's
    // gate on every pass for no reason, relying entirely on paymentResolved to keep refusing it
    // forever. Filed correctly, it never reaches the return engine's gate at all.
    mocks.withdrawTickOnce.mockResolvedValue(paymentOutcome("pay-provider"));
    const ticks = Math.ceil(1_800_000 / 30_000) + 2;
    for (let i = 0; i < ticks; i += 1) {
      await engine.tickAllWithdraw();
      vi.advanceTimersByTime(30_000);
    }
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "unresolved" });
    expect(storedJob().state.payAmount).toEqual({ $bigint: "900000000" });
    expect(storedJob().state.paidTxHash).toBeNull();

    // The burner genuinely holds a return-worthy residue -- if eligibleForReturn's coarse filter
    // did not exclude "unresolved", this would be swept.
    mocks.burnerAhFree = RETURN_FLOOR_PLANCK * 10n;

    const ticked = await engine.tickAllWithdrawReturn();
    expect(ticked).toEqual({ ticked: 0, busy: false }); // never even attempted
    expect(storedJob().return).toBeUndefined();
    expect(storedJob().returnStarted).toBeUndefined();
    expect(mocks.tickOnce).not.toHaveBeenCalled();
    expect(mocks.registerTopUp).not.toHaveBeenCalled();

    // A re-sent hand-off does not resurrect it either: rearm() refuses "unresolved" outright.
    const resent = await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));
    expect(resent).toMatchObject({ phase: "failed", failure: "unresolved" });
  });

  it("claims the record synchronously before any chain call, so a concurrent re-sent hand-off cannot win the race", async () => {
    // The TOCTOU this whole module exists to close: an earlier draft set `returnStarted` only
    // AFTER awaiting a real balance read (a genuine network round trip), which left a window
    // measured in real time where a re-sent hand-off could see `returnStarted` still false and
    // re-arm the job while the return believed it already owned it. This proves the fix: the
    // record is claimed durably before the FIRST await this whole tick makes, by stalling that
    // very await (keypairFor's own entropy derivation) and racing a hand-off against it.
    //
    // Only the "failed" path exercises rearm() at all -- a "done" record is never handed to
    // rearm() in the first place (startWithdraw only calls it when `phase === "failed"`), so the
    // unwind path is the one that actually puts the guard under test, driven to "failed"
    // legitimately (a real run-bound timeout) rather than by poking the record directly.
    armSeams();
    vi.useFakeTimers();
    const engine = await freshEngine();
    await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));
    mocks.withdrawTickOnce.mockImplementationOnce(async (_input: unknown, state: any) => {
      state.fundsSeenAt = Date.now();
      state.submitted = true;
      return paymentOutcome("await-arrival");
    });
    await engine.tickAllWithdraw();
    mocks.withdrawTickOnce.mockResolvedValue(paymentOutcome("await-arrival"));
    const boundTicks = Math.ceil(900_000 / 30_000) + 2;
    for (let i = 0; i < boundTicks; i += 1) {
      await engine.tickAllWithdraw();
      vi.advanceTimersByTime(30_000);
    }
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout" });
    mocks.burnerAhFree = RETURN_FLOOR_PLANCK * 10n;
    // Real timers from here: vi.waitFor below polls on a real setTimeout, which a frozen fake
    // clock would never advance on its own.
    vi.useRealTimers();

    let releaseDerive: (() => void) | null = null;
    mocks.deriveEntropy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDerive = () => resolve({ ok: true, value: SEED });
        }),
    );
    const returnTick = engine.tickAllWithdrawReturn();
    // Give the synchronous claim a chance to run and its strict persist to land, but go no
    // further -- keypairFor's own deriveEntropy call is still hanging.
    await vi.waitFor(() => expect(storedJob().returnStarted).toBe(true));
    expect(storedJob().return).toMatchObject({ reason: "unwind", phase: "checking-floor" });

    // The claim already landed durably. A re-sent hand-off racing in right now must lose.
    const resent = await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));
    expect(resent).toMatchObject({ phase: "failed", failure: "timeout" });
    expect(storedJob().phase).toBe("failed"); // NOT re-armed to "starting"
    // And the payment engine's own live filter still refuses it -- rearm() never flipped it back.
    expect((await engine.tickAllWithdraw()).ticked).toBe(0);

    releaseDerive!();
    await returnTick;
    expect(storedJob().return.phase).not.toBe("checking-floor"); // the tick completed normally
  });

  it("leaves a residue under the floor alone, and says so", async () => {
    armSeams();
    const engine = await freshEngine();
    await landedPaidJob(engine, RETURN_FLOOR_PLANCK - 1n);

    expect((await engine.tickAllWithdrawReturn()).ticked).toBe(1);
    expect(storedJob()).toMatchObject({ returnStarted: true });
    expect(storedJob().return).toMatchObject({
      reason: "residue",
      phase: "left-below-floor",
      returned: false,
    });
    expect(mocks.tickOnce).not.toHaveBeenCalled();
    expect(mocks.registerTopUp).not.toHaveBeenCalled();

    // Terminal: a later pass does not touch it again.
    expect((await engine.tickAllWithdrawReturn()).ticked).toBe(0);
    // And the sale's own record is exactly as it was.
    expect(storedJob()).toMatchObject({ phase: "done", done: true });
    expect(storedJob().failure).toBeFalsy();
  });

  it("returns everything in the unwind case, and the record reads honestly", async () => {
    armSeams();
    vi.useFakeTimers();
    const engine = await freshEngine();
    await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));

    // The sale landed on the burner (CASH is gone, PAS arrived) but the payment never started --
    // paymentResolved is true because payAmount was never set, not because anything resolved a
    // pin. The run bound then trips while still waiting: a lapsed session, a provider that
    // concluded the request, or an unusable payout address all end here the same way.
    mocks.withdrawTickOnce.mockImplementationOnce(async (_input: unknown, state: any) => {
      state.fundsSeenAt = Date.now();
      state.submitted = true;
      return paymentOutcome("await-arrival");
    });
    await engine.tickAllWithdraw();
    mocks.withdrawTickOnce.mockResolvedValue(paymentOutcome("await-arrival"));
    const ticks = Math.ceil(1_800_000 / 30_000) + 2;
    for (let i = 0; i < ticks; i += 1) {
      await engine.tickAllWithdraw();
      vi.advanceTimersByTime(30_000);
    }
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout", done: false });
    expect(storedJob().state.payAmount).toBeNull(); // never attempted: paymentResolved holds

    const WHOLE_SALE = RETURN_FLOOR_PLANCK * 50n;
    mocks.burnerAhFree = WHOLE_SALE;

    // The residue leg: one funding-program submit lands the CASH on the key's own People
    // account.
    mocks.tickOnce.mockResolvedValueOnce(fundingOutcome("swap", true));
    expect((await engine.tickAllWithdrawReturn()).ticked).toBe(1);
    expect(storedJob().return).toMatchObject({ reason: "unwind", phase: "swap" });
    // The sale's own terminal fields are untouched by any of this.
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout", done: false });

    mocks.tickOnce.mockResolvedValueOnce(fundingOutcome("done"));
    mocks.settlementBalance.mockResolvedValueOnce(WHOLE_SALE);
    mocks.registerTopUp.mockResolvedValueOnce(undefined);
    expect((await engine.tickAllWithdrawReturn()).ticked).toBe(1);
    expect(storedJob().return).toMatchObject({
      phase: "done",
      claim: { registeredAt: expect.any(Number) },
    });
    expect(mocks.registerTopUp).toHaveBeenCalledExactlyOnceWith(
      WHOLE_SALE,
      toSchnorrkelSecret(KEY_SECRET.secretKey),
      KEY.publicKey,
    );

    mocks.readTopUpStatus.mockResolvedValueOnce(claimed(true));
    expect((await engine.tickAllWithdrawReturn()).ticked).toBe(1);
    expect(storedJob().return).toMatchObject({
      reason: "unwind",
      returned: true,
      returnedAmount: WHOLE_SALE.toString(),
    });
    // Honesty: the sale never paid anyone, and the top-level record still says so plainly --
    // nothing here can be read by a seller as "sent".
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout", done: false });
    expect((await engine.tickAllWithdrawReturn()).ticked).toBe(0);
  });

  it("a failure in the return does not fail the sale, and is retried on the next pass", async () => {
    armSeams();
    const engine = await freshEngine();
    await landedPaidJob(engine, RETURN_FLOOR_PLANCK * 10n);

    mocks.tickOnce.mockRejectedValueOnce(new Error("rpc blip"));
    expect((await engine.tickAllWithdrawReturn()).ticked).toBe(1);
    // The gate already ran and committed this job to the return (the floor cleared), so a
    // transient failure inside the funding leg lands on the return's own record.
    expect(storedJob().returnStarted).toBe(true);
    expect(storedJob().return.lastError).toBe("rpc blip");
    // The sale itself is completely unaffected.
    expect(storedJob()).toMatchObject({ phase: "done", done: true });
    expect(storedJob().failure).toBeFalsy();

    // Retried, with no memory of the failure once it clears.
    mocks.tickOnce.mockResolvedValueOnce(fundingOutcome("done"));
    mocks.settlementBalance.mockResolvedValueOnce(RETURN_FLOOR_PLANCK * 10n);
    mocks.registerTopUp.mockResolvedValueOnce(undefined);
    mocks.readTopUpStatus.mockResolvedValueOnce(claimed(true));
    expect((await engine.tickAllWithdrawReturn()).ticked).toBe(1);
    expect(storedJob().return.lastError).toBeUndefined();
    expect((await engine.tickAllWithdrawReturn()).ticked).toBe(1);
    expect(storedJob().return).toMatchObject({ returned: true });
  });

  it("round-trips the return's own state through a simulated reload, and resumes exactly", async () => {
    armSeams();
    const started = await freshEngine();
    await landedPaidJob(started, RETURN_FLOOR_PLANCK * 10n);

    mocks.tickOnce.mockImplementationOnce(async (_input: unknown, state: any) => {
      state.attempts = 1;
      state.xcmSubmitted = true;
      return { ...fundingOutcome("swap"), submitted: true };
    });
    await started.tickAllWithdrawReturn();
    expect(storedJob().return).toMatchObject({
      phase: "swap",
      state: { attempts: 1, xcmSubmitted: true },
    });

    // The reload: a fresh module, no memory but the store.
    const revived = await freshEngine();
    mocks.tickOnce.mockImplementationOnce(async (_input: unknown, state: any) => {
      // The pipeline state survived the round trip untouched.
      expect(state.attempts).toBe(1);
      expect(state.xcmSubmitted).toBe(true);
      return fundingOutcome("done");
    });
    mocks.settlementBalance.mockResolvedValueOnce(RETURN_FLOOR_PLANCK * 10n);
    mocks.registerTopUp.mockResolvedValueOnce(undefined);
    mocks.readTopUpStatus.mockResolvedValueOnce(claimed(true));
    await revived.tickAllWithdrawReturn();
    await revived.tickAllWithdrawReturn();
    expect(storedJob().return).toMatchObject({ returned: true });
  });

  it("cannot be resurrected by a re-sent hand-off once the return has started (the unwind path)", async () => {
    // The other half of "impossible to start": impossible to UNDO, too. rearm() must refuse a
    // failed job the return has already claimed, or a re-sent hand-off would drive
    // withdrawTickOnce straight back into a burner the return has already signed from -- the
    // exact misread contract 4 in tick.ts's header describes.
    armSeams();
    vi.useFakeTimers();
    const engine = await freshEngine();
    await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));
    mocks.withdrawTickOnce.mockImplementationOnce(async (_input: unknown, state: any) => {
      state.fundsSeenAt = Date.now();
      state.submitted = true;
      return paymentOutcome("await-arrival");
    });
    await engine.tickAllWithdraw();
    mocks.withdrawTickOnce.mockResolvedValue(paymentOutcome("await-arrival"));
    const ticks = Math.ceil(1_800_000 / 30_000) + 2;
    for (let i = 0; i < ticks; i += 1) {
      await engine.tickAllWithdraw();
      vi.advanceTimersByTime(30_000);
    }
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout" });

    mocks.burnerAhFree = RETURN_FLOOR_PLANCK * 10n;
    mocks.tickOnce.mockResolvedValueOnce(fundingOutcome("swap", true));
    await engine.tickAllWithdrawReturn();
    expect(storedJob()).toMatchObject({ returnStarted: true, phase: "failed", failure: "timeout" });

    // A re-sent hand-off is exactly what a seller reopening the withdrawal from the surface would
    // trigger. It must not re-arm this job: phase, failure and done stay exactly as they were.
    const resent = await engine.startWithdraw(JSON.stringify(MELD_HANDOFF));
    expect(resent).toMatchObject({ phase: "failed", failure: "timeout" });
    expect(storedJob()).toMatchObject({ phase: "failed", failure: "timeout", returnStarted: true });
    // And the payment engine still refuses to tick it: no NEW call reaches withdrawTickOnce.
    const callsBeforeResend = mocks.withdrawTickOnce.mock.calls.length;
    expect((await engine.tickAllWithdraw()).ticked).toBe(0);
    expect(mocks.withdrawTickOnce.mock.calls.length).toBe(callsBeforeResend);
  });

  it("keeps the registering marker across a failed call and takes AlreadyExists as registered", async () => {
    armSeams();
    vi.useFakeTimers();
    const engine = await freshEngine();
    await landedPaidJob(engine, RETURN_FLOOR_PLANCK * 10n);
    mocks.tickOnce.mockResolvedValueOnce(fundingOutcome("done"));
    mocks.settlementBalance.mockResolvedValue(RETURN_FLOOR_PLANCK * 10n);
    mocks.registerTopUp.mockRejectedValueOnce(new Error("host busy"));

    await engine.tickAllWithdrawReturn();
    expect(storedJob().return.claim).toMatchObject({ error: "host busy" });
    expect(storedJob().return.claim.registeredAt).toBeUndefined();

    // Inside the retry window nothing is re-called.
    vi.advanceTimersByTime(120_000);
    await engine.tickAllWithdrawReturn();
    expect(mocks.registerTopUp).toHaveBeenCalledTimes(1);

    // Past the window the host already knows the id: the failed-looking call had registered.
    vi.advanceTimersByTime(61_000);
    mocks.registerTopUp.mockRejectedValueOnce(new PaymentTopUpErr.AlreadyExists());
    await engine.tickAllWithdrawReturn();
    expect(mocks.registerTopUp).toHaveBeenCalledTimes(2);
    expect(storedJob().return.claim.error).toBeUndefined();
    expect(storedJob().return.claim.registeredAt).toEqual(expect.any(Number));

    mocks.readTopUpStatus.mockResolvedValueOnce(claimed(true));
    await engine.tickAllWithdrawReturn();
    expect(storedJob().return).toMatchObject({ returned: true });
  });

  it("re-registers a claim the host does not know", async () => {
    armSeams();
    const engine = await freshEngine();
    await landedPaidJob(engine, RETURN_FLOOR_PLANCK * 10n);
    mocks.tickOnce.mockResolvedValueOnce(fundingOutcome("done"));
    mocks.settlementBalance.mockResolvedValue(RETURN_FLOOR_PLANCK * 10n);
    mocks.registerTopUp.mockResolvedValue(undefined);
    await engine.tickAllWithdrawReturn();
    expect(storedJob().return.claim.registeredAt).toEqual(expect.any(Number));

    mocks.readTopUpStatus.mockRejectedValueOnce(new PaymentTopUpStatusErr.NotFound());
    await engine.tickAllWithdrawReturn();
    expect(storedJob().return.claim.registeredAt).toBeUndefined();
    expect(mocks.registerTopUp).toHaveBeenCalledTimes(1); // not yet re-called this same pass

    // The next pass re-registers (registeredAt was cleared); the one after that follows it.
    await engine.tickAllWithdrawReturn();
    expect(mocks.registerTopUp).toHaveBeenCalledTimes(2);
    expect(storedJob().return.claim.registeredAt).toEqual(expect.any(Number));

    mocks.readTopUpStatus.mockResolvedValueOnce(claimed(true));
    await engine.tickAllWithdrawReturn();
    expect(storedJob().return).toMatchObject({ returned: true });
  });

  it("does not touch a self-custody (direct rail) withdrawal, which never lands anything on a burner", async () => {
    armSeams();
    const engine = await freshEngine();
    await engine.startWithdraw(
      JSON.stringify({ ...MELD_HANDOFF, rail: "direct", meld: undefined }),
    );
    mocks.withdrawTickOnce.mockResolvedValueOnce(paymentOutcome("done"));
    await engine.tickAllWithdraw();
    expect(storedJob()).toMatchObject({ phase: "done", done: true });

    mocks.burnerAhFree = RETURN_FLOOR_PLANCK * 10n; // even if something were sitting there
    expect((await engine.tickAllWithdrawReturn()).ticked).toBe(0);
    expect(storedJob().return).toBeUndefined();
  });
});
