// Live world factory for the CASH handoff, for use inside the host. The pool leg runs in the
// product's worker; this page hands the session over and reads it back.

import {
  deriveEntropy,
  getHostLocalStorage,
  getPaymentManager,
  requestPermission,
} from "@parity/product-sdk-host";
import { getStorageWorkerManager } from "./worker-rpc";
import type { ChainflipRail, SourceId } from "@getsome/core";
import { deriveKeypair } from "@getsome/ephemeral";
import type { FundingStep } from "@getsome/funding";
import { createHostEntropyPort } from "@getsome/host";
import { CASH_DECIMALS } from "@getsome/people";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import {
  createCoinageSession,
  DEFAULT_SOURCE_ID,
  hostSafeEntropy,
  readPurseBalance,
  tradeEntropyLabel,
  type CoinageWorld,
} from "./coinage";

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

/** A trade's burner address and its native balance on Asset Hub, without building a session. */
export async function probeTradeBurner(
  sourceId: string,
  tradeN: number,
): Promise<{ address: string; free: bigint }> {
  const entropy = createHostEntropyPort(hostSafeEntropy(deriveEntropy));
  const seed = await entropy.deriveSeed(tradeEntropyLabel(sourceId, tradeN));
  const address = deriveKeypair(seed).address;
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  const account = await api.query.System.Account.getValue(address, { at: "best" });
  return { address, free: account?.data?.free ?? 0n };
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
  /** Settle-internal claim progress (see createCoinageHandoff.onProgress). */
  onClaimProgress?: (stage: "prompted" | "crediting", claimed?: bigint) => void;
}): Promise<HostedCoinageWorld> {
  const { payments, storage } = await hostManagers();
  const world = await createCoinageSession({
    amount: args.amount,
    sourceId: args.sourceId ?? DEFAULT_SOURCE_ID,
    ...(args.rail ? { rail: args.rail } : {}),
    ...(args.tradeN === undefined ? {} : { tradeN: args.tradeN }),
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
function ensureChainSubmitGrant(): Promise<void> {
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
