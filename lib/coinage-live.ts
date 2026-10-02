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
import { deriveKeypair, type RefundKey } from "@getsome/ephemeral";
import {
  chooseRoute,
  type ConversionRoute,
  DEFAULT_KEEP_NATIVE_FOR_FEES,
  DEFAULT_REMOTE_FEE_BUFFER,
  depositTokenOf,
  isStablePoolRoute,
  PASEO_PEOPLE_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  recordedRoute,
  type DepositAsset,
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
  burnerSecretOf,
  createCoinageSession,
  DEFAULT_SOURCE_ID,
  handoffFees,
  hostSafeEntropy,
  nextFreeTradeNumber,
  readDepositOnAh,
  readPurseBalance,
  readTradeCounter,
  recoverRefundKey,
  stage,
  tradeEntropyLabel,
  tradeEntropyLabelString,
  watchDepositOnAh,
  watchDirectDepositOnAh,
  type CoinageWorld,
  type DirectDepositReading,
} from "./coinage";
import { ASSET_HUB, ASSET_HUB_GENESIS, connectChain, PEOPLE, PEOPLE_GENESIS } from "./host-chain";
import type { FundingSizing } from "./funding-fees";

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
  return deriveKeypair(await burnerSeedFor(sourceId, tradeN)).address;
}

/** A trade's burner secret as the live world exports it, for a request reopened without one. */
export async function probeBurnerSecret(sourceId: string, tradeN: number): Promise<string> {
  return burnerSecretOf(await burnerSeedFor(sourceId, tradeN));
}

function burnerSeedFor(sourceId: string, tradeN: number): Promise<Uint8Array> {
  const entropy = createHostEntropyPort(hostSafeEntropy(deriveEntropy));
  return entropy.deriveSeed(tradeEntropyLabel(sourceId, tradeN));
}

/** A trade's burner address and its balance on Asset Hub in the asset the trade's recorded route
 *  delivers, without building a session. */
export async function probeTradeBurner(
  sourceId: string,
  tradeN: number,
  route: ConversionRoute,
): Promise<{ address: string; free: bigint }> {
  const address = await burnerAddressFor(sourceId, tradeN);
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  return { address, free: await readDepositOnAh(api, route, address) };
}

/**
 * A refunded request's recovery key, from the record's own fields. No session, no network.
 *
 * The host derives the seed, exactly as it did when the request was opened, so this returns the
 * same key the rail was given — which is why a refund can be recovered long after the world that
 * created it is gone. Null off-host, where there is no entropy root to ask.
 */
export async function probeRefundKey(
  sourceId: SourceId,
  tradeN: number,
): Promise<RefundKey | null> {
  const entropy = createHostEntropyPort(hostSafeEntropy(deriveEntropy));
  return recoverRefundKey(entropy, sourceId, tradeN);
}

/** Follows a trade's burner balance in its route's deposit asset on Asset Hub at each best block
 *  until the returned function is called: every emission reaches `onValue`, a failed
 *  subscription `onError`. */
export async function watchTradeBurner(
  sourceId: string,
  tradeN: number,
  route: ConversionRoute,
  onValue: (free: bigint, address: string) => void,
  onError: (e: unknown) => void,
): Promise<() => void> {
  const { api, address } = await burnerOnAssetHub(sourceId, tradeN);
  return watchDepositOnAh(api, route, address, (free) => onValue(free, address), onError);
}

/** `watchTradeBurner` for a Polkadot deposit: the route's own token and the first other direct
 *  token found, at each best block. */
export async function watchDirectTradeBurner(
  sourceId: string,
  tradeN: number,
  route: ConversionRoute,
  onValue: (reading: DirectDepositReading) => void,
  onError: (e: unknown) => void,
): Promise<() => void> {
  const { api, address } = await burnerOnAssetHub(sourceId, tradeN);
  return watchDirectDepositOnAh(api, route, address, onValue, onError);
}

