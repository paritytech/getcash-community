// Live world factory for the CASH handoff, for use inside the host. The pool leg runs in the
// product's worker; this page hands the session over and reads it back.

import {
  deriveEntropy,
  getHostLocalStorage,
  getPaymentManager,
  requestPermission,
} from "@parity/product-sdk-host";
import { getStorageWorkerManager } from "./worker-rpc";
import { createFlowStore, type ChainflipRail, type FlowState, type SourceId } from "@getsome/core";
import { deriveKeypair } from "@getsome/ephemeral";
import {
  DEFAULT_KEEP_NATIVE_FOR_FEES,
  DEFAULT_REMOTE_FEE_BUFFER,
  PASEO_PEOPLE_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  type FundingStep,
} from "@getsome/funding";
import {
  createHostEntropyPort,
  createHostStorageAdapter,
  type HostLocalStorageLike,
} from "@getsome/host";
import { CASH_DECIMALS } from "@getsome/people";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { WorkerHandoffPayload } from "../app/funding/requests/model";
import {
  createCoinageSession,
  DEFAULT_SOURCE_ID,
  hostSafeEntropy,
  nextFreeTradeNumber,
  readPurseBalance,
  readTradeCounter,
  tradeEntropyLabel,
  tradeEntropyLabelString,
  type CoinageWorld,
} from "./coinage";
import { ASSET_HUB_GENESIS, PEOPLE_GENESIS } from "./host-chain";

export interface HostedCoinageWorld extends CoinageWorld {
  /** Current host purse balance (CASH base units). */
  readPurse(): Promise<bigint>;
}

/** Fetch the host payment + storage managers, or throw a clear error outside the host. */
async function hostManagers() {
  const [payments, storage] = await Promise.all([getPaymentManager(), getHostLocalStorage()]);
  if (!payments || !storage) {
    throw new Error("host payments/storage unavailable (not running inside the Polkadot App?)");
  }
  return { payments, storage };
}

export { DEFAULT_SOURCE_ID };

/** A trade's burner address, derived from the host's entropy root without building a session. */
export async function burnerAddressFor(sourceId: string, tradeN: number): Promise<string> {
  const entropy = createHostEntropyPort(hostSafeEntropy(deriveEntropy));
  const seed = await entropy.deriveSeed(tradeEntropyLabel(sourceId, tradeN));
  return deriveKeypair(seed).address;
}

/** A trade's burner address and its native balance on Asset Hub, without building a session. */
export async function probeTradeBurner(
  sourceId: string,
  tradeN: number,
): Promise<{ address: string; free: bigint }> {
  const address = await burnerAddressFor(sourceId, tradeN);
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  const account = await api.query.System.Account.getValue(address, { at: "best" });
  return { address, free: account?.data?.free ?? 0n };
}

/** Follows a trade's burner balance on Asset Hub at each best block until the returned function
 *  is called: every emission reaches `onValue`, a failed subscription `onError`. */
export async function watchTradeBurner(
  sourceId: string,
  tradeN: number,
  onValue: (free: bigint, address: string) => void,
  onError: (e: unknown) => void,
): Promise<() => void> {
  const address = await burnerAddressFor(sourceId, tradeN);
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  const subscription = api.query.System.Account.watchValue(address, { at: "best" }).subscribe({
    next: ({ value: account }) => onValue(account?.data?.free ?? 0n, address),
    error: onError,
  });
  return () => subscription.unsubscribe();
}

/** Core's storage over the host store, under the prefix `createCoinageSession` writes with. */
async function hostStorageAdapter() {
  const { storage } = await hostManagers();
  return createHostStorageAdapter(storage as HostLocalStorageLike);
}

/** The source's trade counter in the host store: the number the next request takes. */
export async function readHostedTradeCounter(sourceId: string): Promise<number> {
  return readTradeCounter(await hostStorageAdapter(), sourceId);
}

/** A trade's core flow slot, which core keys by the burner address it pays into. */
export async function readFlowSlot(
  sourceId: SourceId,
  tradeN: number,
): Promise<{ address: string; slot: FlowState | null }> {
  const [address, storage] = await Promise.all([
    burnerAddressFor(sourceId, tradeN),
    hostStorageAdapter(),
  ]);
  return { address, slot: await createFlowStore(storage, sourceId, address).load() };
}

/** Trade `n` has left a trace the caller knows of (`extra`: a record or a worker job) or one only
 *  the host knows of: its core flow slot. */
export async function hasTradeTrace(
  sourceId: SourceId,
  n: number,
  extra: (n: number) => Promise<boolean>,
): Promise<boolean> {
  return (await extra(n)) || (await readFlowSlot(sourceId, n)).slot !== null;
}

/** The trade number the next request under `sourceId` takes: the host counter, moved past every
 *  number with a trace. */
export async function nextHostedTradeNumber(
  sourceId: SourceId,
  extra: (n: number) => Promise<boolean>,
): Promise<number> {
  return nextFreeTradeNumber(await hostStorageAdapter(), sourceId, (n) =>
    hasTradeTrace(sourceId, n, extra),
  );
}

