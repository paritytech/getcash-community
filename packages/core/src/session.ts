// createPayment(): the orchestration session over reEnter(). Framework-free: everything the
// session needs arrives through the injected ports. One session = one (sourceId, recipient)
// flow slot; selectSource() switches it while idle only.

import type { PaymentAction, Price, PriceEvm, SettlementAsset } from "./action";
import { createEmitter } from "./emitter";
import {
  createFlowStore,
  FLOW_SCHEMA_VERSION,
  type FlowMode,
  type FlowState,
  type FlowStore,
} from "./flow-store";
import type { HandoffAction, HandoffKey } from "./handoff";
import { fnv1a32Hex } from "./hash";
import type {
  EphemeralSigner,
  PaymentDeps,
  SourceAvailability,
  SourceDescriptor,
  SwapStatusResult,
} from "./ports";
import { reEnter, reEnterHandoff, type ReEnterOutcome } from "./reenter";
import type {
  DepositInfo,
  FailureKind,
  FailureStep,
  PaymentFailure,
  PaymentPhase,
  PaymentState,
  Quote,
  Receipt,
  SourceId,
  Subscription,
} from "./state";

/** ~0.3 DOT gas/storage/sweep buffer over the scaled price; the funding gate. */
export const FEE_OVERHEAD_PLANCKS = 3_000_000_000n;
/** 0.1 DOT; cancel() does not sweep below this. */
export const DUST_GUARD_PLANCKS = 1_000_000_000n;
/** Reuse an already-open deposit channel only when more than 2h remain. */
const CHANNEL_REUSE_MIN_REMAINING_MS = 7_200_000;
/** Values crossing the Revive boundary scale /10^8 (EVM 18-dec -> chain 10-dec). */
const EVM_SCALE = 10n ** 8n;

/** Shared configuration for both flow modes. */
export interface PaymentConfigBase {
  /**
   * The final destination account (SS58). Spend mode settles the remainder here; deliver mode
   * egresses directly here.
   */
  recipient: string;
  /** Injected ports (host / browser / test). */
  deps: PaymentDeps;
  /**
   * Desired settlement output; sizes the reverse-quote. For native settlement `amount` is in
   * plancks and is passed to the rail verbatim.
   */
  budget: Price;
  /** The flow slot's source; one session = one (sourceId, recipient) slot. */
  sourceId: SourceId;
  /** Optional restriction of the source catalog; selectSource() rejects ids outside it. */
  sources?: SourceId[];
  /**
   * Onramp-sizing buffer handed to the rail's reverse-quote, plancks. Defaults to the rail's
   * 0.5 DOT in spend mode and 0 in deliver and handoff modes.
   */
  onChainOverheadPlancks?: bigint;
  /** Chainflip status-poll interval, ms. Default 5_000. */
  statusPollIntervalMs?: number;
  /** Age after which an un-funded flow is stale, ms. Default 86_400_000. */
  staleFlowMs?: number;
  /** Decimals of `budget.amount` as handed to the rail's reverse-quote target. Default 10. */
  targetDecimals?: number;
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
}

/** Spend mode: an action to execute from the funded ephemeral. */
export interface SpendPaymentConfig<T> extends PaymentConfigBase {
  /** The domain seam. Its presence selects spend mode. */
  action: PaymentAction<T>;
  handoff?: undefined;
  /**
   * The contract's own charge in EVM 18-dec units; what buildCall prices (distinct
   * from `budget`). The funding gate scales it /10^8 and adds the fee overhead.
   */
  priceEvm: PriceEvm;
  /** Derives the ephemeral signer from the seed (@getsome/ephemeral in production). */
  deriveSigner: (seed: Uint8Array) => EphemeralSigner;
  /** Funding-gate buffer over the scaled price, plancks. Default FEE_OVERHEAD_PLANCKS. */
  feeOverheadPlancks?: bigint;
  /** Balance-poll interval, ms. Default 6_000. */
  pollIntervalMs?: number;
  /** reEnter submit attempts. Default 3. */
  maxMintAttempts?: number;
  /** Delay between reEnter submit attempts, ms. Default 5_000. */
  retryDelayMs?: number;
  /** Entropy derivation label. Default: utf8("onramp:eph:<sourceId>:<recipient>"). */
  entropyLabel?: Uint8Array;
}

/**
 * Deliver mode: no action; Chainflip egresses directly to `recipient`. No ephemeral or funding
 * gate; the rail's egress witness (txRef) is the terminal.
 */
export interface DeliverPaymentConfig extends PaymentConfigBase {
  action?: undefined;
  handoff?: undefined;
}

/**
 * Handoff mode: funds land on a fresh ephemeral, then a host-side settlement (HandoffAction)
 * claims them. The library owns sizing, funded detection, probe-first idempotency, resume and
 * the cancel sweep.
 */
export interface HandoffPaymentConfig extends PaymentConfigBase {
  action?: undefined;
  /** The handoff seam. Its presence (with no `action`) selects handoff mode. */
  handoff: HandoffAction;
  /** Derives the ephemeral key, including the 64-byte secret, from the seed. */
  deriveKey: (seed: Uint8Array) => HandoffKey;
  /** Funding-gate buffer over the settle amount, base units. Default 0n. */
  feeOverheadPlancks?: bigint;
  /** Balance-poll interval, ms. Default 6_000. */
  pollIntervalMs?: number;
  /** Entropy derivation label. Default: utf8("onramp:eph:<sourceId>:<recipient>"). */
  entropyLabel?: Uint8Array;
  /**
   * cancel() sweeps the ephemeral only above this, in the settlement asset's base units. Default
   * 0n.
   */
  cancelDustThreshold?: bigint;
  /**
   * What the settle claims, when it differs from what the rail delivers. `budget` sizes the
   * delivery leg; `settlement`/`settleAmount` are what the funded gate watches and the settle
   * claims. Default budget.asset / budget.amount.
   */
  settlement?: SettlementAsset;
  settleAmount?: bigint;
}

