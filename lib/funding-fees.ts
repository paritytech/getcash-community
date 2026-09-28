// Sizes the fee allowances the deposit must carry, priced live from both chains with no funds and
// no stand-in account. Every figure is a runtime read against our own message. The two tiers'
// costs differ in composition, not just in value, so each has its
// own shape. On the pool tier, keepNativeForFees is the native the deposit carries on top of the
// pool quote for the program's own costs on Asset Hub, and any failure returns null so the caller
// keeps the funding package's static fallbacks. On the PSM tier the batch's dispatch fee and the
// XCM's own fees are both charged in the external, the latter from an allowance a tenth over the
// estimate that stays out of the mint with the external's min_balance and is refunded to the
// burner where unspent, and the PSM takes its fee on the mint; there is no static fallback,
// because the tier is only chosen once the chain has answered. remoteFeeBuffer is the same on
// both: the extra underlying to over-buy for the destination's execution fee, read from a dry run
// of the forwarded program on People, with the same tenth on top.

import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import type { PolkadotClient } from "polkadot-api";
import {
  DEFAULT_KEEP_NATIVE_FOR_FEES,
  DEFAULT_LP_FEE_PPM,
  DEFAULT_REMOTE_FEE_BUFFER,
  DEFAULT_SLIPPAGE_PCT,
  destinationEarmark,
  discoverPool,
  estimateDestinationFeeCash,
  estimateFundingProgramFees,
  estimatePsmBatchFees,
  EXTERNAL_POOL_FLOOR_PCT,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  psmDepositNeeded,
  quoteNativeInMax,
  sizePsmMint,
  slippageFor,
  type Exposure,
  type OrientedReserves,
  type PsmExternal,
  type PsmRoute,
  type Pool,
} from "@getsome/funding";

/** The pool tier's costs. */
export interface PoolFundingSizing {
  tier: "pool";
  /** Extra underlying to over-buy for the destination's execution fee. */
  remoteFeeBuffer: bigint;
  /** Native the deposit carries for the program's dispatch fee and fee allowance. */
  keepNativeForFees: bigint;
  /** Headroom the deposit is asked above the live pool quote, in percent, from the pool and the
   *  rail (see headroomFor). `DEFAULT_SLIPPAGE_PCT` only when the pool could not be read. */
  slippagePct: number;
  /**
   * The pool cannot carry this purchase within the cap. A fresh hosted quote is refused on it
   * before the buyer pays; a re-opened request carries on, since its deposit may already be on the
   * burner. False when the pool could not be read.
   */
  poolUnavailable: boolean;
}

/** How long a source's deposit takes to arrive after the quote: minutes for crypto, hours for
 *  a card, up to days for a bank transfer. */
export function exposureForSource(sourceId: string): Exposure {
  if (sourceId === "meld-bank") return "days";
  if (sourceId === "meld-card") return "hours";
  // Chainflip's crypto rails and the direct native deposit both settle in minutes.
  return "minutes";
}

/**
 * A typical purchase, in CASH base units. The flow to survive is a multiple of this and not of our
 * own purchase, since other buyers do not trade more because we did; otherwise a large purchase
 * would ask for headroom against traffic that does not exist.
 */
export const TYPICAL_PURCHASE_CASH = 100_000_000n;

/**
 * The deposit headroom for this pool, purchase and rail, from `slippageFor`: counted flow for the
 * rail's window, the market move over it, and one dispatch fee, since a rejected program still
 * pays it out of the deposit. Never below EXTERNAL_POOL_FLOOR_PCT. Too little cannot be fixed later
 * (the buyer already sent a fixed amount); too much only buys the buyer more CASH. `unavailable`
 * means the pool cannot carry the purchase within MAX_SLIPPAGE_PCT.
 */
export function headroomFor(input: {
  reserves: OrientedReserves;
  buyTarget: bigint;
  exposure: Exposure;
  feePpm: bigint;
  referenceTrade?: bigint;
  /** The funding program's dispatch fee, in the native: what one rejected submit burns. */
  dispatchNative?: bigint;
}): { pct: number; unavailable: boolean } {
  // The dispatch fee converted to CASH at the pool's price.
  const dispatchCash =
    input.dispatchNative === undefined || input.reserves.in <= 0n
      ? 0n
      : (input.dispatchNative * input.reserves.out) / input.reserves.in;
  const decision = slippageFor({
    reserves: input.reserves,
    tradeOut: input.buyTarget,
    exposure: input.exposure,
    feePpm: input.feePpm,
    referenceTrade: input.referenceTrade ?? TYPICAL_PURCHASE_CASH,
    // One ordinary purchase landing first is always covered, whatever the policy says.
    competingTrade: TYPICAL_PURCHASE_CASH,
    ...(dispatchCash > 0n ? { feeTakenFromTrade: dispatchCash } : {}),
    floorPct: EXTERNAL_POOL_FLOOR_PCT,
  });
  return { pct: decision.pct, unavailable: decision.cappedOut };
}

