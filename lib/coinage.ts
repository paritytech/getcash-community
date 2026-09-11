// Payment session wiring for the CASH handoff. Funds land on a disposable ephemeral; the
// worker converts them and claims them into the user's balance through the host's top-up.
// This module owns the hand-off to the worker and the settle and isSettled seams.

import {
  createFlowStore,
  createPayment,
  type ActionCall,
  type ChainflipRail,
  type ChainPort,
  type EntropyPort,
  type EphemeralSigner,
  type HandoffAction,
  type PaymentSession,
  type SettlementAsset,
  type SettlePlan,
  type SourceId,
  type StorageAdapter,
  type Subscription,
} from "@getsome/core";
import { blake2b } from "@noble/hashes/blake2.js";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import {
  deriveKeypairWithSecret,
  deriveRefundKey,
  isRefundChain,
  toHandoffKey,
  type BitcoinNetwork,
  type RefundChain,
  type RefundKey,
} from "@getsome/ephemeral";
import { entropyToMiniSecret } from "@polkadot-labs/hdkd-helpers";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import {
  createManualRail,
  DEFAULT_KEEP_NATIVE_FOR_FEES,
  DEFAULT_REMOTE_FEE_BUFFER,
  type FundingStep,
  PASEO_PEOPLE_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  sizeNativeBudget,
} from "@getsome/funding";
import { createHostDeps } from "@getsome/host";
import {
  CASH_DECIMALS,
  CASH_SETTLEMENT,
  createPeopleChainPort,
  type PeopleChainPort,
} from "@getsome/people";
import {
  createFakeHandoff,
  createFakeHarness,
  createFakeRail,
  createMemoryAdapter,
  type FakeHandoff,
  type Harness,
} from "@getsome/testing";
import { NETWORK } from "./chainflip-backend";

const NATIVE_DECIMALS = 10;
const BITCOIN_NETWORK: BitcoinNetwork = NETWORK === "mainnet" ? "mainnet" : "testnet";
const PURSE_BALANCE_TIMEOUT_MS = 10_000;

interface PaymentsLike {
  subscribeBalance(cb: (balance: { available: bigint }) => void): {
    unsubscribe(): void;
    onInterrupt?(cb: (reason?: unknown) => void): unknown;
  };
}

/** Awaits `work` with a timeout and prefixes any failure with the stage label. */
function stage<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        const message = e instanceof Error ? e.message : String(e);
        // A papi "Incompatible entry" error means the committed descriptors no longer match the
        // runtime.
        reject(
          new Error(
            /incompatible (runtime )?entry/i.test(message)
              ? `${label}: this build's chain descriptors no longer match the runtime; regenerate them and redeploy (${message})`
              : `${label}: ${message}`,
          ),
        );
      },
    );
  });
}

/** One-shot purse balance read off the subscription; rejects on timeout. */
export function readPurseBalance(payments: PaymentsLike): Promise<bigint> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error("purse balance read timed out"));
    }, PURSE_BALANCE_TIMEOUT_MS);
    const sub = payments.subscribeBalance((balance) => {
      clearTimeout(timer);
      resolve(balance.available);
      queueMicrotask(() => sub.unsubscribe());
    });
    sub.onInterrupt?.((payload) => {
      clearTimeout(timer);
      sub.unsubscribe();
      reject(new Error(`purse balance subscription interrupted: ${JSON.stringify(payload)}`));
    });
  });
}

const recordKey = (key: string) => `coinage:settle:${key}`;

/** Readable error text for logs. */
function msgOf(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "object" && e !== null) {
    const o = e as { name?: unknown; message?: unknown; reason?: unknown };
    const parts = [o.name, o.message, o.reason]
      .filter((v) => v !== undefined)
      .map((v) => JSON.stringify(v));
    if (parts.length > 0) return parts.join(" ");
  }
  return String(e);
}

/** This session's record of the worker's claim. Only `settled` is read back. */
interface SettleRecord {
  /** The burner the claim was made from (SS58). */
  burner?: string;
  /** What the worker claimed, in CASH base units. */
  amount: string;
  settled: true;
}

/** How long settle waits for the worker's claim before failing recoverably. */
const WORKER_CLAIM_WAIT_MS = 200_000;