export type PaymentConfig<T> = SpendPaymentConfig<T> | DeliverPaymentConfig | HandoffPaymentConfig;

/** peek() result: sync, side-effect-free view of the persisted slot. */
export interface FlowPeek {
  sourceId: SourceId;
  phase: PaymentPhase;
  createdAt: number;
  stale: boolean;
}

export interface PaymentEventMap extends Record<string, unknown> {
  completed: { id: number | string; sourceId: SourceId };
  failed: { kind: FailureKind; sourceId: SourceId };
}

/** Out-of-band events; render from subscribe(). */
export interface PaymentEvents {
  on<K extends keyof PaymentEventMap & string>(
    event: K,
    cb: (data: PaymentEventMap[K]) => void,
  ): Subscription;
}

/** Source catalog + per-source availability. */
export interface SourceController {
  /** Sync, descriptive, no network. Filtered by config.sources when set. */
  list(): readonly SourceDescriptor[];
  /** Sync current cached verdict; 'unknown' before the first probe. */
  availability(sourceId: SourceId): SourceAvailability;
  /** Pushes the full availability map on each change. */
  subscribeAvailability(
    cb: (byId: Readonly<Record<SourceId, SourceAvailability>>) => void,
  ): Subscription;
  /**
   * Warm the liquidity gate for one (or all) sources. Idempotent: checking/available are not
   * re-probed.
   */
  probe(sourceId?: SourceId): void;
}

/** Thrown by settled() when the flow ends in a terminal 'failed'. */
export class PaymentError extends Error {
  readonly failure: PaymentFailure;
  constructor(failure: PaymentFailure) {
    super(failure.message);
    this.name = "PaymentError";
    this.failure = failure;
  }
}

export interface PaymentSession<T> {
  /**
   * Resolves once flow-store hydration finishes; peek() returns null until then. Re-assigned
   * by selectSource().
   */
  readonly ready: Promise<void>;
  /** Sync snapshot of the reactive state. */
  getState(): PaymentState;
  /** Sync view of the hydrated persisted slot (null before `ready` / when no flow is stored). */
  peek(): FlowPeek | null;
  /** Push on every transition. Primary render path. */
  subscribe(cb: (s: PaymentState) => void): Subscription;
  readonly events: PaymentEvents;
  /** Source catalog + streamed availability. */
  readonly sources: SourceController;
  /** Switch the source while idle only; no-op mid-flow. */
  selectSource(id: SourceId): void;
  /**
   * Reverse-quote from config.budget. On failure, transitions to failed (kind 'quote') and rejects.
   */
  quote(): Promise<Quote>;
  /** Opens the deposit channel. `payload` is required in spend mode. */
  start(args?: { refundAddress?: string; payload?: T }): Promise<void>;
  /** Re-derive key, re-probe isComplete() first, re-attach polls. Concurrent calls dedup. */
  resume(): Promise<void>;
  /** Re-enters from a recoverable failure. No-op in any other state. */
  retry(): Promise<void>;
  /** Abandon: stop polls, best-effort sweep above dust, clear the slot. */
  cancel(): Promise<void>;
  /** Wipes the slot. Only from 'done'; no-op in any other state. */
  clear(): Promise<void>;
  /** Awaitable terminal: resolves on 'done', rejects with PaymentError on 'failed'. */
  settled(): Promise<Receipt>;
  /** Stop polls + drop subscribers/listeners. No state change. */
  dispose(): void;
}

const FAILURE_KINDS: readonly FailureKind[] = [
  "quote",
  "deposit-rejected",
  "egress-failed",
  "fallback-egress",
  "mint",
  "under-credit",
  "refunded",
  "refund-failed",
  "expired",
  "stale",
  "unknown",
];
const FAILURE_STEPS: readonly FailureStep[] = ["deposit", "swap", "mint"];

const REFUND_FAILED: PaymentFailure = {
  kind: "refund-failed",
  step: "swap",
  message: "The refund failed. Contact support with the deposit channel id.",
  recoverable: false,
};

/** ASCII-only byte encoding for the default entropy label. */
function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}

/** Map a Chainflip status result to the failure vocabulary. */
function mapSwapFailure(r: SwapStatusResult): PaymentFailure {
  if (r.depositFailure) {
    // The rail's own kind and message take precedence over the Chainflip defaults.
    return {
      kind: r.depositFailure.kind ?? "deposit-rejected",
      step: "deposit",
      message:
        r.depositFailure.reason?.message ?? "Deposit rejected by Chainflip; funds not recoverable",
      recoverable: false,
    };
  }
  if (r.swapEgressFailure) {
    return {
      kind: r.swapEgressFailure.kind ?? "egress-failed",
      step: "swap",
      message:
        r.swapEgressFailure.reason?.message ??
        "Swap egress failed; funds stuck on Chainflip. Contact support",
      recoverable: false,
    };
  }
  if (r.fallbackEgress) {
    return {
      kind: "fallback-egress",
      step: "swap",
      message: "Funds routed to a fallback chain. Contact support",
      recoverable: false,
    };
  }
  // Plain SDK failed: Chainflip streams the deposit back to the refund address.
  return {
    kind: "refunded",
    step: "swap",
    message: "The deposit didn't go through. It is being returned to your recovery address.",
    recoverable: false,
  };
}

