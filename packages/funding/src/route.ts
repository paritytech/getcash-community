// Route selection: which conversion tier a request takes. Two tiers, one decision point: the PSM
// (deliver USDT, mint 1:1 minus the fee) is the default and the AssetConversion pool (deliver
// the native, swap) is the fallback. The decision is four PSM reads made once at quote time and
// then frozen into the request; the worker CONSUMES the recorded route and never decides one, so
// a job resumed from persisted state cannot take a different tier than the one the buyer was
// quoted against an asset that has already arrived (local/psm/PLAN.md §2).

import { TOKENS, type XcmLocation } from "@getsome/core";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";

type AssetHubApi = TypedApi<typeof paseo_next_v2>;
/** PSM storage is keyed by `xcm::v5::Location`, not the `u32` ids pallet-assets calls take. */
type PsmAssetId = Parameters<AssetHubApi["query"]["Psm"]["Psm"]["getValue"]>[0];

/** Build scaffolding, NOT configuration: it is deleted, not set true, once the PSM path behind
 *  it is complete (local/psm/PLAN.md M12). The PSM is the intended route; it cannot be taken until
 *  the pipeline can execute it and the rails deliver USDT, and until then this keeps every commit
 *  in the sequence green by answering `pool` without reading the chain. Not exported from the
 *  package index: nothing outside this module chooses a tier by setting it. */
export const PSM_ROUTE_ENABLED: boolean = false;

/** Headroom demanded ABOVE the amount before the PSM tier is chosen, in basis points. A margin
 *  on the amount, not on the ceiling: the amount is what moves between quote and execution.
 *  The pipeline converts everything the burner holds and both rails over-deliver (Chainflip 5%,
 *  Meld about 1% plus budget headroom), so the swap actually submitted can exceed the figure
 *  checked here by roughly this much. */
export const ROUTE_MARGIN_BPS = 1_000n;
/** The margin's absolute floor, internal units (1 CASH at 6 decimals), so the tier is never
 *  chosen when the PSM is within a hair of full however small the amount. */
export const ROUTE_MARGIN_FLOOR = 1_000_000n;

/** An external the PSM can swap against, by its token-table symbol. */
export type PsmExternal = "USDT";

/** The recorded decision. `feeRate` is the Permill (parts per million) the chain charged at
 *  quote time; it travels with the request so the eventual call's `max_fee` is the rate the
 *  buyer was quoted and a governance change in between fails the call instead of costing more. */
export type ConversionRoute =
  { tier: "psm"; external: PsmExternal; feeRate: number } | { tier: "pool" };

/** What is asked of the PSM. `internalAmount` is in the internal asset's base units (CASH, 6
 *  decimals) for both directions: the CASH a mint must produce, or the CASH a redeem burns. The
 *  chain's `max_debt`, `min_swap_amount` and `PsmDebt` are all internal units, so an external
 *  (USDT) figure must be converted with the pair's decimals before it is passed here. */
export interface RouteQuery {
  direction: "mint" | "redeem";
  internalAmount: bigint;
}

const POOL: ConversionRoute = { tier: "pool" };
// The table's Location type admits a value-less `Here`, which papi's key type spells
// `value: undefined`; the same plain data either way.
const asPsmAssetId = (location: XcmLocation) => location as PsmAssetId;
const INTERNAL = asPsmAssetId(TOKENS.CASH.location);
const EXTERNAL_LOCATIONS: Record<PsmExternal, PsmAssetId> = {
  USDT: asPsmAssetId(TOKENS.USDT.location),
};

/** The amount plus the margin the tier must clear: `ROUTE_MARGIN_BPS` of it, never less than
 *  `ROUTE_MARGIN_FLOOR`. */