/**
 * The pool route cannot carry this purchase within MAX_SLIPPAGE_PCT. Thrown for a fresh hosted
 * quote before the deposit is asked for, so the buyer does not pay into a request that would only
 * wait and expire. The message is shown on the quote screen.
 */
export class PoolRouteUnavailableError extends Error {
  constructor(readonly settleAmount: bigint) {
    // No "smaller" or "larger": which amount works depends on why the request is on the pool tier.
    super(
      "There is not enough liquidity to top up this amount this way right now. " +
        "Try another amount or payment method.",
    );
    this.name = "PoolRouteUnavailableError";
  }
}

/** The pool's two reserves, in the order asked for, or null when the runtime will not answer. */
async function readReserves(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  a: unknown,
  b: unknown,
): Promise<[bigint, bigint] | null> {
  try {
    const out = await api.view.AssetConversion.get_reserves(a, b);
    const pair = (out as { value?: unknown })?.value ?? out;
    if (!Array.isArray(pair) || pair.length < 2) return null;
    return [BigInt(pair[0] as never), BigInt(pair[1] as never)];
  } catch {
    // An older runtime without the view function: the caller uses its fallback.
    return null;
  }
}

/** The PSM tier's costs. */
export interface PsmFundingSizing {
  tier: "psm";
  /** Extra underlying to over-buy for the destination's execution fee. */
  remoteFeeBuffer: bigint;
  /** The external the burner holds and the batch's dispatch fee is charged in. */
  external: PsmExternal;
  /** The dispatch fee, in the external, kept out of the mint. */
  dispatchExternal: bigint;
  /** Also kept out of the mint, in the external: the asset's min_balance, which the burner's
   *  account must hold to survive the batch and which stays on it, plus `feeAllowanceExternal`. */
  heldBackExternal: bigint;
  /** The allowance for the XCM's local execution and delivery, in the external: what the one
   *  cushion over the fees leaves after the dispatch fee, the unspent part refunded to the burner
   *  on Asset Hub. */
  feeAllowanceExternal: bigint;
  /** The PSM's fee on the mint, Permill, as the route recorded it. */
  feeRate: number;
  /** What the buyer is asked to deposit: the mint's input, the min_balance, and the cushioned
   *  fees. The worker's gate checks for this figure rather than re-pricing it. */
  quotedDeposit: bigint;
}

export type FundingSizing = PoolFundingSizing | PsmFundingSizing;

/** A throwaway 32-byte beneficiary for the fee reads; it does not affect any fee. */
const ZERO_32 = `0x${"00".repeat(32)}`;

interface SizingArgs {
  ahClient: PolkadotClient;
  peopleClient: PolkadotClient;
  underlyingAssetId: number;
  peopleParaId: number;
  settleAmount: bigint;
  /** Any valid address; getEstimatedFees does not depend on the signer or its balance. */
  probeAddress: string;
}

/** The chains' typed apis, the pool and the destination's execution fee: what both tiers' sizing
 *  starts from. The pool is on the fee path on both tiers. */
async function sizingReads(args: SizingArgs) {
  const api = args.ahClient.getTypedApi(paseo_next_v2);
  const peopleApi = args.peopleClient.getTypedApi(paseo_people_next);
  const pool: Pool = await discoverPool(api, args.underlyingAssetId);
  const destinationFee = await estimateDestinationFeeCash({
    peopleApi,
    pool,
    assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
    beneficiaryHex: ZERO_32,
    amount: args.settleAmount,
  });
  return { api, pool, destinationFee };
}

