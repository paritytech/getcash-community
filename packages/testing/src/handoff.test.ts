// Handoff-mode lifecycle tests over the fakes.

import {
  createFlowStore,
  createPayment,
  DUST_GUARD_PLANCKS,
  FLOW_SCHEMA_VERSION,
  PaymentError,
  type EntropyPort,
  type FlowState,
  type HandoffKey,
  type HandoffPaymentConfig,
  type MintProgress,
  type PaymentState,
  type StorageAdapter,
} from "@getsome/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeHandoff, type FakeHandoff, type FakeHandoffOptions } from "./fake-handoff";
import { createFakeHarness, type Harness, type HarnessOptions } from "./fakes";
import { createFakeRail, type FakeRail, type FakeRailOptions } from "./fake-rail";
import { createMemoryAdapter } from "./memory-adapter";

const RECIPIENT = "5RecipientConnectedAccount00000000000000000000";
const KEY_ADDRESS = "5EphemeralFakeAddrPrefix000000000000000000000";
const AMOUNT = 5_000_000_000n; // settle amount, settlement-asset base units
const SECRET = new Uint8Array(64).fill(7);

function fakeEntropy(deterministic: boolean): EntropyPort {
  return { deterministic, deriveSeed: async (label) => label };
}

const HANDOFF_KEY: HandoffKey = { address: KEY_ADDRESS, signer: {}, secretKey: SECRET };

interface Setup {
  fake: FakeHandoff;
  harness: Harness;
  rail: FakeRail;
  storage: StorageAdapter;
  session: ReturnType<typeof createPayment<never>>;
}

function setup(
  opts: {
    handoff?: FakeHandoffOptions;
    harness?: HarnessOptions;
    rail?: FakeRailOptions;
    storage?: StorageAdapter;
    deterministic?: boolean;
    config?: Partial<HandoffPaymentConfig>;
  } = {},
): Setup {
  const fake = createFakeHandoff(opts.handoff);
  const harness = createFakeHarness(opts.harness); // supplies the ChainPort (balance + sweep)
  const rail = createFakeRail(opts.rail);
  const storage = opts.storage ?? createMemoryAdapter();
  const session = createPayment({
    recipient: RECIPIENT,
    handoff: fake.handoff,
    deriveKey: () => HANDOFF_KEY,
    deps: {
      chain: harness.chain,
      chainflip: rail,
      storage,
      entropy: fakeEntropy(opts.deterministic ?? true),
    },
    budget: { amount: AMOUNT, asset: { kind: "native" } },
    sourceId: "btc",
    ...opts.config,
  });
  return { fake, harness, rail, storage, session };
}

/**
 * Flush chained microtasks (async poll ticks -> reEnterHandoff -> persistence) without real time.
 */
