// Session-level orchestration tests: dual-poll, resume/retry/cancel, channel reuse,
// idempotent spend. Fully deterministic: fake timers everywhere, time is always advanced
// explicitly, microtask chains are flushed explicitly.

import {
  createFlowStore,
  createPayment,
  FEE_OVERHEAD_PLANCKS,
  FLOW_SCHEMA_VERSION,
  PaymentError,
  type EntropyPort,
  type FlowState,
  type PaymentAction,
  type SpendPaymentConfig,
  type PaymentSession,
  type StorageAdapter,
} from "@getsome/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeHarness, type Harness, type HarnessOptions } from "./fakes";
import { createFakeRail, type FakeRail, type FakeRailOptions } from "./fake-rail";
import { createMemoryAdapter } from "./memory-adapter";

const RECIPIENT = "5RecipientConnectedAccount00000000000000000000";
const PRICE_EVM = 1_000_000_000_000_000_000n; // 1 DOT in EVM 18-dec
const PRICE_PLANCKS = PRICE_EVM / 10n ** 8n; // /10^8 across the Revive boundary
const FUNDED = PRICE_PLANCKS + FEE_OVERHEAD_PLANCKS;
const PAYLOAD = { name: "alice" };
type Payload = typeof PAYLOAD;

function fakeEntropy(deterministic: boolean): EntropyPort {
  return { deterministic, deriveSeed: async (label) => label };
}

interface Setup {
  harness: Harness;
  rail: FakeRail;
  storage: StorageAdapter;
  session: PaymentSession<Payload>;
}

function setup(
  opts: {
    harness?: HarnessOptions;
    rail?: FakeRailOptions;
    storage?: StorageAdapter;
    deterministic?: boolean;
    // setup() always builds a spend session; overrides are spend-shaped.
    config?: Partial<SpendPaymentConfig<Payload>>;
  } = {},
): Setup {
  const harness = createFakeHarness(opts.harness);
  const rail = createFakeRail(opts.rail);
  const storage = opts.storage ?? createMemoryAdapter();
  const session = createPayment<Payload>({
    recipient: RECIPIENT,
    action: harness.action as PaymentAction<Payload>,
    deps: {
      chain: harness.chain,
      chainflip: rail,
      storage,
      entropy: fakeEntropy(opts.deterministic ?? true),
    },
    budget: { amount: PRICE_PLANCKS, asset: { kind: "native" } },
    priceEvm: PRICE_EVM,
    sourceId: "btc",
    deriveSigner: () => harness.signer,
    retryDelayMs: 0, // reEnter delays resolve without timers
    ...opts.config,
  });
  return { harness, rail, storage, session };
}

