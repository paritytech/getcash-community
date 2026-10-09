// Route selection: which conversion tier a request takes. Three tiers, one decision point. The
// PSM (deliver a stable it approves, mint 1:1 minus the fee) is preferred and the AssetConversion
// pool is the fallback: fed with the native it swaps once, fed with a stable it swaps twice,
// stable to native to CASH. The dotUSD tier takes the underlying itself and moves it
// with no conversion at all. A caller that knows what the buyer will deposit names it and the tier
// follows the token; a caller that does not, the fiat rails, gets the PSM's external when the PSM
// can serve and the native otherwise. The decision is four PSM reads made once at quote time and
// then frozen into the request; the worker CONSUMES the recorded route and never decides one, so
// a job resumed from persisted state cannot take a different tier than the one the buyer was
// quoted against an asset that has already arrived.

import { TOKENS, type TokenSpec, type XcmLocation } from "@getsome/core";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { STABLE_TOKENS, isStable, type Stable } from "./stable";

type AssetHubApi = TypedApi<typeof paseo_next_v2>;
/** PSM storage is keyed by `xcm::v5::Location`, not the `u32` ids pallet-assets calls take. */
type PsmAssetId = Parameters<AssetHubApi["query"]["Psm"]["Psm"]["getValue"]>[0];

/** Headroom demanded ABOVE the amount before the PSM tier is chosen, in basis points. A margin
 *  on the amount, not on the ceiling: the amount is what moves between quote and execution.
 *  The pipeline converts everything the burner holds and both rails over-deliver (Chainflip 5%,
 *  Meld about 1% plus budget headroom), so the swap actually submitted can exceed the figure
 *  checked here by roughly this much. */
export const ROUTE_MARGIN_BPS = 1_000n;
/** The margin's absolute floor, internal units (1 CASH at 6 decimals), so the tier is never
 *  chosen when the PSM is within a hair of full however small the amount. */
export const ROUTE_MARGIN_FLOOR = 1_000_000n;
/** The margin's floor in the redeem direction, internal units (20 CASH). On a redeem the amount is
 *  fixed by the payment and does not grow; what moves between the decision and the redeem is other
 *  users' redeems draining `PsmDebt`, which is independent of our amount, so the cushion is
 *  absolute. */
export const REDEEM_MARGIN_FLOOR = 20_000_000n;

export type { Stable } from "./stable";

/** What a buyer can deposit on the burner, as a route decision takes it: the native, the
 *  underlying itself, or a stable by its token-table symbol. */
export type DepositAsset = "native" | "dotUSD" | Stable;

/** An external the PSM may swap against, by its token-table symbol. Every stable is a candidate;
 *  the PSM's own approval table, read by Location, says which it serves today. */
export type PsmExternal = Stable;

/** The external the PSM tier swaps against when nobody names a deposit. Exported so a caller that
 *  must name a deposit asset before a route exists (a provider catalog read at screen open, say)
 *  names the one the PSM tier would use rather than the fallback's. The route itself always
 *  decides; this is only for what to assume until it has. */
export const PSM_EXTERNAL = "USDT" satisfies PsmExternal;

/** The recorded decision. `feeRate` is the Permill (parts per million) the chain charged at
 *  quote time; it travels with the request so the eventual call's `max_fee` is the rate the
 *  buyer was quoted and a governance change in between fails the call instead of costing more.
 *  A pool route with an `external` is fed with that stable and swaps it through the native; one
 *  without is fed with the native. A dotUSD route is fed with the underlying itself and moves
 *  it with no conversion. */
export type ConversionRoute =
  | { tier: "psm"; external: PsmExternal; feeRate: number }
  | { tier: "pool"; external?: Stable }
  | DotUsdRoute;

/** The pool tier fed with a stable: two exchanges, stable to native to CASH, in one program. */
export type StablePoolRoute = { tier: "pool"; external: Stable };

/** The dotUSD tier: the underlying deposited as dotUSD and sent to People as it is. */
export type DotUsdRoute = { tier: "dotusd" };

export const isStablePoolRoute = (route: ConversionRoute): route is StablePoolRoute =>
  route.tier === "pool" && route.external !== undefined;