async function flush(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function handoffFlow(overrides: Partial<FlowState> = {}): FlowState {
  return {
    version: FLOW_SCHEMA_VERSION,
    mode: "handoff",
    sourceId: "btc",
    recipient: RECIPIENT,
    ephemeralAddress: KEY_ADDRESS,
    phase: "awaiting-deposit",
    createdAt: Date.now(),
    idempotencyKey: "handoff-key-1",
    payload: "null",
    priceEvm: "0",
    handoffAmount: AMOUNT.toString(),
    settlement: { kind: "native" },
    depositAddress: "bc1q-fake-deposit",
    depositChannelId: "chan-1",
    depositExpiresAt: Date.now() + 86_400_000,
    ...overrides,
  };
}

/** Mint sub-state sequence with consecutive duplicates collapsed. */
function mintSteps(states: PaymentState[]): Array<MintProgress["step"]> {
  const steps = states.flatMap((s) =>
    s.phase === "working" || s.phase === "funded" ? [s.mint.step] : [],
  );
  return steps.filter((step, i) => i === 0 || steps[i - 1] !== step);
}

describe("createPayment session, handoff mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: quote -> start (channel -> ephemeral) -> fund -> settle -> verified done", async () => {
    const { fake, harness, rail, storage, session } = setup();
    await session.ready;

    const states: PaymentState[] = [];
    session.subscribe((s) => states.push(s));
    const completed: Array<{ id: number | string }> = [];
    session.events.on("completed", (e) => completed.push(e));
    const settledP = session.settled();

    await session.quote();
    // Handoff quotes with zero on-chain overhead.
    expect(rail.stats.lastQuoteRequest?.onChainOverheadPlancks).toBe(0n);
    await session.start({ refundAddress: "bc1-refund" });
    expect(rail.stats.lastChannelArgs?.destAddress).toBe(KEY_ADDRESS);

    // The persisted slot is a handoff flow carrying the settle amount, never the secret.
    const store = createFlowStore(storage, "btc", RECIPIENT);
    const persisted = await store.load();
    expect(persisted?.mode).toBe("handoff");
    expect(persisted?.handoffAmount).toBe(AMOUNT.toString());
    expect(persisted?.ephemeralAddress).toBe(KEY_ADDRESS);
    expect(JSON.stringify(persisted)).not.toContain("secretKey");

    // Fund the ephemeral; the balance poll fires the handoff.
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    expect(session.getState().phase).toBe("done");
    expect(fake.stats.settles).toBe(1);
    // The probes ran on the persisted idempotency key.
    expect(fake.stats.probedKeys[0]).toBe(persisted?.idempotencyKey);
    // The settle context carried the secret + exact amount.
    expect(fake.stats.lastCtx?.secretKey).toBe(SECRET);
    expect(fake.stats.lastCtx?.address).toBe(KEY_ADDRESS);
    expect(fake.stats.lastCtx?.amount).toBe(AMOUNT);
    // Sub-states surfaced: funded -> awaiting-consent -> verifying.
    expect(mintSteps(states)).toEqual(["funded", "awaiting-consent", "verifying"]);
    expect(completed).toEqual([{ id: "settled-1", sourceId: "btc" }]);
    await expect(settledP).resolves.toEqual({ id: "settled-1", sourceId: "btc" });
    session.dispose();
  });

  it("quiet failure: settle resolves ok but credits nothing -> under-credit, not done", async () => {
    const { fake, harness, session } = setup({ handoff: { quietFail: true } });
    await session.ready;
    // Attach the rejection handler before the failure fires.
    const settledRejects = expect(session.settled()).rejects.toThrowError(PaymentError);
    const completed: unknown[] = [];
    session.events.on("completed", (e) => completed.push(e));

    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") {
      expect(s.failure.kind).toBe("under-credit");
      expect(s.failure.recoverable).toBe(false);
    }
    expect(fake.stats.settles).toBe(1);
    expect(completed).toEqual([]);
    await settledRejects;

    // Non-recoverable: retry() must not re-settle.
    await session.retry();
    await flush();
    expect(fake.stats.settles).toBe(1);
    session.dispose();
  });

  it("under-credit: a short credit is not settled", async () => {
    const { fake, harness, session } = setup({ handoff: { creditShort: AMOUNT / 2n } });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") expect(s.failure.kind).toBe("under-credit");
    expect(fake.stats.settles).toBe(1);
    session.dispose();
  });

  it("consent sheet: blocks in awaiting-consent until confirmed, then verifies and completes", async () => {
    const { fake, harness, session } = setup({ handoff: { manualConsent: true } });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    // The sheet is up: settle is pending, the session shows awaiting-consent.
    expect(fake.stats.pendingConsent).toBe(true);
    const mid = session.getState();
    expect(mid.phase).toBe("working");
    if (mid.phase === "working") expect(mid.mint).toEqual({ step: "awaiting-consent" });

    // Abandoned sheet: nothing auto-resolves, nothing re-settles.
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(fake.stats.settles).toBe(1);
    expect(session.getState().phase).toBe("working");

    fake.confirmConsent(); // the user (finally) taps Claim
    await flush();
    expect(session.getState().phase).toBe("done");
    expect(fake.stats.settles).toBe(1);
    session.dispose();
  });

  it("declined consent -> recoverable mint failure; retry re-enters probe-first and succeeds", async () => {
    const { fake, harness, session } = setup({ handoff: { manualConsent: true } });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    fake.declineConsent();
    await flush();
    const failed = session.getState();
    expect(failed.phase).toBe("failed");
    if (failed.phase === "failed") {
      expect(failed.failure.kind).toBe("mint");
      expect(failed.failure.recoverable).toBe(true);
    }

    const probesBefore = fake.stats.probes;
    const retryP = session.retry();
    await flush();
    // Probe-first on retry, then a second settle.
    expect(fake.stats.probes).toBeGreaterThan(probesBefore);
    expect(fake.stats.settles).toBe(2);
    fake.confirmConsent();
    await retryP;
    await flush();
    expect(session.getState().phase).toBe("done");
    session.dispose();
  });

  it("resume of a settled working flow completes without re-settling (no consent re-pop)", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    await store.save(handoffFlow({ phase: "working" }));

    // Fresh session (a reload): the attempt already settled host-side.
    const { fake, session } = setup({ storage, handoff: { startSettled: true } });
    await session.ready;
    await session.resume();
    await flush();

    expect(session.getState().phase).toBe("done");
    expect(fake.stats.settles).toBe(0); // NEVER re-popped the sheet
    session.dispose();
  });

  it("resume of a persisted 'done' flow recovers the receipt via the probe, no event re-fire", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    await store.save(handoffFlow({ phase: "done" }));

    const { fake, session } = setup({ storage, handoff: { startSettled: true } });
    const completed: unknown[] = [];
    session.events.on("completed", (e) => completed.push(e));
    await session.ready;
    await session.resume();
    await flush();

    expect(session.getState().phase).toBe("done");
    expect(fake.stats.settles).toBe(0);
    expect(completed).toEqual([]); // fired when the flow first completed, never on rediscovery
    session.dispose();
  });

  it("resume with non-deterministic entropy -> failed:stale (key unrecoverable)", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    await store.save(handoffFlow());

    const { fake, session } = setup({ storage, deterministic: false });
    await session.ready;
    await session.resume();
    await flush();

    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") expect(s.failure.kind).toBe("stale");
    expect(fake.stats.settles).toBe(0);
    session.dispose();
  });

  it("start() over an in-flight working slot routes to probe-first resume: no re-key, no second channel", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    await store.save(handoffFlow({ phase: "working" }));

    // Fresh session (a reload): the attempt already settled host-side; user re-taps Pay.
    const { fake, rail, session } = setup({ storage, handoff: { startSettled: true } });
    await session.ready;
    await session.start({ refundAddress: "bc1-refund" }); // no quote; must not open a channel
    await flush();

    expect(session.getState().phase).toBe("done");
    expect(rail.stats.channelsOpened).toBe(0); // never re-keyed the flow
    expect(fake.stats.settles).toBe(0); // never re-popped the sheet
    session.dispose();
  });

  it("resume during a pending settle joins it: no second settle, no second sheet", async () => {
    const { fake, harness, session } = setup({ handoff: { manualConsent: true } });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(fake.stats.pendingConsent).toBe(true);

    // Resume joins the in-flight settle.
    const resumeP = session.resume();
    await flush();
    expect(fake.stats.settles).toBe(1);
    expect(fake.stats.pendingConsent).toBe(true);

    fake.confirmConsent();
    await resumeP;
    await flush();
    expect(session.getState().phase).toBe("done");
    expect(fake.stats.settles).toBe(1);
    session.dispose();
  });

  it("start() during a pending settle routes through the working slot and joins it", async () => {
    const { fake, harness, rail, session } = setup({ handoff: { manualConsent: true } });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(fake.stats.pendingConsent).toBe(true);

    const startP = session.start({ refundAddress: "bc1-refund" }); // user re-taps Pay
    await flush();
    expect(rail.stats.channelsOpened).toBe(1); // no second channel, no re-key
    expect(fake.stats.settles).toBe(1);

    fake.confirmConsent();
    await startP;
    await flush();
    expect(session.getState().phase).toBe("done");
    session.dispose();
  });

  it("cancel during a pending settle is deferred: the host owns a live claim, the flow survives", async () => {
    const { fake, harness, storage, session } = setup({ handoff: { manualConsent: true } });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(fake.stats.pendingConsent).toBe(true);

    // Cancel must not clear the slot under the live claim.
    await session.cancel();
    expect(session.getState().phase).toBe("working");
    expect(harness.stats.sweeps).toBe(0);

    // The user taps Claim: the flow completes and the receipt is kept.
    fake.confirmConsent();
    await flush();
    expect(session.getState().phase).toBe("done");
    expect(fake.stats.settles).toBe(1);

    // ...and the flow is cancellable/clearable normally afterwards.
    await session.clear();
    expect(session.getState().phase).toBe("idle");
    const store = createFlowStore(storage, "btc", RECIPIENT);
    expect(await store.load()).toBeNull();
    session.dispose();
  });

  it("dispose during a pending settle: the late outcome cannot write storage or resolve waiters", async () => {
    const { fake, harness, storage, session } = setup({ handoff: { manualConsent: true } });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(fake.stats.pendingConsent).toBe(true);

    let waiterFired = false;
    void session.settled().then(
      () => {
        waiterFired = true;
      },
      () => {
        waiterFired = true;
      },
    );
    session.dispose();

    fake.confirmConsent();
    await flush();
    expect(waiterFired).toBe(false); // waiters stay pending by design, even after the claim
    const store = createFlowStore(storage, "btc", RECIPIENT);
    // No storage write after dispose: the slot never advanced to 'done'.
    expect((await store.load())?.phase).toBe("working");
  });

  it("a subscriber auto-retrying synchronously on failed cannot strand the flow", async () => {
    const { fake, harness, session } = setup({ handoff: { manualConsent: true } });
    await session.ready;
    // Hostile-but-realistic consumer: retry the instant a failure is rendered.
    session.subscribe((s) => {
      if (s.phase === "failed") void session.retry();
    });
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    fake.declineConsent();
    await flush();
    // The synchronous retry landed in the lock window and was dropped.
    expect(session.getState().phase).toBe("failed");
    expect(fake.stats.settles).toBe(1);

    // A post-release retry works normally.
    const retryP = session.retry();
    await flush();
    expect(fake.stats.settles).toBe(2);
    fake.confirmConsent();
    await retryP;
    await flush();
    expect(session.getState().phase).toBe("done");
    session.dispose();
  });

  it("gates funding on the settlement asset (6-dec CASH), never native", async () => {
    const CASH = { kind: "foreign", id: "cash" } as const;
    const CASH_AMOUNT = 5_000_000n; // 5 CASH at 6 decimals
    const { fake, harness, rail, session } = setup({
      config: { budget: { amount: CASH_AMOUNT, asset: CASH }, targetDecimals: 6 },
    });
    await session.ready;
    await session.quote();
    // The reverse-quote target carries the configured decimals, not the DOT default.
    expect(rail.stats.lastQuoteRequest?.target).toEqual({ amount: CASH_AMOUNT, decimals: 6 });

    await session.start({ refundAddress: "bc1-refund" });
    // Native stays zero; only the settlement-asset balance is funded.
    harness.setSettlementBalance(CASH_AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    expect(session.getState().phase).toBe("done");
    expect(harness.stats.lastSettlementRead).toEqual(CASH);
    expect(fake.stats.lastCtx?.amount).toBe(CASH_AMOUNT);
    session.dispose();
  });

  it("start() fails fast when the port cannot read the settlement asset (no silent hang)", async () => {
    const { session } = setup({
      harness: { settlementUnsupported: true },
      config: { budget: { amount: AMOUNT, asset: { kind: "foreign", id: "cash" } } },
    });
    await session.ready;
    await session.quote();
    // A CASH budget paired with a port that cannot read it fails at start().
    await expect(session.start({ refundAddress: "bc1-refund" })).rejects.toThrow(/not wired/);
    session.dispose();
  });

  it("cancel default sweeps any leftover: the DOT dust guard does not apply to handoff", async () => {
    const { harness, session } = setup();
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(1_000n); // far below DUST_GUARD_PLANCKS AND below the settle gate
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(session.getState().phase).toBe("awaiting-deposit");

    await session.cancel();
    expect(harness.stats.sweeps).toBe(1);
    session.dispose();
  });

  it("cancelDustThreshold suppresses the sweep at or below it", async () => {
    const { harness, session } = setup({ config: { cancelDustThreshold: 2_000n } });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(1_000n);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    await session.cancel();
    expect(harness.stats.sweeps).toBe(0);
    session.dispose();
  });

  it("pool-route decoupling: native budget for the rail, underlying settle for the gate", async () => {
    const CASH = { kind: "foreign", id: "cash" } as const;
    const SETTLE = 7_000_000n; // 7 underlying at 6 decimals; what topUp claims
    const NATIVE_BUDGET = 2n * 10n ** 10n; // what the delivery leg must produce
    const { fake, harness, rail, session } = setup({
      config: {
        budget: { amount: NATIVE_BUDGET, asset: { kind: "native" } },
        settlement: CASH,
        settleAmount: SETTLE,
      },
    });
    await session.ready;
    await session.quote();
    // The rail is sized by the native budget, not the settle amount.
    expect(rail.stats.lastQuoteRequest?.target).toEqual({ amount: NATIVE_BUDGET, decimals: 10 });

    await session.start({ refundAddress: "bc1-refund" });
    // The gate reads the settlement asset.
    harness.setSettlementBalance(SETTLE);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    expect(session.getState().phase).toBe("done");
    expect(harness.stats.lastSettlementRead).toEqual(CASH);
    expect(fake.stats.lastCtx?.amount).toBe(SETTLE); // settle claims SETTLE, not the budget
    session.dispose();
  });

  it("the re-entry lock releases after done: a second flow settles independently", async () => {
    const { fake, harness, session } = setup();
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(session.getState().phase).toBe("done");
    await session.clear();

    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(session.getState().phase).toBe("done");
    expect(fake.stats.settles).toBe(2); // a fresh attempt, not a stale join
    session.dispose();
  });

  it("settle threw but the claim landed -> done with a single settle (no false failure)", async () => {
    const { fake, harness, session } = setup({
      handoff: { failSettles: 1, failButLand: true },
    });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    expect(session.getState().phase).toBe("done");
    expect(fake.stats.settles).toBe(1); // the catch-path re-probe found the landed claim
    session.dispose();
  });

  it('transient isSettled error before settle -> recoverable failure (never read as "not settled")', async () => {
    const { fake, harness, session } = setup({ handoff: { failProbeAt: 1 } });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    const failed = session.getState();
    expect(failed.phase).toBe("failed");
    if (failed.phase === "failed") {
      expect(failed.failure.kind).toBe("mint");
      expect(failed.failure.recoverable).toBe(true);
    }
    expect(fake.stats.settles).toBe(0); // a probe error must not license a settle

    await session.retry();
    await flush();
    expect(session.getState().phase).toBe("done");
    expect(fake.stats.settles).toBe(1);
    session.dispose();
  });

  it("transient isSettled error after settle -> settled-but-unverified; retry re-verifies without re-settling", async () => {
    const { fake, harness, session } = setup({ handoff: { failProbeAt: 2 } });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });
    harness.setBalance(AMOUNT);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    const failed = session.getState();
    expect(failed.phase).toBe("failed");
    if (failed.phase === "failed") expect(failed.failure.recoverable).toBe(true);
    expect(fake.stats.settles).toBe(1);

    await session.retry();
    await flush();
    expect(session.getState().phase).toBe("done");
    expect(fake.stats.settles).toBe(1); // probe-first found the credit; no second sheet
    session.dispose();
  });

  it("resume of an unsettled working flow settles exactly once (the deliberate re-pop)", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    await store.save(handoffFlow({ phase: "working" }));

    const { fake, harness, session } = setup({ storage });
    harness.setBalance(AMOUNT);
    await session.ready;
    await session.resume();
    await flush();

    expect(session.getState().phase).toBe("done");
    expect(fake.stats.settles).toBe(1);
    session.dispose();
  });

  it("corrupt slot (missing settle amount) -> non-recoverable failure, never a settle", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    await store.save(handoffFlow({ phase: "working", handoffAmount: undefined }));

    const { fake, harness, session } = setup({ storage });
    harness.setBalance(AMOUNT);
    await session.ready;
    await session.resume();
    await flush();

    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") {
      expect(s.failure.kind).toBe("stale");
      expect(s.failure.recoverable).toBe(false);
    }
    expect(fake.stats.settles).toBe(0);
    session.dispose();
  });

  it("cancel: sweeps the ephemeral back to the recipient above dust and clears the slot", async () => {
    const { fake, harness, storage, session } = setup();
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "bc1-refund" });

    // Partially funded: above the dust guard, below the settle gate; never fires the handoff.
    harness.setBalance(DUST_GUARD_PLANCKS * 2n);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(session.getState().phase).toBe("awaiting-deposit");

    await session.cancel();
    expect(harness.stats.sweeps).toBe(1);
    expect(harness.stats.lastSweepDest).toBe(RECIPIENT);
    expect(fake.stats.settles).toBe(0);
    const store = createFlowStore(storage, "btc", RECIPIENT);
    expect(await store.load()).toBeNull();
    expect(session.getState().phase).toBe("idle");
    session.dispose();
  });
});