/** Flush chained microtasks (async poll ticks -> reEnter -> persistence) without real time. */
async function flush(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function awaitingFlow(overrides: Partial<FlowState> = {}): FlowState {
  return {
    version: FLOW_SCHEMA_VERSION,
    mode: "spend",
    sourceId: "btc",
    recipient: RECIPIENT,
    ephemeralAddress: "5EphemeralFakeAddrPrefix000000000000000000000",
    phase: "awaiting-deposit",
    createdAt: Date.now(),
    idempotencyKey: "attempt-key-1",
    payload: JSON.stringify(PAYLOAD),
    priceEvm: PRICE_EVM.toString(),
    settlement: { kind: "native" },
    depositAddress: "bc1q-fake-deposit",
    depositChannelId: "chan-1",
    depositExpiresAt: Date.now() + 86_400_000,
    ...overrides,
  };
}

describe("createPayment session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: quote -> start -> fund -> done; completed fires once; settled resolves; clear wipes", async () => {
    const { harness, rail, storage, session } = setup();
    await session.ready;
    expect(session.peek()).toBeNull();

    const quote = await session.quote();
    expect(session.getState().phase).toBe("quoted");
    expect(quote.sourceId).toBe("btc");
    // Reverse-quote sized from the budget, already in plancks, decimals 10.
    expect(rail.stats.lastQuoteRequest?.target).toEqual({ amount: PRICE_PLANCKS, decimals: 10 });

    const completed: Array<{ id: number | string; sourceId: string }> = [];
    session.events.on("completed", (e) => completed.push(e));
    const settledP = session.settled();

    await session.start({ refundAddress: "bc1-refund", payload: PAYLOAD });
    expect(session.getState().phase).toBe("awaiting-deposit");
    expect(rail.stats.lastChannelArgs?.destAddress).toBe(harness.signer.address);
    expect(rail.stats.lastChannelArgs?.refundAddress).toBe("bc1-refund");

    // Deposit info persisted in the flow slot.
    const store = createFlowStore(storage, "btc", RECIPIENT);
    const persisted = await store.load();
    expect(persisted?.phase).toBe("awaiting-deposit");
    expect(persisted?.depositAddress).toBe("bc1q-fake-deposit");
    expect(persisted?.depositChannelId).toBe("chan-1");
    expect(session.peek()?.phase).toBe("awaiting-deposit");

    // Fund the ephemeral; the balance poll detects it on its next tick and runs the spend.
    harness.setBalance(FUNDED);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    expect(session.getState().phase).toBe("done");
    expect(harness.stats.submits).toBe(1);
    expect(harness.stats.lastSettle?.dest).toBe(RECIPIENT);
    // Spend gates on native and never reads the settlement asset.
    expect(harness.stats.lastSettlementRead).toBeNull();
    expect(completed).toEqual([{ id: 42, sourceId: "btc" }]); // exactly once
    await expect(settledP).resolves.toEqual({ id: 42, sourceId: "btc" });

    await session.clear();
    expect(session.getState().phase).toBe("idle");
    expect(await store.load()).toBeNull();
    expect(session.peek()).toBeNull();
    session.dispose();
  });

  it("quote failure: failed state with kind quote and the verb rejects", async () => {
    const { session } = setup({ rail: { quoteError: new Error("no route") } });
    await expect(session.quote()).rejects.toThrow("no route");
    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") {
      expect(s.failure.kind).toBe("quote");
      expect(s.failure.recoverable).toBe(false);
    }
  });

  it("resume: re-attaches polls for a persisted awaiting-deposit flow, then completes on funding", async () => {
    const storage = createMemoryAdapter();
    const first = setup({ storage });
    await first.session.quote();
    await first.session.start({ refundAddress: "r", payload: PAYLOAD });
    first.session.dispose();

    const second = setup({ storage });
    await second.session.resume();
    expect(second.session.getState().phase).toBe("awaiting-deposit");
    expect(second.harness.stats.probes).toBe(1); // probe-first even on resume
    expect(second.harness.stats.submits).toBe(0);

    second.harness.setBalance(FUNDED);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(second.session.getState().phase).toBe("done");
    expect(second.harness.stats.submits).toBe(1);
    second.session.dispose();
  });

  it("resume: already-complete action lands done without a submit (probe-first)", async () => {
    const storage = createMemoryAdapter();
    const first = setup({ storage });
    await first.session.quote();
    await first.session.start({ refundAddress: "r", payload: PAYLOAD });
    first.session.dispose();

    // Landed while away: the second session's action is already complete.
    const second = setup({ storage, harness: { startComplete: true } });
    await second.session.resume();
    const s = second.session.getState();
    expect(s.phase).toBe("done");
    if (s.phase === "done") expect(s.result.id).toBe(42);
    expect(second.harness.stats.submits).toBe(0);
    second.session.dispose();
  });

  it("resume: stale awaiting-deposit flow fails stale, recoverable false, persisted", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    await store.save(awaitingFlow({ createdAt: Date.now() - 86_400_001 }));

    const { session, harness } = setup({ storage });
    await session.resume();
    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") {
      expect(s.failure.kind).toBe("stale");
      expect(s.failure.recoverable).toBe(false);
    }
    expect((await store.load())?.phase).toBe("failed");
    expect(harness.stats.probes).toBe(0); // short-circuits before any chain access
    expect(session.peek()?.stale).toBe(false); // persisted phase is now 'failed', not awaiting
  });

  it("resume: concurrent calls dedup to a single probe pass", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    await store.save(awaitingFlow());

    const { session, harness } = setup({ storage, harness: { startComplete: true } });
    await Promise.all([session.resume(), session.resume()]);
    expect(session.getState().phase).toBe("done");
    expect(harness.stats.probes).toBe(1); // one underlying pass, not two
    expect(harness.stats.submits).toBe(0);
  });

  it("resume: non-deterministic entropy cannot restore the ephemeral -> failed stale", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    await store.save(awaitingFlow());

    const { session, harness } = setup({ storage, deterministic: false });
    await session.resume();
    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") {
      expect(s.failure.kind).toBe("stale");
      expect(s.failure.recoverable).toBe(false);
    }
    expect(harness.stats.probes).toBe(0); // never reached reEnter
  });

  it("idempotent spend: submit throws but the tx landed -> done with exactly one submit", async () => {
    // The batch_all invariant surfaced at session level (reEnter re-probes after the error).
    const { harness, session } = setup({ harness: { failSubmits: 1, failButLand: true } });
    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });

    harness.setBalance(FUNDED);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    expect(session.getState().phase).toBe("done");
    expect(harness.stats.submits).toBe(1); // errored once, landed; never re-submitted
    session.dispose();
  });

  it("retry: recoverable mint failure re-enters probe-first; no re-submit when already landed", async () => {
    const { harness, session } = setup({ harness: { failSubmits: 10, failButLand: false } });
    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });

    harness.setBalance(FUNDED);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    const failed = session.getState();
    expect(failed.phase).toBe("failed");
    if (failed.phase === "failed") {
      expect(failed.failure.kind).toBe("mint");
      expect(failed.failure.recoverable).toBe(true);
    }
    expect(harness.stats.submits).toBe(3); // bounded by maxMintAttempts

    // The tx landed out-of-band; retry's probe finds it and never submits again.
    harness.markComplete();
    await session.retry();
    expect(session.getState().phase).toBe("done");
    expect(harness.stats.submits).toBe(3);
    session.dispose();
  });

  it("retry: non-recoverable (stale) failure is a no-op", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    await store.save(awaitingFlow({ createdAt: Date.now() - 86_400_001 }));

    const { session, harness } = setup({ storage });
    await session.resume(); // -> failed: stale
    await session.retry();
    expect(session.getState().phase).toBe("failed");
    expect(harness.stats.probes).toBe(0);
    expect(harness.stats.submits).toBe(0);
  });

  it("dual-poll: swapEgressFailure fails the flow, stops the balance poll, emits failed", async () => {
    const { harness, rail, session } = setup({
      rail: {
        statusSequence: [
          { status: "swapping" },
          { status: "sending", swapEgressFailure: { reason: { message: "egress kaput" } } },
        ],
      },
    });
    const failedEvents: Array<{ kind: string; sourceId: string }> = [];
    session.events.on("failed", (e) => failedEvents.push(e));
    const settledErr = session.settled().catch((e: unknown) => e);

    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });
    await flush(); // immediate status tick -> swap progress surfaces
    expect(session.getState().phase).toBe("swapping");

    await vi.advanceTimersByTimeAsync(5_000); // second status tick -> implicit egress failure
    await flush();
    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") {
      expect(s.failure.kind).toBe("egress-failed");
      expect(s.failure.step).toBe("swap");
      expect(s.failure.recoverable).toBe(false);
    }
    expect(failedEvents).toEqual([{ kind: "egress-failed", sourceId: "btc" }]);
    expect(await settledErr).toBeInstanceOf(PaymentError);

    // The balance poll is dead: even a funded ephemeral never triggers a submit.
    const statusCallsAtFailure = rail.stats.statusCalls;
    harness.setBalance(FUNDED);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(harness.stats.submits).toBe(0);
    expect(rail.stats.statusCalls).toBe(statusCallsAtFailure); // status poll stopped too
    session.dispose();
  });

  it("dual-poll: a plain failed status is a refund: the refund's progress lands on the state until witnessed", async () => {
    const egress = { amount: "7", txRef: "0xrefund" };
    const { rail, session } = setup({
      rail: {
        statusSequence: [
          { status: "swapping" },
          { status: "failed" },
          { status: "failed", refundEgress: egress },
          { status: "failed", refundEgress: { ...egress, witnessedAt: 1 } },
        ],
      },
    });
    session.settled().catch(() => {});
    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });
    await flush();

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    let s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") {
      expect(s.failure.kind).toBe("refunded");
      expect(s.refund).toBeUndefined();
    }

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    s = session.getState();
    if (s.phase === "failed") expect(s.refund).toEqual(egress);

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    s = session.getState();
    if (s.phase === "failed") expect(s.refund?.witnessedAt).toBe(1);
    const calls = rail.stats.statusCalls;
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(rail.stats.statusCalls).toBe(calls); // witnessed: the poll is done
    session.dispose();
  });

  it("dual-poll: a failed refund egress turns the failure into refund-failed", async () => {
    const { session } = setup({
      rail: {
        statusSequence: [
          { status: "failed" },
          { status: "failed", refundEgress: { failure: { message: "refund kaput" } } },
        ],
      },
    });
    session.settled().catch(() => {});
    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") expect(s.failure.kind).toBe("refund-failed");
    session.dispose();
  });

  it("resume: a refunded flow polls on and learns its refund", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    const refunded = { kind: "refunded", step: "swap", message: "m", recoverable: false };
    await store.save(awaitingFlow({ phase: "failed", errorMessage: JSON.stringify(refunded) }));

    const { rail, session } = setup({
      storage,
      rail: { statusSequence: [{ status: "failed", refundEgress: { txRef: "0xr" } }] },
    });
    await session.resume();
    await flush();
    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") {
      expect(s.failure.kind).toBe("refunded");
      expect(s.refund?.txRef).toBe("0xr");
    }
    expect(rail.stats.statusCalls).toBe(1);
    session.dispose();
  });

  it("start without a refund address opens the channel on a rail that needs none", async () => {
    const { rail, session } = setup();
    await session.quote();
    await session.start({ payload: PAYLOAD });
    expect(rail.stats.channelsOpened).toBe(1);
    expect(rail.stats.lastChannelArgs?.refundAddress).toBeUndefined();
    session.dispose();
  });

  it("dual-poll: depositFailure maps to deposit-rejected at step deposit", async () => {
    const { session } = setup({
      rail: {
        statusSequence: [
          { status: "receiving", depositFailure: { reason: { message: "below minimum" } } },
        ],
      },
    });
    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });
    await flush(); // immediate status tick sees the rejection

    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") {
      expect(s.failure.kind).toBe("deposit-rejected");
      expect(s.failure.step).toBe("deposit");
      expect(s.failure.recoverable).toBe(false);
    }
    session.dispose();
  });

  it("dual-poll: an 'unknown' rail failure survives a reload with its own message", async () => {
    // The fiat rail's `unobserved` failure arrives as kind 'unknown' and must survive a reload as
    // itself.
    const storage = createMemoryAdapter();
    const message = "We could not confirm this payment. Contact support before trying again.";
    const first = setup({
      storage,
      rail: {
        statusSequence: [
          {
            status: "failed",
            depositFailure: { reason: { code: "unobserved", message }, kind: "unknown" },
          },
        ],
      },
    });
    await first.session.quote();
    await first.session.start({ refundAddress: "r", payload: PAYLOAD });
    await flush();
    const live = first.session.getState();
    expect(live.phase).toBe("failed");
    if (live.phase === "failed") expect(live.failure.kind).toBe("unknown");
    first.session.dispose();

    // A fresh session over the same storage: what a reload does.
    const second = setup({ storage });
    await second.session.resume();
    const restored = second.session.getState();
    expect(restored.phase).toBe("failed");
    if (restored.phase === "failed") {
      expect(restored.failure.kind).toBe("unknown");
      expect(restored.failure.message).toBe(message);
    }
    second.session.dispose();
  });

  it("start: reuses an open channel with >2h remaining; double-start never double-opens", async () => {
    const { rail, session } = setup(); // default channel expiry: +24h
    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });
    await session.start({ refundAddress: "r", payload: PAYLOAD });
    expect(rail.stats.channelsOpened).toBe(1);
    expect(session.getState().phase).toBe("awaiting-deposit");
    session.dispose();
  });

  it("start: reopens a fresh channel when the existing one has <2h remaining", async () => {
    const { rail, session } = setup({ rail: { channelExpiresAt: Date.now() + 3_600_000 } });
    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });
    await session.start({ refundAddress: "r", payload: PAYLOAD });
    expect(rail.stats.channelsOpened).toBe(2);
    session.dispose();
  });

  it("cancel: sweeps a funded-but-unspent ephemeral above dust and clears the slot", async () => {
    const { harness, storage, session } = setup();
    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });

    harness.setBalance(50_000_000_000n); // funded; no timer advanced, so nothing spent
    await session.cancel();

    expect(harness.stats.sweeps).toBe(1);
    expect(harness.stats.lastSweepDest).toBe(RECIPIENT);
    expect(harness.stats.submits).toBe(0);
    const store = createFlowStore(storage, "btc", RECIPIENT);
    expect(await store.load()).toBeNull();
    expect(session.getState().phase).toBe("idle");
    session.dispose();
  });

  it("quote: rejects mid-flow so it cannot clobber the funding gate", async () => {
    const { harness, session } = setup();
    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });

    // Re-quoting mid-flow must throw.
    await expect(session.quote()).rejects.toThrow(/in progress/);
    expect(session.getState().phase).toBe("awaiting-deposit");

    // The gate still works after the rejected re-quote.
    harness.setBalance(FUNDED);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(session.getState().phase).toBe("done");
    session.dispose();
  });

  it("funding stops the status poll before the spend: a queued egress failure cannot fail a working flow", async () => {
    // Custom chain whose submit blocks until released; holds the flow in 'working' to observe the
    // status poll mid-spend.
    const harness = createFakeHarness();
    let releaseSubmit!: () => void;
    const gate = new Promise<void>((r) => {
      releaseSubmit = r;
    });
    const chain: typeof harness.chain = {
      ...harness.chain,
      submit: async (call, signer, settle) => {
        await gate;
        return harness.chain.submit(call, signer, settle);
      },
    };
    const rail = createFakeRail({
      // The second status tick reports an implicit egress failure...
      statusSequence: [
        { status: "waiting" },
        { status: "sending", swapEgressFailure: { reason: { message: "late egress kaput" } } },
      ],
    });
    const storage = createMemoryAdapter();
    const session = createPayment<Payload>({
      recipient: RECIPIENT,
      action: harness.action as PaymentAction<Payload>,
      deps: { chain, chainflip: rail, storage, entropy: fakeEntropy(true) },
      budget: { amount: PRICE_PLANCKS, asset: { kind: "native" } },
      priceEvm: PRICE_EVM,
      sourceId: "btc",
      deriveSigner: () => harness.signer,
      retryDelayMs: 0,
      pollIntervalMs: 1_000,
      statusPollIntervalMs: 10_000,
    });
    const failedEvents: unknown[] = [];
    session.events.on("failed", (e) => failedEvents.push(e));

    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });
    await flush(); // immediate status tick consumes 'waiting'

    harness.setBalance(FUNDED);
    await vi.advanceTimersByTimeAsync(1_000); // balance tick -> funded -> spend starts (submit gated)
    await flush();
    expect(session.getState().phase).toBe("working");
    const statusCallsAtSpend = rail.stats.statusCalls;

    // ...but the status poll was stopped with the balance poll, so mid-spend it never fires.
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(rail.stats.statusCalls).toBe(statusCallsAtSpend);
    expect(session.getState().phase).toBe("working"); // NOT failed mid-spend

    releaseSubmit();
    await flush();
    expect(session.getState().phase).toBe("done");
    expect(failedEvents).toEqual([]);
    session.dispose();
  });

  it("start: never opens a second channel over a working slot; routes through probe-first resume", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", RECIPIENT);
    await store.save(awaitingFlow({ phase: "working" }));

    // The spend landed while away; start() must discover it, not re-key the attempt.
    const { rail, harness, session } = setup({ storage, harness: { startComplete: true } });
    await session.ready;
    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });

    expect(rail.stats.channelsOpened).toBe(0); // no second channel, no new idempotency key
    expect(harness.stats.submits).toBe(0); // probe-first found the landed spend
    expect(session.getState().phase).toBe("done");
    session.dispose();
  });

  it("overheads are configurable: gate uses feeOverheadPlancks, quote passes onChainOverheadPlancks", async () => {
    const LOW_FEE = 500_000_000n; // 0.05 DOT, storage-light action
    const LOW_OVERHEAD = 700_000_000n;
    const { harness, rail, session } = setup({
      config: { feeOverheadPlancks: LOW_FEE, onChainOverheadPlancks: LOW_OVERHEAD },
    });
    await session.quote();
    expect(rail.stats.lastQuoteRequest?.onChainOverheadPlancks).toBe(LOW_OVERHEAD);

    await session.start({ refundAddress: "r", payload: PAYLOAD });
    // Funded at the lower gate (price + 0.05), below the default gate (price + 0.3).
    harness.setBalance(PRICE_PLANCKS + LOW_FEE);
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(session.getState().phase).toBe("done");
    session.dispose();
  });

  it("resume: deposit display fields survive the reload (amount/formatted/symbol persisted)", async () => {
    const storage = createMemoryAdapter();
    const first = setup({ storage });
    await first.session.quote();
    await first.session.start({ refundAddress: "r", payload: PAYLOAD });
    first.session.dispose();

    const second = setup({ storage });
    await second.session.resume();
    const s = second.session.getState();
    expect(s.phase).toBe("awaiting-deposit");
    if (s.phase === "awaiting-deposit") {
      expect(s.deposit.amount).toBe(100_000n); // fake rail's canned channel amount
      expect(s.deposit.formatted).toBe("0.001 BTC");
      expect(s.deposit.assetSymbol).toBe("BTC");
    }
    second.session.dispose();
  });

  it("sources: probe streams checking -> verdict per source; positive verdicts are not re-probed", async () => {
    const { rail, session } = setup({
      rail: {
        availabilityById: { eth: { status: "unavailable", reason: "pool too thin" } },
      },
    });
    const seen: Array<Record<string, { status: string }>> = [];
    session.sources.subscribeAvailability((byId) => seen.push({ ...byId }));

    expect(session.sources.list().map((d) => d.sourceId)).toEqual(["btc", "eth"]);
    expect(session.sources.availability("btc")).toEqual({ status: "unknown" });

    session.sources.probe();
    // Both flip to 'checking' synchronously; tiles grey out immediately, individually.
    expect(session.sources.availability("btc")).toEqual({ status: "checking" });
    await flush();

    expect(session.sources.availability("btc")).toEqual({ status: "available" });
    expect(session.sources.availability("eth")).toEqual({
      status: "unavailable",
      reason: "pool too thin",
    });
    expect(seen.length).toBeGreaterThanOrEqual(3); // 2× checking + final verdicts
    expect(rail.stats.probeCalls).toBe(2);

    // available (btc) is cached; only the unavailable one (eth) re-probes.
    session.sources.probe();
    await flush();
    expect(rail.stats.probeCalls).toBe(3);
    session.dispose();
  });

  it("cancel: dust-level balance is not swept, slot still cleared", async () => {
    const { harness, storage, session } = setup();
    await session.quote();
    await session.start({ refundAddress: "r", payload: PAYLOAD });

    harness.setBalance(999_999_999n); // below the 0.1 DOT dust guard
    await session.cancel();

    expect(harness.stats.sweeps).toBe(0);
    const store = createFlowStore(storage, "btc", RECIPIENT);
    expect(await store.load()).toBeNull();
    expect(session.getState().phase).toBe("idle");
    session.dispose();
  });
});