export function createPayment<T>(config: PaymentConfig<T>): PaymentSession<T> {
  const deps = config.deps;
  // The mode discriminants: the action seam selects spend, the handoff seam selects handoff.
  const spend: SpendPaymentConfig<T> | null = config.action ? config : null;
  const handoffCfg: HandoffPaymentConfig | null = !config.action && config.handoff ? config : null;
  const mode: FlowMode = spend ? "spend" : handoffCfg ? "handoff" : "deliver";
  const pollIntervalMs = spend?.pollIntervalMs ?? handoffCfg?.pollIntervalMs ?? 6_000;
  const statusPollIntervalMs = config.statusPollIntervalMs ?? 5_000;
  const maxMintAttempts = spend?.maxMintAttempts ?? 3;
  const staleFlowMs = config.staleFlowMs ?? 86_400_000;
  const retryDelayMs = spend?.retryDelayMs ?? 5_000;
  // Handoff defaults to no overhead; the funded gate is the settle amount itself.
  const feeOverhead = spend
    ? (spend.feeOverheadPlancks ?? FEE_OVERHEAD_PLANCKS)
    : (handoffCfg?.feeOverheadPlancks ?? 0n);
  const now = config.now ?? Date.now;

  let currentSourceId: SourceId = config.sourceId;
  let store: FlowStore = createFlowStore(deps.storage, currentSourceId, config.recipient);

  let state: PaymentState = { phase: "idle", sourceId: currentSourceId };
  const subscribers = new Set<(s: PaymentState) => void>();
  const emitter = createEmitter<PaymentEventMap>();
  const waiters: Array<{ resolve: (r: Receipt) => void; reject: (e: PaymentError) => void }> = [];

  /** Authoritative in-memory copy of the persisted slot (set by start/resume). */
  let flow: FlowState | null = null;
  /** Hydration result; what peek() reads. Kept in sync with every save/clear. */
  let peekCache: FlowState | null = null;
  let lastQuote: Quote | null = null;
  /** Full DepositInfo from this session's channel open; FlowState persists only a subset. */
  let liveDeposit: DepositInfo | null = null;
  /** Held in memory only, never persisted. */
  let signer: EphemeralSigner | null = null;
  /** Handoff mode's key material (address, signer, 64-byte secret). Held in memory only. */
  let handoffKey: HandoffKey | null = null;
  let disposed = false;

  let balanceTimer: ReturnType<typeof setInterval> | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let balanceBusy = false;
  let statusBusy = false;

  let startInFlight: Promise<void> | null = null;
  let resumeInFlight: Promise<void> | null = null;
  /**
   * Single-flight lock over reEnterNow / reEnterHandoffNow. A second entrant joins the in-flight
   * attempt.
   */
  let reentryInFlight: Promise<void> | null = null;
  /**
   * Flow generation. Bumped by cancel, clear, selectSource and dispose; a re-entry outcome from
   * an older generation is dropped.
   */
  let epoch = 0;

  function runExclusiveReentry(fn: () => Promise<void>): Promise<void> {
    if (reentryInFlight) return reentryInFlight;
    const p = fn().finally(() => {
      // Only this attempt may release the lock it holds.
      if (reentryInFlight === p) reentryInFlight = null;
    });
    reentryInFlight = p;
    return p;
  }

  function setState(next: PaymentState): void {
    state = next;
    subscribers.forEach((cb) => cb(next));
  }

  async function hydrate(): Promise<void> {
    peekCache = await store.load();
  }
  let hydration = hydrate();

  async function saveFlow(next: FlowState): Promise<void> {
    flow = next;
    peekCache = next;
    await store.save(next);
  }

  function entropyLabel(): Uint8Array {
    return (
      spend?.entropyLabel ??
      handoffCfg?.entropyLabel ??
      asciiBytes(`onramp:eph:${currentSourceId}:${config.recipient}`)
    );
  }

  async function ensureSigner(): Promise<EphemeralSigner> {
    if (signer) return signer;
    if (!spend) throw new Error("internal: no signer exists outside spend mode");
    const seed = await deps.entropy.deriveSeed(entropyLabel());
    signer = spend.deriveSigner(seed);
    return signer;
  }

  async function ensureHandoffKey(): Promise<HandoffKey> {
    if (handoffKey) return handoffKey;
    if (!handoffCfg) throw new Error("internal: no handoff key exists outside handoff mode");
    const seed = await deps.entropy.deriveSeed(entropyLabel());
    handoffKey = handoffCfg.deriveKey(seed);
    return handoffKey;
  }

  /** The in-memory ephemeral key for the current mode, if derived (null in deliver mode). */
  function ephemeralKey(): EphemeralSigner | null {
    return spend ? signer : handoffCfg ? handoffKey : null;
  }

  function requiredBalanceOf(priceEvm: bigint): bigint {
    return priceEvm / EVM_SCALE + feeOverhead;
  }

  /**
   * Handoff funding gate: the persisted settle amount plus overhead. Null when the slot has no
   * amount.
   */
  function requiredHandoffBalance(f: FlowState): bigint | null {
    return f.handoffAmount === undefined ? null : BigInt(f.handoffAmount) + feeOverhead;
  }

  /**
   * Deposit info to render: the live channel when this session opened it, else the persisted
   * fields.
   */
  function currentDeposit(): DepositInfo {
    if (liveDeposit) return liveDeposit;
    const desc = deps.chainflip.sources().find((s) => s.sourceId === currentSourceId);
    return {
      address: flow?.depositAddress ?? "",
      amount: flow?.depositAmount !== undefined ? BigInt(flow.depositAmount) : 0n,
      formatted: flow?.depositFormatted ?? "",
      assetSymbol: flow?.depositAssetSymbol ?? desc?.asset ?? "",
      expiresAt: flow?.depositExpiresAt ?? 0,
    };
  }

  function resolveWaiters(receipt: Receipt): void {
    waiters.splice(0).forEach((w) => w.resolve(receipt));
  }
  function rejectWaiters(failure: PaymentFailure): void {
    waiters.splice(0).forEach((w) => w.reject(new PaymentError(failure)));
  }

  async function toDone(receipt: Receipt, opts: { emit: boolean } = { emit: true }): Promise<void> {
    stopAllPolls();
    if (flow) await saveFlow({ ...flow, phase: "done" });
    setState({ phase: "done", sourceId: currentSourceId, result: receipt });
    // Events fire once per discovery; a resumed 'done' flow passes emit=false.
    if (opts.emit) emitter.emit("completed", { id: receipt.id, sourceId: currentSourceId });
    resolveWaiters(receipt);
  }

  async function toFailed(
    failure: PaymentFailure,
    opts: { persist: boolean } = { persist: true },
  ): Promise<void> {
    if (opts.persist && flow) {
      // The whole failure is JSON-encoded into errorMessage; resume decodes it.
      await saveFlow({ ...flow, phase: "failed", errorMessage: JSON.stringify(failure) });
    }
    setState({ phase: "failed", sourceId: currentSourceId, failure });
    emitter.emit("failed", { kind: failure.kind, sourceId: currentSourceId });
    rejectWaiters(failure);
  }

  function parseStoredFailure(message: string | undefined): PaymentFailure {
    if (message) {
      try {
        const p = JSON.parse(message) as Partial<PaymentFailure>;
        if (
          typeof p.kind === "string" &&
          FAILURE_KINDS.includes(p.kind) &&
          typeof p.step === "string" &&
          FAILURE_STEPS.includes(p.step) &&
          typeof p.message === "string"
        ) {
          return {
            kind: p.kind,
            step: p.step,
            message: p.message,
            recoverable: p.recoverable === true,
          };
        }
      } catch {
        // fall through; a foreign/legacy message is surfaced verbatim below
      }
    }
    // Unknown provenance is non-recoverable.
    return {
      kind: "mint",
      step: "mint",
      message: message ?? "Payment failed (details lost across reload)",
      recoverable: false,
    };
  }

  function stopBalancePoll(): void {
    if (balanceTimer !== null) {
      clearInterval(balanceTimer);
      balanceTimer = null;
    }
  }
  function stopStatusPoll(): void {
    if (statusTimer !== null) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }
  function stopAllPolls(): void {
    stopBalancePoll();
    stopStatusPoll();
  }

  async function balanceTick(): Promise<void> {
    if (balanceBusy) return;
    const f = flow;
    const key = ephemeralKey();
    if (!f || !key) return;
    balanceBusy = true;
    try {
      // Spend gates on the native balance; handoff gates on the settlement asset.
      const free = spend
        ? await deps.chain.freeBalance(key.address)
        : await deps.chain.settlementBalance(key.address, f.settlement);
      const phase = state.phase;
      const required = spend ? requiredBalanceOf(BigInt(f.priceEvm)) : requiredHandoffBalance(f);
      if (required === null) return; // corrupt handoff slot; surfaced by the re-entry path
      if (free >= required && (phase === "awaiting-deposit" || phase === "swapping")) {
        // Both polls stop before the spend or settle runs.
        stopAllPolls();
        setState({
          phase: "funded",
          sourceId: currentSourceId,
          deposit: currentDeposit(),
          mint: { step: "funded" },
        });
        await (spend ? runSpend() : runHandoff());
      }
    } catch {
      // transient RPC error; self-recovers on the next tick
    } finally {
      balanceBusy = false;
    }
  }

  function startBalancePoll(): void {
    if (balanceTimer !== null || disposed) return;
    void balanceTick(); // immediate first tick
    balanceTimer = setInterval(() => void balanceTick(), pollIntervalMs);
  }

  async function statusTick(): Promise<void> {
    if (statusBusy) return;
    const channelId = flow?.depositChannelId;
    if (!channelId) return;
    statusBusy = true;
    try {
      const result = await deps.chainflip.getStatus(channelId);
      const implicitFailure = !!(
        result.depositFailure ||
        result.swapEgressFailure ||
        result.fallbackEgress
      );

      if (result.status === "complete") {
        // Swap done. Spend: funds detection stays with the balance poll.
        // Deliver: the egress witness is the terminal; funds are at the recipient.
        stopStatusPoll();
        if (mode === "deliver" && state.phase !== "done" && state.phase !== "failed") {
          const txRef = result.egress?.txRef;
          if (flow && txRef !== undefined) await saveFlow({ ...flow, deliverTxRef: txRef });
          await toDone({
            id: txRef ?? flow?.depositChannelId ?? "egress",
            sourceId: currentSourceId,
          });
          return;
        }
      }

      const phase = state.phase;
      if (
        (result.status === "failed" || implicitFailure) &&
        phase !== "failed" &&
        phase !== "done"
      ) {
        stopBalancePoll();
        await toFailed(mapSwapFailure(result));
      } else if (
        !implicitFailure &&
        result.status !== "failed" &&
        result.status !== "waiting" &&
        (phase === "awaiting-deposit" || phase === "swapping")
      ) {
        // In-memory sub-state only; the persisted phase stays 'awaiting-deposit' during the swap.
        setState({
          phase: "swapping",
          sourceId: currentSourceId,
          quote: lastQuote,
          deposit: currentDeposit(),
          swap: result.status,
        });
      }

      // A refund in flight is reported on the failed state as far as Chainflip has taken it.
      if (state.phase === "failed" && result.refundEgress) {
        const { amount, txRef, witnessedAt, failure } = result.refundEgress;
        if (failure && state.failure.kind !== "refund-failed") await toFailed(REFUND_FAILED);
        const failed = state;
        if (failed.phase === "failed") {
          setState({ ...failed, refund: { amount, txRef, witnessedAt } });
        }
      }

      // Terminal for the status poll: hard deposit/egress failure, or refund witnessed/failed.
      // A failed flow with a refund still streaming keeps polling.
      if (
        result.depositFailure ||
        result.swapEgressFailure ||
        result.refundEgress?.witnessedAt ||
        result.refundEgress?.failure
      ) {
        stopStatusPoll();
      }
    } catch {
      // self-recovers on the next tick
    } finally {
      statusBusy = false;
    }
  }

  function startStatusPoll(): void {
    if (statusTimer !== null || disposed) return;
    void statusTick(); // immediate first tick
    statusTimer = setInterval(() => void statusTick(), statusPollIntervalMs);
  }

  function reEnterNow(): Promise<void> {
    return runExclusiveReentry(async () => {
      const f = flow;
      if (!f || !spend) return;
      const epochAtEntry = epoch;
      const s = await ensureSigner();
      const outcome = await reEnter<T>({
        action: spend.action,
        chain: deps.chain,
        signer: s,
        sourceId: currentSourceId,
        recipient: config.recipient,
        settlement: f.settlement,
        key: f.idempotencyKey,
        payload: JSON.parse(f.payload) as T,
        priceEvm: BigInt(f.priceEvm),
        requiredBalance: requiredBalanceOf(BigInt(f.priceEvm)),
        maxAttempts: maxMintAttempts,
        retryDelayMs,
      });
      await applyOutcome(outcome, epochAtEntry);
    });
  }

  async function applyOutcome(outcome: ReEnterOutcome, epochAtEntry: number): Promise<void> {
    // The flow was abandoned while this re-entry was in flight; drop the outcome.
    if (epochAtEntry !== epoch) return;
    switch (outcome.phase) {
      case "done":
        await toDone(outcome.receipt);
        break;
      case "awaiting-deposit": {
        // Not funded (yet/anymore): surface the deposit screen and restart the polls.
        const f = flow;
        if (f && f.phase !== "awaiting-deposit")
          await saveFlow({ ...f, phase: "awaiting-deposit" });
        setState({
          phase: "awaiting-deposit",
          sourceId: currentSourceId,
          quote: lastQuote,
          deposit: currentDeposit(),
        });
        startBalancePoll();
        if (flow?.depositChannelId) startStatusPoll();
        break;
      }
      case "failed":
        stopAllPolls();
        await toFailed(outcome.failure);
        break;
    }
  }

  /** Persist 'working', surface the mint progress, then re-enter (probe-first inside). */
  async function runSpend(): Promise<void> {
    const f = flow;
    if (!f) return;
    await saveFlow({ ...f, phase: "working" });
    setState({
      phase: "working",
      sourceId: currentSourceId,
      deposit: currentDeposit(),
      mint: { step: "minting", attempt: 1, of: maxMintAttempts },
    });
    await reEnterNow();
  }

  function reEnterHandoffNow(): Promise<void> {
    return runExclusiveReentry(async () => {
      const f = flow;
      if (!f || !handoffCfg) return;
      const epochAtEntry = epoch;
      const required = requiredHandoffBalance(f);
      if (required === null) {
        // Corrupt slot: a handoff flow without its settle amount is not re-driven.
        if (epochAtEntry === epoch) {
          await toFailed({
            kind: "stale",
            step: "deposit",
            message: "Stored flow is missing its settle amount; cannot resume this handoff",
            recoverable: false,
          });
        }
        return;
      }
      const key = await ensureHandoffKey();
      const outcome = await reEnterHandoff({
        handoff: handoffCfg.handoff,
        chain: deps.chain,
        key,
        sourceId: currentSourceId,
        idempotencyKey: f.idempotencyKey,
        settlement: f.settlement,
        amount: BigInt(f.handoffAmount as string),
        requiredBalance: required,
        // Surfaces the settle's sub-states: consent, then verification. Epoch-guarded.
        onStep: (step) => {
          if (epochAtEntry !== epoch) return;
          setState({
            phase: "working",
            sourceId: currentSourceId,
            deposit: currentDeposit(),
            mint: { step },
          });
        },
      });
      await applyOutcome(outcome, epochAtEntry);
    });
  }

  /**
   * Persists 'working', surfaces the consent sub-state, then re-enters. 'awaiting-consent' is
   * emitted here and again from reEnterHandoff's onStep.
   */
  async function runHandoff(): Promise<void> {
    const f = flow;
    if (!f) return;
    await saveFlow({ ...f, phase: "working" });
    setState({
      phase: "working",
      sourceId: currentSourceId,
      deposit: currentDeposit(),
      mint: { step: "awaiting-consent" },
    });
    await reEnterHandoffNow();
  }

  const availabilityCache = new Map<SourceId, SourceAvailability>();
  const availabilitySubs = new Set<
    (byId: Readonly<Record<SourceId, SourceAvailability>>) => void
  >();

  function listSources(): readonly SourceDescriptor[] {
    const all = deps.chainflip.sources();
    return config.sources ? all.filter((d) => config.sources?.includes(d.sourceId)) : all;
  }

  function availabilitySnapshot(): Readonly<Record<SourceId, SourceAvailability>> {
    const out = {} as Record<SourceId, SourceAvailability>;
    for (const d of listSources()) {
      out[d.sourceId] = availabilityCache.get(d.sourceId) ?? { status: "unknown" };
    }
    return out;
  }

  function notifyAvailability(): void {
    const snap = availabilitySnapshot();
    availabilitySubs.forEach((cb) => cb(snap));
  }

  function probeOne(id: SourceId): void {
    const cur = availabilityCache.get(id);
    // Checking and available verdicts are not re-probed; unavailable is.
    if (cur && (cur.status === "checking" || cur.status === "available")) return;
    availabilityCache.set(id, { status: "checking" });
    notifyAvailability();
    void deps.chainflip.probeLiquidity(id).then(
      (verdict) => {
        availabilityCache.set(id, verdict);
        notifyAvailability();
      },
      (err: unknown) => {
        availabilityCache.set(id, {
          status: "unavailable",
          reason: err instanceof Error ? err.message : String(err),
        });
        notifyAvailability();
      },
    );
  }

  const sourcesController: SourceController = {
    list: listSources,
    availability: (id) => availabilityCache.get(id) ?? { status: "unknown" },
    subscribeAvailability(cb) {
      availabilitySubs.add(cb);
      return {
        unsubscribe() {
          availabilitySubs.delete(cb);
        },
      };
    },
    probe(id) {
      (id ? [id] : listSources().map((d) => d.sourceId)).forEach(probeOne);
    },
  };

  async function quoteVerb(): Promise<Quote> {
    // quote() is only valid before a flow starts.
    if (flow) throw new Error("a flow is in progress; cancel() it before re-quoting");
    setState({ phase: "quoting", sourceId: currentSourceId });
    try {
      // budget.amount is already in plancks for native settlement. Deliver and handoff modes
      // default the on-chain overhead to zero; spend mode defers to the rail's default.
      const overhead = config.onChainOverheadPlancks ?? (mode !== "spend" ? 0n : undefined);
      const q = await deps.chainflip.getQuote({
        sourceId: currentSourceId,
        target: { amount: config.budget.amount, decimals: config.targetDecimals ?? 10 },
        ...(overhead !== undefined ? { onChainOverheadPlancks: overhead } : {}),
      });
      lastQuote = q;
      setState({ phase: "quoted", sourceId: currentSourceId, quote: q });
      return q;
    } catch (err) {
      // A quote failure transitions to failed (kind 'quote') and rejects. Nothing is persisted at
      // quote time.
      await toFailed(
        {
          kind: "quote",
          step: "deposit",
          message: err instanceof Error ? err.message : "Failed to fetch a quote",
          recoverable: false,
        },
        { persist: false },
      );
      throw err;
    }
  }

  function start(args: { refundAddress?: string; payload?: T } = {}): Promise<void> {
    // Double-start guard: concurrent calls share one in-flight attempt.
    if (startInFlight) return startInFlight;
    startInFlight = doStart(args).finally(() => {
      startInFlight = null;
    });
    return startInFlight;
  }

  async function doStart(args: { refundAddress?: string; payload?: T }): Promise<void> {
    await hydration;

    const existing = flow ?? peekCache;

    // A slot that is already spending or spent never gets a second channel; resume() handles it.
    // A failed flow falls through and starts a new attempt.
    if (
      existing &&
      (existing.phase === "working" || existing.phase === "funded" || existing.phase === "done")
    ) {
      return resume();
    }

    // An open channel with more than 2h remaining is re-attached, unless the entropy source is
    // non-deterministic and cannot re-derive its ephemeral.
    if (
      existing &&
      (existing.phase === "awaiting-deposit" || existing.phase === "swapping") &&
      existing.depositAddress !== undefined &&
      existing.depositExpiresAt !== undefined &&
      existing.depositExpiresAt - now() > CHANNEL_REUSE_MIN_REMAINING_MS &&
      (mode === "deliver" || ephemeralKey() !== null || deps.entropy.deterministic)
    ) {
      flow = existing;
      peekCache = existing;
      if (spend) await ensureSigner();
      if (handoffCfg) await ensureHandoffKey();
      const phase = state.phase;
      if (phase !== "awaiting-deposit" && phase !== "swapping") {
        setState({
          phase: "awaiting-deposit",
          sourceId: currentSourceId,
          quote: lastQuote,
          deposit: currentDeposit(),
        });
      }
      if (mode !== "deliver") startBalancePoll();
      if (existing.depositChannelId) startStatusPoll();
      return;
    }

    stopAllPolls();
    const q = lastQuote;
    // The deposit channel is opened against a quote.
    if (!q) throw new Error("quote() must succeed before start()");
    const startedAt = now();

    // Handoff mode: the channel's destination is the ephemeral; settle claims it host-side.
    if (handoffCfg) {
      const key = await ensureHandoffKey();
      // The rail budget and the settle amount may be different assets; the funding pipeline
      // converts between them.
      const settlement = handoffCfg.settlement ?? config.budget.asset;
      const settleAmount = handoffCfg.settleAmount ?? config.budget.amount;
      // Fails fast when the port cannot read this settlement asset.
      await deps.chain.settlementBalance(key.address, settlement);
      // No payload seam in handoff; the settle amount is the domain input.
      const idempotencyKey = fnv1a32Hex(`${config.recipient}|handoff|${settleAmount}|${startedAt}`);
      const channel = await deps.chainflip.requestDepositAddress({
        quote: q,
        destAddress: key.address,
        refundAddress: args.refundAddress,
      });
      liveDeposit = channel.deposit;
      await saveFlow({
        version: FLOW_SCHEMA_VERSION,
        mode: "handoff",
        sourceId: currentSourceId,
        recipient: config.recipient,
        ephemeralAddress: key.address,
        phase: "awaiting-deposit",
        createdAt: startedAt,
        idempotencyKey,
        payload: "null",
        priceEvm: "0",
        handoffAmount: settleAmount.toString(),
        settlement,
        depositAddress: channel.deposit.address,
        depositChannelId: channel.depositChannelId,
        depositExpiresAt: channel.deposit.expiresAt,
        depositAmount: channel.deposit.amount.toString(),
        depositFormatted: channel.deposit.formatted,
        depositAssetSymbol: channel.deposit.assetSymbol,
      });
      setState({
        phase: "awaiting-deposit",
        sourceId: currentSourceId,
        quote: q,
        deposit: channel.deposit,
      });
      startBalancePoll();
      startStatusPoll();
      return;
    }

    // Deliver mode: the channel's destination is the recipient; no ephemeral, no gate.
    if (!spend) {
      const channel = await deps.chainflip.requestDepositAddress({
        quote: q,
        destAddress: config.recipient,
        refundAddress: args.refundAddress,
      });
      liveDeposit = channel.deposit;
      await saveFlow({
        version: FLOW_SCHEMA_VERSION,
        mode: "deliver",
        sourceId: currentSourceId,
        recipient: config.recipient,
        phase: "awaiting-deposit",
        createdAt: startedAt,
        idempotencyKey: fnv1a32Hex(`${config.recipient}|deliver|${startedAt}`),
        payload: "null",
        priceEvm: "0",
        settlement: config.budget.asset,
        depositAddress: channel.deposit.address,
        depositChannelId: channel.depositChannelId,
        depositExpiresAt: channel.deposit.expiresAt,
        depositAmount: channel.deposit.amount.toString(),
        depositFormatted: channel.deposit.formatted,
        depositAssetSymbol: channel.deposit.assetSymbol,
      });
      setState({
        phase: "awaiting-deposit",
        sourceId: currentSourceId,
        quote: q,
        deposit: channel.deposit,
      });
      startStatusPoll();
      return;
    }

    // Spend mode
    if (args.payload === undefined) {
      throw new Error("spend mode requires start({ payload }); it is handed to buildCall");
    }
    const s = await ensureSigner();

    // Stable per attempt: recipient + payload + start-time.
    const payloadJson = JSON.stringify(args.payload);
    const idempotencyKey = fnv1a32Hex(`${config.recipient}|${payloadJson}|${startedAt}`);

    const channel = await deps.chainflip.requestDepositAddress({
      quote: q,
      destAddress: s.address,
      refundAddress: args.refundAddress,
    });

    liveDeposit = channel.deposit;
    await saveFlow({
      version: FLOW_SCHEMA_VERSION,
      mode: "spend",
      sourceId: currentSourceId,
      recipient: config.recipient,
      ephemeralAddress: s.address,
      phase: "awaiting-deposit",
      createdAt: startedAt,
      idempotencyKey,
      payload: payloadJson,
      priceEvm: spend.priceEvm.toString(),
      settlement: config.budget.asset,
      depositAddress: channel.deposit.address,
      depositChannelId: channel.depositChannelId,
      depositExpiresAt: channel.deposit.expiresAt,
      depositAmount: channel.deposit.amount.toString(),
      depositFormatted: channel.deposit.formatted,
      depositAssetSymbol: channel.deposit.assetSymbol,
    });

    setState({
      phase: "awaiting-deposit",
      sourceId: currentSourceId,
      quote: q,
      deposit: channel.deposit,
    });
    startBalancePoll();
    startStatusPoll();
  }

  function resume(): Promise<void> {
    // Concurrent calls share one attempt; the promise is reset when it settles.
    if (resumeInFlight) return resumeInFlight;
    resumeInFlight = doResume().finally(() => {
      resumeInFlight = null;
    });
    return resumeInFlight;
  }

  async function doResume(): Promise<void> {
    const stored = await store.load();
    peekCache = stored;
    if (!stored) return;
    flow = stored;

    // Stale guard: un-funded and older than the deposit window.
    if (stored.phase === "awaiting-deposit" && now() - stored.createdAt > staleFlowMs) {
      await toFailed({
        kind: "stale",
        step: "deposit",
        message: "Flow expired: deposit window exceeded",
        recoverable: false,
      });
      return;
    }

    // Re-derive the ephemeral in spend and handoff modes. A non-deterministic EntropyPort cannot
    // restore the key.
    if (mode !== "deliver" && ephemeralKey() === null) {
      if (!deps.entropy.deterministic) {
        await toFailed({
          kind: "stale",
          step: "deposit",
          message: "Ephemeral key unrecoverable: entropy is not re-derivable in this environment",
          recoverable: false,
        });
        return;
      }
      if (spend) await ensureSigner();
      if (handoffCfg) await ensureHandoffKey();
    }

    // reEnter and reEnterHandoff probe first, which covers a spend that landed while away.
    switch (stored.phase) {
      case "awaiting-deposit":
      case "swapping":
        if (mode === "deliver") {
          // Nothing to probe or spend: surface the deposit screen and re-attach the status poll.
          setState({
            phase: "awaiting-deposit",
            sourceId: currentSourceId,
            quote: lastQuote,
            deposit: currentDeposit(),
          });
          startStatusPoll();
          break;
        }
        await (handoffCfg ? reEnterHandoffNow() : reEnterNow());
        break;
      case "funded":
      case "working":
        setState({
          phase: "working",
          sourceId: currentSourceId,
          deposit: currentDeposit(),
          mint: handoffCfg
            ? { step: "awaiting-consent" }
            : { step: "minting", attempt: 1, of: maxMintAttempts },
        });
        await (handoffCfg ? reEnterHandoffNow() : reEnterNow());
        break;
      case "done": {
        if (mode === "deliver") {
          // Deliver receipts persist their egress txRef; no probe exists (or is needed).
          await toDone(
            {
              id: stored.deliverTxRef ?? stored.depositChannelId ?? "egress",
              sourceId: stored.sourceId,
            },
            { emit: false },
          );
          break;
        }
        // The receipt id is not persisted for spend and handoff flows; the probe recovers it.
        // 'completed' already fired when the flow first finished.
        const found = spend
          ? await spend.action.isComplete(stored.idempotencyKey)
          : handoffCfg
            ? await handoffCfg.handoff.isSettled(stored.idempotencyKey)
            : null;
        if (found) await toDone({ id: found.id, sourceId: stored.sourceId }, { emit: false });
        break;
      }
      case "failed": {
        const failure = parseStoredFailure(stored.errorMessage);
        setState({ phase: "failed", sourceId: currentSourceId, failure });
        // A refund may still be streaming; keep polling.
        if (failure.kind === "refunded" && stored.depositChannelId) startStatusPoll();
        break;
      }
      default:
        // 'idle'/'quoting'/'quoted' are never persisted mid-flow; nothing to restore.
        break;
    }
  }

  async function retry(): Promise<void> {
    // Only kind 'mint' is recoverable. Deliver mode has no submit to retry.
    if (!spend && !handoffCfg) return;
    // A retry that lands while the failing attempt still holds the lock is dropped.
    if (reentryInFlight !== null)
      return void console.info("[onramp] retry no-op: re-entry in flight");
    const s = state;
    if (s.phase !== "failed" || !s.failure.recoverable) {
      return void console.info(`[onramp] retry no-op: phase=${s.phase}`);
    }
    if (!flow) return void console.info("[onramp] retry no-op: no flow in memory");
    if (ephemeralKey() === null && !deps.entropy.deterministic) {
      return void console.info("[onramp] retry no-op: ephemeral unrecoverable");
    }
    // reEnter and reEnterHandoff probe before submitting.
    console.info("[onramp] retry: running handoff (probe then settle)");
    await (handoffCfg ? runHandoff() : runSpend());
  }

  async function cancelVerb(): Promise<void> {
    // A live re-entry owns the flow. Cancel is deferred: no-op now; the flow reaches done or
    // failed when the re-entry resolves.
    if (reentryInFlight !== null) return;
    stopAllPolls();
    // Bump the flow generation; stray async transitions become no-ops.
    epoch += 1;
    try {
      // Deliver mode has no ephemeral to sweep.
      if (
        (spend || handoffCfg) &&
        flow &&
        (ephemeralKey() !== null || deps.entropy.deterministic)
      ) {
        const key = spend ? await ensureSigner() : await ensureHandoffKey();
        // Spend dust-checks the native balance. Handoff dust-checks the settlement asset and
        // sweeps any balance unless the config sets a threshold.
        const balance = spend
          ? await deps.chain.freeBalance(key.address)
          : await deps.chain.settlementBalance(key.address, flow.settlement);
        const dustGuard = spend ? DUST_GUARD_PLANCKS : (handoffCfg?.cancelDustThreshold ?? 0n);
        if (balance > dustGuard) {
          // Standalone drain back to the connected account. Best effort.
          await deps.chain.sweep(config.recipient, key, flow.settlement);
        }
      }
    } catch {
      // best effort; never block the cancel on a failed sweep
    }
    await store.clear();
    flow = null;
    peekCache = null;
    liveDeposit = null;
    setState({ phase: "idle", sourceId: currentSourceId });
  }

  async function clearVerb(): Promise<void> {
    if (state.phase !== "done") return; // clear-on-success only
    epoch += 1;
    await store.clear();
    flow = null;
    peekCache = null;
    liveDeposit = null;
    setState({ phase: "idle", sourceId: currentSourceId });
  }

  function settled(): Promise<Receipt> {
    const s = state;
    if (s.phase === "done") return Promise.resolve(s.result);
    if (s.phase === "failed") return Promise.reject(new PaymentError(s.failure));
    return new Promise<Receipt>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  function selectSource(id: SourceId): void {
    if (state.phase !== "idle") return; // switching mid-flow would orphan the slot; idle only
    if (config.sources && !config.sources.includes(id)) {
      throw new Error(`sourceId '${id}' is not in the configured source list`);
    }
    currentSourceId = id;
    epoch += 1; // orphan any in-flight re-entry outcome for the old source
    store = createFlowStore(deps.storage, id, config.recipient);
    flow = null;
    peekCache = null;
    lastQuote = null;
    liveDeposit = null;
    // The entropy label includes sourceId; the ephemeral differs per source.
    signer = null;
    handoffKey = null;
    hydration = hydrate();
    setState({ phase: "idle", sourceId: id });
  }

  function peek(): FlowPeek | null {
    const cached = peekCache;
    if (!cached) return null;
    return {
      sourceId: cached.sourceId,
      phase: cached.phase,
      createdAt: cached.createdAt,
      stale: cached.phase === "awaiting-deposit" && now() - cached.createdAt > staleFlowMs,
    };
  }

  return {
    get ready() {
      return hydration;
    },
    getState: () => state,
    peek,
    subscribe(cb) {
      subscribers.add(cb);
      return {
        unsubscribe() {
          subscribers.delete(cb);
        },
      };
    },
    events: { on: emitter.on },
    sources: sourcesController,
    selectSource,
    quote: quoteVerb,
    start,
    resume,
    retry,
    cancel: cancelVerb,
    clear: clearVerb,
    settled,
    dispose() {
      disposed = true;
      stopAllPolls();
      // Orphans any in-flight re-entry outcome; it must not write to storage or resolve
      // settled() waiters after dispose.
      epoch += 1;
      flow = null;
      subscribers.clear();
      availabilitySubs.clear();
      emitter.clear();
      // No state change; pending settled() waiters stay pending.
    },
  };
}