/** The pool tier's sizing. */
export async function estimateFundingSizing(
  args: SizingArgs & {
    /** The rail's delivery window; defaults to the longest, which is the safest assumption. */
    exposure?: Exposure;
  },
): Promise<PoolFundingSizing | null> {
  try {
    const { api, pool, destinationFee } = await sizingReads(args);

    const buyTarget = args.settleAmount + destinationFee;

    // The fees first, because one dispatch fee is part of the headroom. The probe carries a deposit
    // at the default headroom, close enough to encode to the same length as the real one. If the
    // probe fails, the static allowance stands in for both, which errs wide.
    const fees = await quoteNativeInMax(api, pool, buyTarget, DEFAULT_SLIPPAGE_PCT)
      .then((probeNative) =>
        estimateFundingProgramFees({
          api,
          pool,
          beneficiaryHex: ZERO_32,
          peopleParaId: args.peopleParaId,
          nativeBalance: probeNative,
          minUnderlyingOut: buyTarget,
          remoteFeesCash: destinationEarmark(buyTarget, destinationFee),
          feeProbeAddress: args.probeAddress,
        }),
      )
      .then((f) => ({ keep: f.payFeesNative + f.dispatchNative, dispatch: f.dispatchNative }))
      .catch((e: unknown) => {
        console.warn("[coinage] funding fee probe failed; using the static allowance:", e);
        return { keep: DEFAULT_KEEP_NATIVE_FOR_FEES, dispatch: DEFAULT_KEEP_NATIVE_FOR_FEES };
      });

    // Reserves and LP fee from the chain; an unreadable pool falls back to the default headroom.
    const [reserves, feePpm] = await Promise.all([
      readReserves(api, pool.native, pool.underlying),
      // LPFee is a parts-per-million integer; the module takes it as a bigint.
      api.constants.AssetConversion.LPFee()
        .then((ppm) => BigInt(ppm))
        .catch(() => undefined),
    ]);
    const headroom =
      reserves === null
        ? { pct: DEFAULT_SLIPPAGE_PCT, unavailable: false }
        : headroomFor({
            reserves: { in: reserves[0], out: reserves[1] },
            buyTarget,
            exposure: args.exposure ?? "days",
            feePpm: feePpm ?? DEFAULT_LP_FEE_PPM,
            dispatchNative: fees.dispatch,
          });
    if (headroom.unavailable) {
      console.warn(
        "[coinage] the Asset Hub pool cannot carry this purchase within the slippage cap; " +
          "the pool route is unavailable for it",
      );
    }

    return {
      tier: "pool",
      remoteFeeBuffer: destinationFee,
      keepNativeForFees: fees.keep,
      slippagePct: headroom.pct,
      poolUnavailable: headroom.unavailable,
    };
  } catch (e) {
    console.warn("[coinage] funding sizing estimate failed; using static fallbacks:", e);
    return null;
  }
}

/** The PSM tier's sizing: the batch's own fees, measured against the batch that mints the settle
 *  amount plus the destination fee. Throws when a read fails; the pipeline has no static figures
 *  for this tier either (`DEFAULT_KEEP_NATIVE_FOR_FEES`). */
export async function estimatePsmFundingSizing(
  args: SizingArgs & { route: PsmRoute },
): Promise<PsmFundingSizing> {
  const { api, destinationFee } = await sizingReads(args);
  const buyTarget = args.settleAmount + destinationFee;
  // At the magnitude the batch will carry, as the pool tier's probes do; the few cents the fees
  // add on top do not change the encoded lengths.
  const fees = await estimatePsmBatchFees({
    api,
    route: args.route,
    beneficiaryHex: ZERO_32,
    peopleParaId: args.peopleParaId,
    depositExternal: sizePsmMint(buyTarget, args.route).externalIn,
    remoteFeesCash: destinationEarmark(buyTarget, destinationFee),
    feeProbeAddress: args.probeAddress,
  });
  return {
    tier: "psm",
    remoteFeeBuffer: destinationFee,
    external: args.route.external,
    dispatchExternal: fees.dispatchExternal,
    heldBackExternal: fees.heldBackExternal,
    feeAllowanceExternal: fees.feeAllowanceExternal,
    feeRate: args.route.feeRate,
    quotedDeposit: psmDepositNeeded(buyTarget, args.route, fees),
  };
}

/** The funding package's static sizing, as the pool tier's callers fall back to it. */
export const FALLBACK_FUNDING_SIZING: PoolFundingSizing = {
  tier: "pool",
  remoteFeeBuffer: DEFAULT_REMOTE_FEE_BUFFER,
  keepNativeForFees: DEFAULT_KEEP_NATIVE_FOR_FEES,
  slippagePct: DEFAULT_SLIPPAGE_PCT,
  // Nothing was read, so nothing is known to be over capacity.
  poolUnavailable: false,
};

/**
 * The pool tier's sizing over the shared public clients, on the chain ids this deployment funds
 * against.
 *
 * The mock quote paths' single entry point: those price the pool tier, the only one the mock world
 * takes. It never rejects and never returns null, so a caller that only needs figures to price
 * with can use the result directly. An unreachable chain leaves the static fallbacks, the same
 * ones the worker itself falls back to.
 */
export async function estimatePublicFundingSizing(args: {
  settleAmount: bigint;
  probeAddress: string;
  exposure?: Exposure;
}): Promise<PoolFundingSizing> {
  try {
    const { connectChain, ASSET_HUB, PEOPLE } = await import("./host-chain");
    const [ahClient, peopleClient] = await Promise.all([
      connectChain(ASSET_HUB),
      connectChain(PEOPLE),
    ]);
    return (
      (await estimateFundingSizing({
        ahClient,
        peopleClient,
        underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
        peopleParaId: PASEO_PEOPLE_PARA_ID,
        settleAmount: args.settleAmount,
        probeAddress: args.probeAddress,
        ...(args.exposure === undefined ? {} : { exposure: args.exposure }),
      })) ?? FALLBACK_FUNDING_SIZING
    );
  } catch (e) {
    console.warn("[coinage] funding sizing unreachable; using static fallbacks:", e);
    return FALLBACK_FUNDING_SIZING;
  }
}