function setupDeliver(
  opts: {
    rail?: FakeRailOptions;
    storage?: StorageAdapter;
    deterministic?: boolean;
  } = {},
) {
  const harness = createFakeHarness(); // deps require a ChainPort; deliver never touches it
  const rail = createFakeRail(opts.rail);
  const storage = opts.storage ?? createMemoryAdapter();
  const session = createPayment({
    recipient: RECIPIENT,
    deps: {
      chain: harness.chain,
      chainflip: rail,
      storage,
      entropy: fakeEntropy(opts.deterministic ?? true),
    },
    budget: { amount: PRICE_PLANCKS, asset: { kind: "native" } },
    sourceId: "btc",
    statusPollIntervalMs: 1_000,
  });
  return { harness, rail, storage, session };
}

describe("createPayment session, deliver mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("egresses directly to the recipient: zero-overhead quote, done on egress witness, txRef receipt, no key/submit/probe", async () => {
    const { harness, rail, session } = setupDeliver({
      rail: {
        statusSequence: [
          { status: "waiting" },
          { status: "complete", egress: { txRef: "0xegress123" } },
        ],
      },
    });
    const completed: unknown[] = [];
    session.events.on("completed", (e) => completed.push(e));

    await session.quote();
    // Nothing on-chain to pay in deliver mode; the quote targets the budget exactly.
    expect(rail.stats.lastQuoteRequest?.onChainOverheadPlancks).toBe(0n);

    await session.start({ refundAddress: "bc1-refund" });
    // The channel's destination is the recipient; no ephemeral in the path.
    expect(rail.stats.lastChannelArgs?.destAddress).toBe(RECIPIENT);
    expect(session.getState().phase).toBe("awaiting-deposit");

    await vi.advanceTimersByTimeAsync(1_000); // status tick sees the witnessed egress
    await flush();

    const s = session.getState();
    expect(s.phase).toBe("done");
    if (s.phase === "done") expect(s.result.id).toBe("0xegress123");
    expect(completed).toEqual([{ id: "0xegress123", sourceId: "btc" }]);
    // The whole ephemeral apparatus never engaged:
    expect(harness.stats.submits).toBe(0);
    expect(harness.stats.probes).toBe(0);
    expect(harness.stats.sweeps).toBe(0);
    session.dispose();
  });

  it("resume works with non-deterministic entropy: deliver needs no key", async () => {
    const storage = createMemoryAdapter();
    const first = setupDeliver({ storage });
    await first.session.quote();
    await first.session.start({ refundAddress: "r" });
    first.session.dispose();

    // Non-deterministic entropy fails a spend resume with 'stale'; deliver mode has no key to
    // re-derive.
    const second = setupDeliver({
      storage,
      deterministic: false,
      rail: { statusSequence: [{ status: "complete", egress: { txRef: "0xlate" } }] },
    });
    await second.session.resume();
    expect(second.session.getState().phase).toBe("awaiting-deposit");

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    const s = second.session.getState();
    expect(s.phase).toBe("done");
    if (s.phase === "done") expect(s.result.id).toBe("0xlate");
    second.session.dispose();
  });

  it("resumed done slot restores the persisted txRef receipt without re-emitting", async () => {
    const storage = createMemoryAdapter();
    const first = setupDeliver({
      storage,
      rail: { statusSequence: [{ status: "complete", egress: { txRef: "0xfinal" } }] },
    });
    await first.session.quote();
    await first.session.start({ refundAddress: "r" });
    await flush(); // immediate status tick completes the flow
    expect(first.session.getState().phase).toBe("done");
    first.session.dispose();

    const second = setupDeliver({ storage, deterministic: false });
    const completed: unknown[] = [];
    second.session.events.on("completed", (e) => completed.push(e));
    await second.session.resume();
    const s = second.session.getState();
    expect(s.phase).toBe("done");
    if (s.phase === "done") expect(s.result.id).toBe("0xfinal");
    expect(completed).toEqual([]); // fired once, on first completion, never on resume
    second.session.dispose();
  });

  it("swap failure maps normally and retry() is a no-op (nothing to re-submit)", async () => {
    const { harness, session } = setupDeliver({
      rail: {
        statusSequence: [
          { status: "sending", swapEgressFailure: { reason: { message: "kaput" } } },
        ],
      },
    });
    await session.quote();
    await session.start({ refundAddress: "r" });
    await flush();

    const s = session.getState();
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") {
      expect(s.failure.kind).toBe("egress-failed");
      expect(s.failure.recoverable).toBe(false);
    }
    await session.retry();
    expect(session.getState().phase).toBe("failed");
    expect(harness.stats.submits).toBe(0);
    session.dispose();
  });

  it("cancel clears the slot without sweeping: there is no ephemeral to drain", async () => {
    const { harness, storage, session } = setupDeliver();
    await session.quote();
    await session.start({ refundAddress: "r" });
    await session.cancel();

    expect(harness.stats.sweeps).toBe(0);
    const store = createFlowStore(storage, "btc", RECIPIENT);
    expect(await store.load()).toBeNull();
    expect(session.getState().phase).toBe("idle");
    session.dispose();
  });
});