/**
 * HandoffAction with the worker as the only claimer. settle waits for the worker's claim and
 * records it; isSettled reads the record back, or the worker's marker.
 */
export function createCoinageHandoff(opts: {
  storage: StorageAdapter;
  /** The burner this session's CASH lands on (SS58); recorded with the claim. */
  burnerAddress?: string;
  /** Reads the worker's claim marker for this session. */
  readWorkerClaim: () => Promise<WorkerClaim | null>;
  /** Settle-internal progress for the UI: reports the claim amount once the worker made it. */
  onProgress?: (stage: "prompted" | "crediting", claimed?: bigint) => void;
}): HandoffAction {
  async function recordWorkerClaim(key: string, claim: WorkerClaim): Promise<void> {
    const record: SettleRecord = {
      ...(opts.burnerAddress === undefined ? {} : { burner: opts.burnerAddress }),
      amount: claim.amount ?? "0",
      settled: true,
    };
    await opts.storage.write(recordKey(key), JSON.stringify(record));
    console.warn(`[coinage] settle: claimed by the worker (${claim.amount ?? "?"}), recorded`);
    opts.onProgress?.("crediting", BigInt(record.amount));
  }

  const readClaim = () => opts.readWorkerClaim().catch(() => null);

  return {
    async settle(_ctx, key) {
      // Called once core has seen the CASH on People. Waits for the worker's verdict.
      opts.onProgress?.("prompted");
      const deadline = Date.now() + WORKER_CLAIM_WAIT_MS;
      let claim = await readClaim();
      while (claim?.phase !== "claimed" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        claim = await readClaim();
      }
      if (claim?.phase === "claimed") {
        await recordWorkerClaim(key, claim);
        return;
      }
      // Throw, do not return: core re-probes a settle that throws and fails it recoverably.
      console.warn(
        `[coinage] settle: the worker has not claimed within ${WORKER_CLAIM_WAIT_MS / 1000}s (${claim?.error ?? "no verdict yet"}); failing recoverably`,
      );
      throw new Error(
        "the claim has not completed yet; it keeps retrying in the background; try again shortly",
      );
    },
    async isSettled(key) {
      try {
        const raw = await opts.storage.read(recordKey(key));
        if (raw && (JSON.parse(raw) as SettleRecord).settled) {
          console.warn("[coinage] isSettled: persisted verdict (settled), no reads");
          return { id: key };
        }
        // No record yet: check the worker's marker and record it if the claim landed.
        const claim = await readClaim();
        if (claim?.phase === "claimed") {
          await recordWorkerClaim(key, claim);
          return { id: key };
        }
        console.warn(`[coinage] isSettled: not settled (worker claim: ${claim?.phase ?? "none"})`);
        return null;
      } catch (e) {
        console.error(`[coinage] isSettled THREW (probe error, not a claim): ${msgOf(e)}`);
        throw e;
      }
    },
  };
}

/**
 * A People ChainPort that re-resolves its client per call. After evictChains() the next call
 * re-dials and the same session continues in place.
 */
function resilientPeoplePort(): ChainPort {
  let bound: { client: unknown; port: PeopleChainPort } | null = null;
  const portNow = async (): Promise<PeopleChainPort> => {
    const { connectChain, PEOPLE } = await import("./host-chain");
    const client = await connectChain(PEOPLE);
    if (!bound || bound.client !== client) {
      bound = { client, port: createPeopleChainPort({ client }) };
    }
    return bound.port;
  };
  const asyncSub = (subscribe: (port: ChainPort) => Subscription): Subscription => {
    let inner: Subscription | null = null;
    let dead = false;
    portNow()
      .then((port) => {
        if (dead) return;
        inner = subscribe(port);
      })
      .catch(() => {
        /* the poll fallback owns recovery */
      });
    return {
      unsubscribe: () => {
        dead = true;
        inner?.unsubscribe();
      },
    };
  };
  return {
    freeBalance: async (ss58: string) => (await portNow()).freeBalance(ss58),
    watchFreeBalance: (ss58: string, cb: (free: bigint) => void) =>
      asyncSub((p) => p.watchFreeBalance(ss58, cb)),
    settlementBalance: async (ss58: string, settlement: SettlementAsset) =>
      (await portNow()).settlementBalance(ss58, settlement),
    watchSettlementBalance: (
      ss58: string,
      settlement: SettlementAsset,
      cb: (balance: bigint) => void,
    ) => asyncSub((p) => p.watchSettlementBalance(ss58, settlement, cb)),
    submit: async (call: ActionCall, signer: EphemeralSigner, settle: SettlePlan) =>
      (await portNow()).submit(call, signer, settle),
    sweep: async (dest: string, signer: EphemeralSigner, settlement: SettlementAsset) =>
      (await portNow()).sweep(dest, signer, settlement),
    get api() {
      return bound?.port.api;
    },
  };
}