/** The token the route asks the rail to deliver to the burner. The one switch every reader of
 *  the deposit keys off: an `assetHubId` of undefined is the native's free balance, anything
 *  else a pallet-assets holding. */
export function depositTokenOf(route: ConversionRoute): TokenSpec {
  if (route.tier === "dotusd") return TOKENS.DOTUSD;
  return route.external === undefined ? TOKENS.PAS : STABLE_TOKENS[route.external];
}

/** What is asked of the PSM. `internalAmount` is in the internal asset's base units (CASH, 6
 *  decimals) for both directions: the CASH a mint must produce, or the CASH a redeem burns. The
 *  chain's `max_debt`, `min_swap_amount` and `PsmDebt` are all internal units, so an external
 *  (USDT) figure must be converted with the pair's decimals before it is passed here. */
export interface RouteQuery {
  direction: "mint" | "redeem";
  internalAmount: bigint;
  /** The asset the buyer will deposit, when the caller already knows it. The native takes the
   *  pool and the underlying the dotUSD tier, neither with a PSM read; a stable takes the PSM when
   *  it is approved and can serve, the pool fed with that stable otherwise. Absent, the fiat
   *  rails' rule: the PSM's external when the PSM can serve, the native otherwise. */
  deposit?: DepositAsset;
  /** Internal units this app's own in-flight PSM-tier withdrawals have yet to redeem, taken out
   *  of the capacity before a redeem is judged: the chain does not know of them until each one's
   *  XCM lands, but they will drain the same debt. Unused in the mint direction. */
  reserved?: bigint;
}

const POOL: ConversionRoute = { tier: "pool" };
const DOTUSD: ConversionRoute = { tier: "dotusd" };
// The table's Location type admits a value-less `Here`, which papi's key type spells
// `value: undefined`; the same plain data either way.
const asPsmAssetId = (location: XcmLocation) => location as PsmAssetId;
const INTERNAL = asPsmAssetId(TOKENS.CASH.location);
const EXTERNAL_LOCATIONS: Record<PsmExternal, PsmAssetId> = {
  USDT: asPsmAssetId(STABLE_TOKENS.USDT.location),
  USDC: asPsmAssetId(STABLE_TOKENS.USDC.location),
};

/** The amount plus the margin the tier must clear: `ROUTE_MARGIN_BPS` of it, never less than
 *  `floor`, the mint's `ROUTE_MARGIN_FLOOR` unless the caller names another. */
export function withMargin(internalAmount: bigint, floor = ROUTE_MARGIN_FLOOR): bigint {
  const margin = (internalAmount * ROUTE_MARGIN_BPS) / 10_000n;
  return internalAmount + (margin > floor ? margin : floor);
}

/** Internal units a redeem against this external may still take back: the pair's own debt,
 *  since only debt minted through the pair can be redeemed through it. */
export function readRedeemCapacity(api: AssetHubApi, external: PsmExternal): Promise<bigint> {
  return api.query.Psm.PsmDebt.getValue(INTERNAL, EXTERNAL_LOCATIONS[external]);
}

/** Internal units a mint against this external may still add: the smaller of the instance's
 *  aggregate headroom and the external's own. The per-external ceiling is a normalised share,
 *  `(weight / Σ weight over the instance's externals) × max_debt`, so a zero weight or a zero
 *  total is a zero ceiling, and adding an external shrinks every other's. */
export function mintHeadroom(input: {
  maxDebt: bigint;
  weight: bigint;
  totalWeight: bigint;
  debt: bigint;
  totalDebt: bigint;
}): bigint {
  const ceiling =
    input.totalWeight === 0n ? 0n : (input.maxDebt * input.weight) / input.totalWeight;
  const aggregate = input.maxDebt - input.totalDebt;
  const own = ceiling - input.debt;
  const headroom = aggregate < own ? aggregate : own;
  return headroom < 0n ? 0n : headroom;
}

/** The tier a request takes, decided once at quote time: the four checks of the routing rule
 *  against the live PSM, the PSM when all of them pass and the pool when any fails. */