export function withMargin(internalAmount: bigint): bigint {
  const margin = (internalAmount * ROUTE_MARGIN_BPS) / 10_000n;
  return internalAmount + (margin > ROUTE_MARGIN_FLOOR ? margin : ROUTE_MARGIN_FLOOR);
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

/** The four checks of the routing rule against the live PSM, ungated. `chooseRoute` is the
 *  entry point; this is exported for its tests. */
export async function readPsmRoute(api: AssetHubApi, query: RouteQuery): Promise<ConversionRoute> {
  const external: PsmExternal = "USDT";
  const externalLocation = EXTERNAL_LOCATIONS[external];
  const [instance, approval] = await Promise.all([
    api.query.Psm.Psm.getValue(INTERNAL),
    api.query.Psm.ExternalAssets.getValue(INTERNAL, externalLocation),
  ]);
  // 1. An instance exists for the internal asset and the external is approved on it.
  if (instance === undefined || approval === undefined) return POOL;
  // 2. The circuit breaker: minting needs the pair fully open, redemption survives a minting
  //    halt.
  const status = approval.status.type;
  const open = query.direction === "mint" ? status === "AllEnabled" : status !== "AllDisabled";
  if (!open) return POOL;

  // The fee is a ValueQuery: an absent entry decodes to the pallet default (0.5%), so the value
  // read is always the one the call will be charged.
  const fee = query.direction === "mint" ? api.query.Psm.MintingFee : api.query.Psm.RedemptionFee;
  const [weight, weights, debt, debts, feeRate] = await Promise.all([
    api.query.Psm.AssetCeilingWeight.getValue(INTERNAL, externalLocation),
    api.query.Psm.AssetCeilingWeight.getEntries(INTERNAL),
    api.query.Psm.PsmDebt.getValue(INTERNAL, externalLocation),
    api.query.Psm.PsmDebt.getEntries(INTERNAL),
    fee.getValue(INTERNAL, externalLocation),
  ]);
  // 3. Headroom for the amount plus the margin: what a mint may still add, or what a redeem may
  //    still take back (only debt minted through this pair can be redeemed through it).
  const capacity =
    query.direction === "mint"
      ? mintHeadroom({
          maxDebt: instance.max_debt,
          weight: BigInt(weight),
          totalWeight: weights.reduce((sum, entry) => sum + BigInt(entry.value), 0n),
          debt,
          totalDebt: debts.reduce((sum, entry) => sum + entry.value, 0n),
        })
      : debt;
  if (capacity < withMargin(query.internalAmount)) return POOL;
  // 4. Not below the instance's minimum swap.
  if (query.internalAmount < instance.min_swap_amount) return POOL;
  return { tier: "psm", external, feeRate };
}

/** The tier a request takes, decided once at quote time. Resolves to the pool for every
 *  request while the scaffolding above is in place. */
export async function chooseRoute(api: AssetHubApi, query: RouteQuery): Promise<ConversionRoute> {
  if (!PSM_ROUTE_ENABLED) return POOL;
  return readPsmRoute(api, query);
}

/** The route a persisted hand-off or job record carries, and the ONLY way a worker learns a
 *  job's tier: this takes no chain, so a resumed job cannot re-decide. A record from before
 *  routes were recorded is a pool one, which is what it was. A psm record missing its external
 *  or fee is refused rather than guessed, since the fee is the call's `max_fee`. */
export function recordedRoute(record: {
  tier?: unknown;
  external?: unknown;
  feeRate?: unknown;
}): ConversionRoute {
  const tier = record.tier ?? "pool";
  if (tier === "pool") return POOL;
  if (tier !== "psm") throw new Error(`unknown conversion tier '${String(tier)}'`);
  const { external, feeRate } = record;
  if (typeof external !== "string" || !(external in EXTERNAL_LOCATIONS)) {
    throw new Error(`psm route without a known external asset: '${String(external)}'`);
  }
  if (typeof feeRate !== "number" || !Number.isInteger(feeRate) || feeRate < 0 || feeRate > 1e6) {
    throw new Error(`psm route without a Permill fee rate: '${String(feeRate)}'`);
  }
  return { tier: "psm", external: external as PsmExternal, feeRate };
}