interface StorageLike {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

export function tradeCounterKey(sourceId: string): string {
  return `coinage:trade-counter:${sourceId}`;
}

/**
 * The entropy label for trade `n`. Counting starts at 1. The encoded label stays at 32 bytes
 * or fewer, the host's key limit.
 */
export function tradeEntropyLabelString(sourceId: string, n: number): string {
  return `onramp:eph:${sourceId}:${n}`;
}

export function tradeEntropyLabel(sourceId: string, n: number): Uint8Array {
  // The worker hand-off carries the string form and builds the same bytes from it.
  return new TextEncoder().encode(tradeEntropyLabelString(sourceId, n));
}

/** The refund key's entropy label for trade `n`. */
export function refundEntropyLabel(sourceId: string, n: number): Uint8Array {
  return new TextEncoder().encode(`onramp:rf:${sourceId}:${n}`);
}

export function refundStorageKey(sourceId: string, n: number): string {
  return `coinage:refund:${sourceId}:${n}`;
}

/** The chain a source's refund key lives on; null for the manual rail. */
export function refundChainFor(sourceId: SourceId): RefundChain | null {
  const chain = SOURCE_CONFIG_BY_ID.get(sourceId)?.chain;
  return chain !== undefined && isRefundChain(chain) ? chain : null;
}

/**
 * Derives trade `n`'s refund key and records its address. A stored record that disagrees
 * with the derivation is refused. The secret is held in memory only.
 */
export async function provisionRefundKey(
  deps: { entropy: Pick<EntropyPort, "deriveSeed">; storage: StorageLike },
  sourceId: SourceId,
  n: number,
  bitcoinNetwork: BitcoinNetwork,
): Promise<RefundKey | null> {
  const chain = refundChainFor(sourceId);
  if (chain === null) return null;
  const seed = await deps.entropy.deriveSeed(refundEntropyLabel(sourceId, n));
  const key = deriveRefundKey(chain, seed, { bitcoinNetwork });
  if (!SOURCE_CONFIG_BY_ID.get(sourceId)?.validateRefundAddress(key.address)) {
    throw new Error(`refund address ${key.address} is not valid for ${sourceId}`);
  }
  const slot = refundStorageKey(sourceId, n);
  const matches = (raw: string | null): boolean => {
    try {
      return (JSON.parse(raw ?? "") as Partial<RefundKey>).address === key.address;
    } catch {
      return false;
    }
  };
  const stored = await deps.storage.read(slot);
  if (stored === null) {
    const record = { chain: key.chain, address: key.address, format: key.format };
    await deps.storage.write(slot, JSON.stringify(record));
    if (!matches(await deps.storage.read(slot))) {
      throw new Error(`refund key for trade ${n} could not be stored`);
    }
  } else if (!matches(stored)) {
    throw new Error(`stored refund key for trade ${n} does not match its derivation`);
  }
  return key;
}

/** True once the deposit is on the burner. */
export function depositLanded(phase: string | undefined): boolean {
  return phase === "funded" || phase === "working" || phase === "done";
}

export interface RefundKeyHold {
  /** The Chainflip refund address; null on the manual rail or once the deposit has landed. */
  refundAddress: string | null;
  /** The key behind it, for the recovery screen; null once the deposit has landed. */
  revealRefundKey(): RefundKey | null;
}

/**
 * Holds a request's refund key and forgets it, in memory and storage, once the deposit has landed.
 */
function holdRefundKey(
  session: PaymentSession<never>,
  storage: Pick<StorageAdapter, "clear">,
  sourceId: SourceId,
  n: number,
  key: RefundKey | null,
): RefundKeyHold {
  let held = key;
  let cleared = key === null;
  const forget = async () => {
    if (cleared) return;
    cleared = true;
    held = null;
    try {
      await storage.clear(refundStorageKey(sourceId, n));
      console.info(`[coinage] refund key for trade #${n} forgotten: the deposit has landed`);
    } catch (e) {
      cleared = false;
      console.warn("[coinage] refund key clear failed (retried on the next update):", e);
    }
  };
  session.subscribe((s) => {
    if (depositLanded(s.phase)) void forget();
  });
  return { refundAddress: key?.address ?? null, revealRefundKey: () => held };
}

/** Current trade number from host storage; anything missing or malformed means 1. */
export async function readTradeCounter(storage: StorageLike, sourceId: string): Promise<number> {
  const raw = await storage.read(tradeCounterKey(sourceId)).catch(() => null);
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** True once the request has a deposit address and has taken its burner. */
export function isRequestStarted(phase: string): boolean {
  return (
    phase === "awaiting-deposit" ||
    phase === "swapping" ||
    phase === "funded" ||
    phase === "working" ||
    phase === "done"
  );
}

/** Re-derives every trade burner up to the stored counter. Needs the live entropy port. */
export async function enumerateTradeBurners(args: {
  entropy: EntropyPort;
  storage: StorageLike;
  sourceId: string;
}): Promise<Array<{ n: number; address: string }>> {
  const current = await readTradeCounter(args.storage, args.sourceId);
  const out: Array<{ n: number; address: string }> = [];
  for (let n = 1; n <= current; n++) {
    const seed = await args.entropy.deriveSeed(tradeEntropyLabel(args.sourceId, n));
    out.push({ n, address: deriveKeypairWithSecret(seed).address });
  }
  return out;
}

export interface CoinageSessionArgs {
  /** Settle amount in CASH base units (6 decimals). */
  amount: bigint;
  sourceId: SourceId;
  /** Override the funding rail. Omitted, the mock world uses the scriptable fake rail. */
  rail?: ChainflipRail;
  /**
   * Budget in native base units (10 decimals), for a rail whose egress is the native token.
   * Omitted, the budget is the CASH settle amount itself.
   */
  nativeBudget?: bigint;
  /**
   * Which trade's burner to derive. Omit for a new request, which reads the stored counter
   * and claims it on start. Pass it to re-open an existing request.
   */
  tradeN?: number;
}

export interface MockCoinageWorld extends RefundKeyHold {
  session: PaymentSession<never>;
  handoff: FakeHandoff;
  harness: Harness;
  rail: ChainflipRail;
  storage: StorageAdapter;
}

/** Deterministic 32-byte seed from a label, for mock mode. */
function mockEntropy(): EntropyPort {
  return {
    deterministic: true,
    async deriveSeed(label: Uint8Array): Promise<Uint8Array> {
      const out = new Uint8Array(32);
      label.forEach((b, i) => {
        out[i % 32] = (out[i % 32] ?? 0) ^ b;
      });
      return out;
    },
  };
}

/**
 * Offline world: the real session and state machine over scriptable fakes, with no host or network.
 */
export async function createMockCoinageSession(
  args: CoinageSessionArgs & { recipient: string },
): Promise<MockCoinageWorld> {
  const handoff = createFakeHandoff({ manualConsent: true });
  const harness = createFakeHarness();
  const rail = args.rail ?? createFakeRail();
  const storage = createMemoryAdapter();
  const entropy = mockEntropy();
  const tradeN = args.tradeN ?? 1;
  const refundKey = await provisionRefundKey(
    { entropy, storage },
    args.sourceId,
    tradeN,
    BITCOIN_NETWORK,
  );
  const session = createPayment({
    recipient: args.recipient,
    handoff: handoff.handoff,
    deriveKey: (seed) => toHandoffKey(deriveKeypairWithSecret(seed)),
    deps: { chain: harness.chain, chainflip: rail, storage, entropy },
    // A rail that egresses CASH takes the settle amount as its budget; one that egresses the
    // native token needs a native budget and an explicit CASH settle leg. See `nativeBudget`.
    ...(args.nativeBudget === undefined
      ? { budget: { amount: args.amount, asset: CASH_SETTLEMENT }, targetDecimals: CASH_DECIMALS }
      : {
          budget: { amount: args.nativeBudget, asset: { kind: "native" as const } },
          targetDecimals: NATIVE_DECIMALS,
          settlement: CASH_SETTLEMENT,
          settleAmount: args.amount,
        }),
    sourceId: args.sourceId,
  });
  const refund = holdRefundKey(session, storage, args.sourceId, tradeN, refundKey);
  return { session, handoff, harness, rail, storage, ...refund };
}

export interface CoinageWorld extends RefundKeyHold {
  session: PaymentSession<never>;
  /** This request's burner (SS58). It receives the deposit and holds the CASH until the claim. */
  burnerAddress: string;
  /**
   * The session's source id: the key under which this request's trade counter and burner entropy
   * label live.
   */
  sourceId: SourceId;
  /** This request's trade number; pass it back as `tradeN` to re-open the request. */
  tradeN: number;
  /**
   * Runs the pool funding leg in the worker: native deposit on Asset Hub, converted to CASH and
   * teleported to People in one XCM, claim into the purse. Single-flight; resolves when the
   * worker reports the claim.
   */
  runFunding(hooks?: {
    onStep?: (step: FundingStep) => void;
    onTransientError?: (error: unknown) => void;
    onTx?: (info: { call: "swap"; txHash: string; block?: number }) => void;
    /** The worker claimed the CASH into the purse; `amount` is what it took. */
    onClaimed?: (amount: bigint) => void;
  }): Promise<void>;
  /** The burner's native balance on Asset Hub at the best block. */
  readBurnerNativeOnAh(): Promise<bigint>;
  /** The burner's recovery secret (0x hex mini-secret), importable into a wallet as a raw seed. */
  exportBurnerSecret(): Promise<string>;
  /** Stops this session's work; the shared chain clients stay connected. */
  dispose(): void;
}

/** The host SDK's deriveEntropy signature. */
export type ParityDeriveEntropy = (
  key: Uint8Array,
) => Promise<{ ok: true; value: Uint8Array } | { ok: false; error: unknown }>;

/** Source id a session is keyed under when a rail injects none. */
export const DEFAULT_SOURCE_ID = "dot-assethub" as const;

/** The id a funding session is handed to the worker under, and the key of the worker's job. */
export function workerSessionId(sourceId: string | undefined, tradeN: number): string {
  return `${sourceId ?? DEFAULT_SOURCE_ID}:${tradeN}`;
}

/** Storage key for the worker's jobs in the shared product storage. */
const WORKER_JOBS_KEY = "getsome.funding.jobs";

/** The worker's claim marker for `sessionId`, or null when there is no job or no claim yet. */
export async function readWorkerClaim(
  hostLocalStorage: unknown,
  sessionId: string,
): Promise<WorkerClaim | null> {
  const store = hostLocalStorage as { readJSON?: (key: string) => Promise<unknown> } | null;
  if (!store?.readJSON) return null;
  const jobs = (await store.readJSON(WORKER_JOBS_KEY)) as Record<
    string,
    { claim?: WorkerClaim | null }
  > | null;
  return jobs?.[sessionId]?.claim ?? null;
}

interface WorkerLike {
  isAvailable(): boolean;
  call<T>(apiName: string, payload?: unknown, options?: { deadlineMs?: number }): Promise<T>;
}

/** True for a WorkerCallError tagged "invalid", matched by shape. */
const isRefusal = (error: unknown): boolean =>
  error instanceof Error && (error as { tag?: unknown }).tag === "invalid";

/** The worker's fundingStatus answer. */
interface WorkerFundingStatus {
  phase?: string;
  done?: boolean;
  known?: boolean;
  lastError?: string;
  failure?: string;
  txs?: { call: "swap"; txHash: string; block?: number }[];
  /** The worker's claim of the landed CASH into the purse. */
  claim?: WorkerClaim | null;
}

/**
 * The worker's claim record: `claiming` before the host call, `claimed` once the host has answered.
 */
export interface WorkerClaim {
  phase: "claiming" | "claimed";
  amount?: string;
  at: number;
  error?: string;
}

/** How long to wait for the worker to come up before a hand-off fails. */
const WORKER_READY_MS = 20_000;

/**
 * Hands the session to the worker once, then polls the job back until the worker reports
 * the CASH claimed into the purse. Each poll round also nudges tickAllFunding.
 */
export async function runFundingViaWorker(input: {
  worker: WorkerLike;
  sessionId: string;
  handoff: Record<string, string | number>;
  stop: { aborted: boolean };
  pollMs?: number;
  readyMs?: number;
  hooks?: {
    onStep?: (step: FundingStep) => void;
    onTransientError?: (error: unknown) => void;
    onTx?: (info: { call: "swap"; txHash: string; block?: number }) => void;
    /** The worker claimed the CASH into the purse: the purchase is complete. */
    onClaimed?: (amount: bigint) => void;
  };
}): Promise<void> {
  const readyBy = Date.now() + (input.readyMs ?? WORKER_READY_MS);
  while (!input.worker.isAvailable() && Date.now() < readyBy) {
    if (input.stop.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!input.worker.isAvailable()) {
    throw new Error("the funding worker is not running on this host; the purchase cannot start");
  }
  // A refused or unanswered hand-off throws a WorkerCallError; no job exists either way.
  const handOff = () =>
    input.worker.call("startFunding", { sessionId: input.sessionId, ...input.handoff });
  await handOff();

  const pollMs = input.pollMs ?? 6_000;
  let lastStep: string | null = null;
  const seenTx = new Set<string>();
  while (!input.stop.aborted) {
    let status: WorkerFundingStatus | null = null;
    try {
      // Detached: a tick can run for tens of seconds and the poll does not wait on it.
      void input.worker.call("tickAllFunding").catch(() => {});
      status = await input.worker.call<WorkerFundingStatus>("fundingStatus", {
        sessionId: input.sessionId,
      });
    } catch (error) {
      // Transport blip or a worker mid-teardown; try again.
      input.hooks?.onTransientError?.(error);
    }

    if (status?.known === false) {
      // The worker's store has no record: re-send the idempotent hand-off. A refusal is final.
      try {
        await handOff();
      } catch (error) {
        if (isRefusal(error)) throw error;
        input.hooks?.onTransientError?.(error);
      }
    }

    if (status && status.known !== false) {
      for (const tx of status.txs ?? []) {
        if (!seenTx.has(tx.txHash)) {
          seenTx.add(tx.txHash);
          input.hooks?.onTx?.(tx);
        }
      }
      // A landed claim completes the purchase whatever else the record says.
      if (status.claim?.phase === "claimed") {
        input.hooks?.onClaimed?.(BigInt(status.claim.amount ?? "0"));
        return;
      }
      const phase = String(status.phase ?? "");
      if (phase === "failed") throw new Error(status.lastError ?? "worker funding failed");
      if (phase && phase !== "starting" && phase !== lastStep) {
        lastStep = phase;
        input.hooks?.onStep?.(phase as FundingStep);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Adapts the host's deriveEntropy to the {isErr,value|error} shape the entropy port consumes.
 *  Labels over the host's 32-byte key cap are pre-hashed with BLAKE2b. */
export function hostSafeEntropy(deriveEntropy: ParityDeriveEntropy) {
  return async (key: Uint8Array) => {
    const hostKey = key.length <= 32 ? key : blake2b(key, { dkLen: 32 });
    const r = await deriveEntropy(hostKey);
    return r.ok ? { isErr: () => false, value: r.value } : { isErr: () => true, error: r.error };
  };
}

export async function createCoinageSession(
  args: CoinageSessionArgs & {
    hostLocalStorage: unknown;
    deriveEntropy: ParityDeriveEntropy;
    /** The product's worker: the only driver of this session's funding and claim. */
    worker: WorkerLike;
    onClaimProgress?: (stage: "prompted" | "crediting", claimed?: bigint) => void;
  },
): Promise<CoinageWorld> {
  // The live world serves the sources that land native DOT on the burner: the manual rail and
  // the Meld rails.
  const LIVE_SOURCES = new Set<SourceId>(["dot-assethub", "meld-card", "meld-bank"]);
  if (!LIVE_SOURCES.has(args.sourceId)) {
    throw new Error(`live mode does not serve source '${args.sourceId}'`);
  }
  const { connectChain, evictChains, PEOPLE, ASSET_HUB } = await import("./host-chain");
  const [peopleClient] = await Promise.all([connectChain(PEOPLE), connectChain(ASSET_HUB)]);
  const peoplePort = resilientPeoplePort();
  // Resolved per call: after a redial the cached client is a new object.
  const assetHubApi = async () => (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  const { deps: hostDeps } = createHostDeps({
    // Required by the input type but unread: `chain` below supplies the port.
    client: peopleClient,
    chain: peoplePort,
    // The Meld rail when the fiat route injected one; the manual rail (direct deposit) otherwise.
    chainflip: args.rail ?? createManualRail(),
    // The host's storage matches the readString/writeString/clear shape createHostDeps wants.
    hostLocalStorage: args.hostLocalStorage as Parameters<
      typeof createHostDeps
    >[0]["hostLocalStorage"],
    deriveEntropy: hostSafeEntropy(args.deriveEntropy),
  });
  // Host entropy only: the worker derives this session's burner from the same label through the
  // same host.
  const deps = hostDeps;

  // The label carries a host-persisted trade counter. A new request derives a fresh burner;
  // a re-opened one passes its number back.
  const tradeN =
    args.tradeN ??
    (await stage("trade counter read", 10_000, readTradeCounter(deps.storage, args.sourceId)));
  // One entropy label, shared verbatim by the session's key derivation and the worker hand-off.
  const entropyLabelString = tradeEntropyLabelString(args.sourceId, tradeN);
  const entropyLabel = tradeEntropyLabel(args.sourceId, tradeN);
  const deriveKey = (seed: Uint8Array) => toHandoffKey(deriveKeypairWithSecret(seed));

  // The burner receives the deposit on Asset Hub and holds the CASH on People under the same SS58.
  const seed = await stage("entropy derivation", 10_000, deps.entropy.deriveSeed(entropyLabel));
  const burnerKey = deriveKey(seed);
  // Host loggers may forward only warn and error.
  console.warn(`[coinage] ephemeral (burner): ${burnerKey.address}`);

  // Best-effort backup of the burner's recovery secret in host storage; setup does not wait on it.
  const burnerMini = entropyToMiniSecret(seed);
  const burnerHex = `0x${Array.from(burnerMini, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  void deps.storage
    .write(`coinage:burner:${args.sourceId}:${tradeN}`, burnerHex)
    .catch((e: unknown) => console.warn("[coinage] burner backup write failed (non-fatal):", e));

  // A re-opened request whose deposit has landed gets no refund key.
  const stored = await stage(
    "flow slot read",
    10_000,
    createFlowStore(deps.storage, args.sourceId, burnerKey.address).load(),
  );
  const refundKey = depositLanded(stored?.phase)
    ? null
    : await stage(
        "refund key",
        10_000,
        provisionRefundKey(deps, args.sourceId, tradeN, BITCOIN_NETWORK),
      );

  // Size the deposit from live chain reads: the CASH over-buy for People's execution fee and the
  // native the burner keeps for the funding program. The same figures feed the worker hand-off
  // below.
  const { estimateFundingSizing } = await import("./funding-fees");
  const sizing = await stage(
    "funding sizing estimate",
    20_000,
    estimateFundingSizing({
      ahClient: await connectChain(ASSET_HUB),
      peopleClient: await connectChain(PEOPLE),
      underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
      peopleParaId: PASEO_PEOPLE_PARA_ID,
      settleAmount: args.amount,
      probeAddress: burnerKey.address,
    }),
  ).catch(() => null);
  const keepNativeForFees = sizing?.keepNativeForFees ?? DEFAULT_KEEP_NATIVE_FOR_FEES;
  const remoteFeeBuffer = sizing?.remoteFeeBuffer ?? DEFAULT_REMOTE_FEE_BUFFER;

  // Size the native budget the user must deposit from the live pool quote for the CASH
  // settle amount, plus the headroom that lets the deposit clear the worker's swap gate after
  // the pool moves (DEFAULT_SLIPPAGE_PCT), plus the retained fee native.
  const budget = await stage(
    "pool budget sizing",
    15_000,
    sizeNativeBudget({
      client: await connectChain(ASSET_HUB),
      underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
      settleAmount: args.amount,
      remoteFeeBuffer,
      keepNativeForFees,
    }),
  );

  const session = createPayment({
    // The burner is its own recipient; core uses this only to key the flow slot and the claim
    // record.
    recipient: burnerKey.address,
    // Disables the cancel sweep; the claim takes everything on the burner.
    cancelDustThreshold: 2n ** 127n,
    handoff: createCoinageHandoff({
      storage: deps.storage,
      onProgress: args.onClaimProgress,
      burnerAddress: burnerKey.address,
      // Same session id the hand-off uses.
      readWorkerClaim: () =>
        readWorkerClaim(args.hostLocalStorage, workerSessionId(args.sourceId, tradeN)),
    }),
    deriveKey,
    entropyLabel,
    settlement: CASH_SETTLEMENT,
    settleAmount: args.amount,
    deps,
    budget: { amount: budget, asset: { kind: "native" } },
    targetDecimals: NATIVE_DECIMALS, // the manual rail quotes the native budget
    sourceId: args.sourceId,
  });

  // Trade rotation: advance the counter once, when this request starts. A failed write is
  // retried on the next update.
  let tradeAdvanced = false;
  const advanceTrade = async () => {
    if (tradeAdvanced) return;
    tradeAdvanced = true;
    try {
      await deps.storage.write(tradeCounterKey(args.sourceId), String(tradeN + 1));
      console.info(
        `[coinage] trade #${tradeN} claimed; the next request derives a fresh burner (#${tradeN + 1})`,
      );
    } catch (e) {
      tradeAdvanced = false;
      console.warn("[coinage] trade counter advance failed (the burner will be reused):", e);
    }
  };
  // Re-opened requests (an explicit tradeN) never advance the counter.
  if (args.tradeN === undefined) {
    session.subscribe((s) => {
      if (isRequestStarted(s.phase)) void advanceTrade();
    });
  }

  // Single-flight while running, resettable after failure. The stop signal ends the poll on
  // dispose.
  const stop = { aborted: false };
  let funding: Promise<void> | null = null;
  const runFunding: CoinageWorld["runFunding"] = (hooks) => {
    if (!funding) {
      const run = (async () => {
        // The worker drives every submit. This page hands the session over once and then only
        // reads the job back.
        const { ASSET_HUB_GENESIS, PEOPLE_GENESIS } = await import("./host-chain");
        // The rail's deposit deadline, read once the persisted slot is hydrated.
        await session.ready;
        const state = session.getState();
        const depositExpiresAt =
          state.phase === "awaiting-deposit" ? (state.deposit.expiresAt ?? 0) : 0;
        await runFundingViaWorker({
          worker: args.worker,
          sessionId: workerSessionId(args.sourceId, tradeN),
          handoff: {
            label: entropyLabelString,
            // The worker derives its own address from the label and refuses the hand-off if the two
            // differ.
            burnerAddress: burnerKey.address,
            depositExpiresAt,
            settleAmount: args.amount.toString(),
            underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
            peopleParaId: PASEO_PEOPLE_PARA_ID,
            assetHubGenesis: ASSET_HUB_GENESIS,
            peopleGenesis: PEOPLE_GENESIS,
            // The same live estimates that sized the deposit.
            remoteFeeBuffer: remoteFeeBuffer.toString(),
            keepNativeForFees: keepNativeForFees.toString(),
          },
          stop,
          hooks,
        });
      })();
      funding = run;
      run.catch(() => {
        if (funding === run) funding = null;
      });
    }
    return funding;
  };

  return {
    session,
    burnerAddress: burnerKey.address,
    ...holdRefundKey(session, deps.storage, args.sourceId, tradeN, refundKey),
    sourceId: args.sourceId,
    tradeN,
    runFunding,
    async readBurnerNativeOnAh() {
      const api = await assetHubApi();
      const account = await api.query.System.Account.getValue(burnerKey.address, { at: "best" });
      return account?.data?.free ?? 0n;
    },
    async exportBurnerSecret() {
      return burnerHex;
    },
    // The shared chain clients stay connected; dispose only stops this session's work.
    dispose() {
      stop.aborted = true;
      session.dispose();
    },
  };
}