export async function chooseRoute(api: AssetHubApi, query: RouteQuery): Promise<ConversionRoute> {
  if (query.deposit === "native") return POOL;
  if (query.deposit === "dotUSD") return DOTUSD;
  const external: PsmExternal = query.deposit ?? PSM_EXTERNAL;
  // Where the request goes when the PSM will not serve it: the pool fed with the stable the
  // buyer named, or the native when nobody named one.
  const fallback: ConversionRoute = query.deposit === undefined ? POOL : { tier: "pool", external };
  const externalLocation = EXTERNAL_LOCATIONS[external];
  const [instance, approval] = await Promise.all([
    api.query.Psm.Psm.getValue(INTERNAL),
    api.query.Psm.ExternalAssets.getValue(INTERNAL, externalLocation),
  ]);
  // 1. An instance exists for the internal asset and the external is approved on it.
  if (instance === undefined || approval === undefined) return fallback;
  // 2. The circuit breaker: minting needs the pair fully open, redemption survives a minting
  //    halt.
  const status = approval.status.type;
  const open = query.direction === "mint" ? status === "AllEnabled" : status !== "AllDisabled";
  if (!open) return fallback;

  // The fee is a ValueQuery: an absent entry decodes to the pallet default (0.5%), so the value
  // read is always the one the call will be charged.
  const fee = query.direction === "mint" ? api.query.Psm.MintingFee : api.query.Psm.RedemptionFee;
  const [weight, weights, debt, debts, feeRate] = await Promise.all([
    api.query.Psm.AssetCeilingWeight.getValue(INTERNAL, externalLocation),
    api.query.Psm.AssetCeilingWeight.getEntries(INTERNAL),
    readRedeemCapacity(api, external),
    api.query.Psm.PsmDebt.getEntries(INTERNAL),
    fee.getValue(INTERNAL, externalLocation),
  ]);
  // 3. Headroom for the amount plus the margin: what a mint may still add, or what a redeem may
  //    still take back once this app's own in-flight redeems have taken theirs.
  const reserved = query.reserved ?? 0n;
  const capacity =
    query.direction === "mint"
      ? mintHeadroom({
          maxDebt: instance.max_debt,
          weight: BigInt(weight),
          totalWeight: weights.reduce((sum, entry) => sum + BigInt(entry.value), 0n),
          debt,
          totalDebt: debts.reduce((sum, entry) => sum + entry.value, 0n),
        })
      : debt < reserved
        ? 0n
        : debt - reserved;
  const floor = query.direction === "mint" ? ROUTE_MARGIN_FLOOR : REDEEM_MARGIN_FLOOR;
  if (capacity < withMargin(query.internalAmount, floor)) return fallback;
  // 4. Not below the instance's minimum swap.
  if (query.internalAmount < instance.min_swap_amount) return fallback;
  return { tier: "psm", external, feeRate };
}

/** The route a persisted hand-off or job record carries, and the ONLY way a worker learns a
 *  job's tier: this takes no chain, so a resumed job cannot re-decide. A record from before
 *  routes were recorded is a pool one, which is what it was. A psm record missing its external
 *  or fee is refused rather than guessed, since the fee is the call's `max_fee`; so is a pool
 *  record naming a deposit asset this package does not know. */
export function recordedRoute(record: {
  tier?: unknown;
  external?: unknown;
  feeRate?: unknown;
}): ConversionRoute {
  const tier = record.tier ?? "pool";
  const { external, feeRate } = record;
  // Requests and jobs saved before the tier was renamed carry "teleport".
  if (tier === "dotusd" || tier === "teleport") return DOTUSD;
  if (tier === "pool") {
    if (external === undefined || external === null) return POOL;
    if (!isStable(external)) {
      throw new Error(`pool route with an unknown deposit asset: '${String(external)}'`);
    }
    return { tier: "pool", external };
  }
  if (tier !== "psm") throw new Error(`unknown conversion tier '${String(tier)}'`);
  if (!isStable(external)) {
    throw new Error(`psm route without a known external asset: '${String(external)}'`);
  }
  if (typeof feeRate !== "number" || !Number.isInteger(feeRate) || feeRate < 0 || feeRate > 1e6) {
    throw new Error(`psm route without a Permill fee rate: '${String(feeRate)}'`);
  }
  return { tier: "psm", external, feeRate };
}