async function burnerOnAssetHub(sourceId: string, tradeN: number) {
  const address = await burnerAddressFor(sourceId, tradeN);
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  return { address, api: (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2) };
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

/** The hand-off for a request whose record was lost, rebuilt from its flow slot. The tier is the
 *  one the slot froze at quote time and nothing else, so a lost request cannot be recovered on a
 *  tier other than the one its deposit was quoted for; a slot from before routes were recorded
 *  is a pool one. The fee figures are sized live for that tier, as a fresh hand-off's are, and
 *  the worker's own defaults stand in when the reads fail. */
export async function lostRequestHandoff(
  sourceId: string,
  tradeN: number,
  address: string,
  slot: FlowState,
): Promise<WorkerHandoffPayload> {
  const route = recordedRoute(slot.conversion ?? {});
  const settleAmount = BigInt(slot.handoffAmount ?? "0");
  return {
    label: tradeEntropyLabelString(sourceId, tradeN),
    burnerAddress: address,
    depositExpiresAt: slot.depositExpiresAt ?? 0,
    settleAmount: settleAmount.toString(),
    underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
    peopleParaId: PASEO_PEOPLE_PARA_ID,
    assetHubGenesis: ASSET_HUB_GENESIS,
    peopleGenesis: PEOPLE_GENESIS,
    ...(await lostRequestFees(sourceId, tradeN, address, route, settleAmount)),
    ...route,
  };
}

/** The fee figures of a lost request's hand-off: the tier's live sizing for its settle amount,
 *  probed from the burner itself, which gives the worker the frozen gate a fresh hand-off
 *  carries. The defaults the worker falls back to stand in when there is nothing to size or a
 *  read fails. */
async function lostRequestFees(
  sourceId: string,
  tradeN: number,
  address: string,
  route: ConversionRoute,
  settleAmount: bigint,
): Promise<Pick<WorkerHandoffPayload, "remoteFeeBuffer" | "keepNativeForFees" | "quotedDeposit">> {
  const defaults = {
    remoteFeeBuffer: DEFAULT_REMOTE_FEE_BUFFER.toString(),
    // Only a native deposit carries fee native; the other tiers price their fees live.
    keepNativeForFees: (depositTokenOf(route).assetHubId === undefined
      ? DEFAULT_KEEP_NATIVE_FOR_FEES
      : 0n
    ).toString(),
  };
  if (settleAmount <= 0n) return defaults;
  try {
    const fees = await import("./funding-fees");
    const args = {
      ahClient: await connectChain(ASSET_HUB),
      peopleClient: await connectChain(PEOPLE),
      underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
      peopleParaId: PASEO_PEOPLE_PARA_ID,
      settleAmount,
      probeAddress: address,
    };
    const sizing = await stage<FundingSizing | null>(
      `lost request ${sourceId}#${tradeN} sizing`,
      20_000,
      route.tier === "psm"
        ? fees.estimatePsmFundingSizing({ ...args, route })
        : isStablePoolRoute(route)
          ? fees.estimateStableFundingSizing({ ...args, route })
          : route.tier === "teleport"
            ? fees.estimateTeleportFundingSizing(args)
            : fees.estimateFundingSizing({ ...args, exposure: fees.exposureForSource(sourceId) }),
    );
    return sizing === null ? defaults : handoffFees(sizing);
  } catch (e) {
    console.warn(
      `[coinage] lost request ${sourceId}#${tradeN}: sizing failed, the defaults stand in:`,
      e,
    );
    return defaults;
  }
}

/** Human CASH amount to 6-decimal base units. */
function toCashBase(human: string): bigint {
  const [whole = "0", frac = ""] = human.trim().split(".");
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac)) || frac.length > CASH_DECIMALS) {
    throw new Error(`not a CASH amount: '${human}' (max ${CASH_DECIMALS} decimals)`);
  }
  return BigInt(whole) * 10n ** BigInt(CASH_DECIMALS) + BigInt(frac.padEnd(CASH_DECIMALS, "0"));
}

/** The conversion tier a hosted request takes, read off the live PSM. The one place the
 *  decision is made for a hosted request: it runs before the rail is built, since the tier
 *  fixes the asset the rail delivers, and the world it is handed to freezes it into the
 *  hand-off. `deposit` names the asset the buyer will send when the picker already knows it;
 *  absent, the fiat rails' rule applies. */
export async function chooseHostedRoute(
  amount: bigint,
  deposit?: DepositAsset,
): Promise<ConversionRoute> {
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  return chooseRoute(api, {
    direction: "mint",
    internalAmount: amount,
    ...(deposit === undefined ? {} : { deposit }),
  });
}

/** The funded session over the real host seams; budget sized live for the route's tier. */
export async function createHostedCoinageWorld(args: {
  /** CASH base units (6 decimals). */
  amount: bigint;
  /** The tier already decided for this request (see createCoinageSession.route). */
  route: ConversionRoute;
  /** Which request's burner to derive; omit for a new one (see CoinageSessionArgs.tradeN). */
  tradeN?: number;
  /** Fiat rail and its source id, when the fiat route drives this run. */
  rail?: ChainflipRail;
  sourceId?: SourceId;
  /** Core's stale bound for the flow slot (see CoinageSessionArgs.staleFlowMs). */
  staleFlowMs?: number;
  /** A fresh quote: refuse a pool too thin to carry it (see CoinageSessionArgs). */
  refuseUnavailablePool?: boolean;
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
    ...(args.refuseUnavailablePool ? { refuseUnavailablePool: true } : {}),
    route: args.route,
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
  const amount = toCashBase(args.amountCash);
  const world = await createHostedCoinageWorld({
    amount,
    route: await chooseHostedRoute(amount),
    refuseUnavailablePool: true,
  });

  world.session.subscribe((s) => {
    console.info(`[coinage] phase=${s.phase}`, s);
    if (s.phase === "awaiting-deposit") {
      console.info(
        `[coinage] send exactly ${s.deposit.formatted} ${s.deposit.assetSymbol} to ${s.deposit.address} on Asset Hub`,
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