/** The hand-off for a request whose record was lost, rebuilt from its flow slot with the sizing
 *  defaults the worker itself falls back to. */
export function lostRequestHandoff(
  sourceId: string,
  tradeN: number,
  address: string,
  slot: FlowState,
): WorkerHandoffPayload {
  return {
    label: tradeEntropyLabelString(sourceId, tradeN),
    burnerAddress: address,
    depositExpiresAt: slot.depositExpiresAt ?? 0,
    settleAmount: slot.handoffAmount ?? "0",
    underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
    peopleParaId: PASEO_PEOPLE_PARA_ID,
    assetHubGenesis: ASSET_HUB_GENESIS,
    peopleGenesis: PEOPLE_GENESIS,
    remoteFeeBuffer: DEFAULT_REMOTE_FEE_BUFFER.toString(),
    keepNativeForFees: DEFAULT_KEEP_NATIVE_FOR_FEES.toString(),
    tier: "pool",
  };
}

/** Human CASH amount to 6-decimal base units. */
function toCashBase(human: string): bigint {
  const [whole = "0", frac = ""] = human.trim().split(".");
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac)) || frac.length > CASH_DECIMALS) {
    throw new Error(`not a CASH amount: '${human}' (max ${CASH_DECIMALS} decimals)`);
  }
  return BigInt(whole) * 10n ** BigInt(CASH_DECIMALS) + BigInt(frac.padEnd(CASH_DECIMALS, "0"));
}

/** The pool-funded session over the real host seams; budget sized live from the pool. */
export async function createHostedCoinageWorld(args: {
  /** CASH base units (6 decimals). */
  amount: bigint;
  /** Which request's burner to derive; omit for a new one (see CoinageSessionArgs.tradeN). */
  tradeN?: number;
  /** Fiat rail and its source id, when the fiat route drives this run. */
  rail?: ChainflipRail;
  sourceId?: SourceId;
  /** Core's stale bound for the flow slot (see CoinageSessionArgs.staleFlowMs). */
  staleFlowMs?: number;
  /** Settle-internal claim progress (see createCoinageHandoff.onProgress). */
  onClaimProgress?: (stage: "prompted" | "crediting", claimed?: bigint) => void;
}): Promise<HostedCoinageWorld> {
  const { payments, storage } = await hostManagers();
  const world = await createCoinageSession({
    amount: args.amount,
    sourceId: args.sourceId ?? DEFAULT_SOURCE_ID,
    ...(args.rail ? { rail: args.rail } : {}),
    ...(args.tradeN === undefined ? {} : { tradeN: args.tradeN }),
    ...(args.staleFlowMs === undefined ? {} : { staleFlowMs: args.staleFlowMs }),
    hostLocalStorage: storage,
    deriveEntropy,
    // The storage-backed manager stands in for the SDK's getWorkerManager(); one per page.
    worker: getStorageWorkerManager(),
    onClaimProgress: args.onClaimProgress,
  });
  const runFunding: typeof world.runFunding = async (hooks) => {
    await ensureChainSubmitGrant();
    return world.runFunding(hooks);
  };
  return { ...world, runFunding, readPurse: () => readPurseBalance(payments) };
}

// Requests the ChainSubmit permission once before the hand-off. A denial is logged, not fatal.
let chainSubmitGranted: Promise<void> | null = null;
export function ensureChainSubmitGrant(): Promise<void> {
  chainSubmitGranted ??= (async () => {
    try {
      const r = await requestPermission({ tag: "ChainSubmit", value: undefined });
      console.info("[coinage] ChainSubmit grant:", r.ok ? "granted" : r.error?.message);
    } catch (e) {
      console.warn("[coinage] ChainSubmit request failed (continuing):", e);
    }
  })();
  return chainSubmitGranted;
}

/**
 * One-call live run from the host's console. Session states and funding steps land in the console.
 */
export async function startLiveCoinage(args: {
  /** CASH to claim, human units, e.g. "5" or "0.25". */
  amountCash: string;
}): Promise<HostedCoinageWorld> {
  const world = await createHostedCoinageWorld({ amount: toCashBase(args.amountCash) });

  world.session.subscribe((s) => {
    console.info(`[coinage] phase=${s.phase}`, s);
    if (s.phase === "awaiting-deposit") {
      console.info(
        `[coinage] send exactly ${s.deposit.formatted} ${s.deposit.assetSymbol} (native) to ${s.deposit.address} on Asset Hub`,
      );
    }
  });

  await world.session.ready;
  const quote = await world.session.quote();
  console.info(
    `[coinage] quoted native budget: ${quote.source.formatted} ${quote.source.assetSymbol}`,
  );
  const { refundAddress } = world;
  await world.session.start(refundAddress === null ? {} : { refundAddress });
  void world.runFunding({
    onStep: (step: FundingStep) => console.info(`[coinage] funding step: ${step}`),
    onTransientError: (e) => console.warn("[coinage] funding transient:", e),
  });
  return world;
}
