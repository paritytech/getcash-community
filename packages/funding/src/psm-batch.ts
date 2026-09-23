// The PSM tier's funding call: one Utility.batch_all that mints CASH from the burner's USDT
// through the PSM and teleports it to the burner's People address, with its sizing, its fee
// estimate and its dry run. Nothing calls it yet; the pipeline learns to (local/psm/PLAN.md M7).
//
// A batch of two calls rather than one XCM with a Transact: no XCM instruction swaps through the
// PSM (ExchangeAsset resolves to the pool), and a batch says what it means where a Transact
// buries a dispatch inside a program and depends on ExpectTransactStatus to fail with it. The
// mint completes before the XCM runs, so the XCM withdraws and pays its fees in CASH directly.
//
// Fees (PLAN §4.2). The burner holds only USDT when the batch is dispatched, so the dispatch fee
// is charged in USDT through ChargeAssetTxPayment, which prices it in the USDT/PAS pool. The XCM's
// own fees are paid in the CASH the mint produced, priced in the CASH/PAS pool. The destination
// fee is the CASH earmark the pool tier uses, unchanged.
//
// Atomicity (PLAN §4.3). batch_all reverts the mint when the XCM returns an error, but an XCM
// that completes while trapping assets or landing short returns Ok. The dry run of the whole batch
// before the submit refuses those, so the two together give all-or-nothing.

import { TOKENS, type TokenSpec, type XcmLocation } from "@getsome/core";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import {
  buildPsmFundingProgram,
  dryRunFundingProgram,
  extractFungibleAmount,
  forwardedProgramStandIn,
  peopleDest,
  realForwardedProgram,
  type PeopleApi,
} from "./funding-program";
import type { ConversionRoute, PsmExternal } from "./route";

type AssetHubApi = TypedApi<typeof paseo_next_v2>;
type Weight = { ref_time: bigint; proof_size: bigint };
/** PSM calls and the fee-asset option take `xcm::v5::Location`, as the route's reads do. */
type Location = Parameters<AssetHubApi["tx"]["Psm"]["mint"]>[0]["internal_asset"];
/** The recorded route on the PSM tier: the external the burner holds and the Permill fee rate
 *  the buyer was quoted, which the call carries verbatim as `max_fee`. */
export type PsmRoute = Extract<ConversionRoute, { tier: "psm" }>;

/** Parts in a Permill. */
export const PERMILL = 1_000_000n;

const INTERNAL = TOKENS.CASH;
const EXTERNAL_TOKENS: Record<PsmExternal, TokenSpec> = { USDT: TOKENS.USDT };
// The table's Location type admits a value-less `Here`, which papi's type spells
// `value: undefined`; the same plain data either way.
const asLocation = (location: XcmLocation) => location as Location;

/** `Permill::mul_ceil(amount)` as the pallet computes the fee: the product rounded up. */
export function permillMulCeil(amount: bigint, rate: number): bigint {
  const parts = BigInt(rate);
  return (amount * parts + PERMILL - 1n) / PERMILL;
}

/** The CASH a mint pays out for `cashIn` CASH worth of the external: the amount minus the fee
 *  the pallet takes on it. */
export function psmMintOut(cashIn: bigint, feeRate: number): bigint {
  return cashIn - permillMulCeil(cashIn, feeRate);
}

/** `amount` of `from` in `to`'s base units. Rounds up, so a figure that must be reached is. */
function scaleUnits(amount: bigint, from: TokenSpec, to: TokenSpec): bigint {
  const shift = to.decimals - from.decimals;
  if (shift >= 0) return amount * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return (amount + divisor - 1n) / divisor;
}

/** The mint that pays out at least `cashOut`: the smallest external amount `A` with
 *  `A - ceil(feeRate × A) >= cashOut`, which is `ceil(cashOut / (1 - feeRate))` exactly, since
 *  `ceil(x) <= n` for an integer `n` is `x <= n`. No headroom: the PSM's rate is fixed, so this
 *  does not drift between quote and execution. `cashMinted` is what that mint pays out, at least
 *  `cashOut`. */
export function sizePsmMint(
  cashOut: bigint,
  route: PsmRoute,
): { externalIn: bigint; cashMinted: bigint } {
  const external = EXTERNAL_TOKENS[route.external];
  const keep = PERMILL - BigInt(route.feeRate);
  if (keep <= 0n) throw new Error(`psm sizing: a fee of ${route.feeRate} parts keeps nothing`);
  const cashIn = (cashOut * PERMILL + keep - 1n) / keep;
  const externalIn = scaleUnits(cashIn, INTERNAL, external);
  return {
    externalIn,
    cashMinted: psmMintOut(scaleUnits(externalIn, external, INTERNAL), route.feeRate),
  };
}

/** The signing options for the batch: the dispatch fee charged in the external, the one asset
 *  the burner holds. The same options price the dispatch fee below. */
export function psmBatchTxOptions(external: PsmExternal): { asset: Location } {
  return { asset: asLocation(EXTERNAL_TOKENS[external].location) };
}

export interface PsmBatchArgs {
  route: PsmRoute;
  /** The external the mint consumes, in its base units. */
  externalIn: bigint;
  /** The CASH the mint pays out, withdrawn whole into the holding. */
  cashMinted: bigint;
  /** Local execution plus delivery, in CASH. */
  payFeesCash: bigint;
  /** Destination fee allowance in CASH. */
  remoteFeesCash: bigint;
  beneficiaryHex: string;
  peopleParaId: number;
  /** The declared weight ceiling of the execute. Defaults to FUNDING_PROGRAM_MAX_WEIGHT. */
  maxWeight?: Weight;
}

/** `Utility.batch_all([Psm.mint, PolkadotXcm.execute])`, in that order, and the execute's
 *  arguments for describing a rejection. */
export function buildPsmBatch(api: AssetHubApi, args: PsmBatchArgs) {
  const execArgs = buildPsmFundingProgram({
    withdrawCash: args.cashMinted,
    payFeesCash: args.payFeesCash,
    remoteFeesCash: args.remoteFeesCash,
    beneficiaryHex: args.beneficiaryHex,
    peopleParaId: args.peopleParaId,
    maxWeight: args.maxWeight,
  });
  const mint = api.tx.Psm.mint({
    internal_asset: asLocation(INTERNAL.location),
    external_asset: asLocation(EXTERNAL_TOKENS[args.route.external].location),
    external_amount: args.externalIn,
    max_fee: args.route.feeRate,
  });
  const execute = api.tx.PolkadotXcm.execute(execArgs);
  const batch = api.tx.Utility.batch_all({ calls: [mint.decodedCall, execute.decodedCall] });
  return { batch, execArgs };
}

export type PsmBatch = ReturnType<typeof buildPsmBatch>;

export interface PsmBatchFees {
  /** Local XCM execution fee, CASH. */
  localCash: bigint;
  /** Delivery fee for the forwarded program, CASH. */
  deliveryCash: bigint;
  /** What to pass as `payFeesCash`: local plus delivery, exactly. */
  payFeesCash: bigint;
  /** The batch's dispatch fee as the runtime weighs it, native. */
  dispatchNative: bigint;
  /** The dispatch fee as ChargeAssetTxPayment charges it: the external the USDT/PAS pool takes
   *  for `dispatchNative`. Keep this much of the balance out of the mint. */
  dispatchExternal: bigint;
  /** The weighed weight, declared as the execute() ceiling. */
  maxWeight: Weight;
}

/** Every cost of the batch, measured against the batch itself. Throws when the runtime declines
 *  a read or the minted CASH does not cover the program's own fees. */
export async function estimatePsmBatchFees(args: {
  api: AssetHubApi;
  route: PsmRoute;
  beneficiaryHex: string;
  peopleParaId: number;
  /** The external the mint will consume, at its real magnitude: the dispatch fee has a per-byte
   *  component and compact-encoded amounts change length with magnitude. */
  externalIn: bigint;
  /** The CASH the program will withdraw, for the same reason. */
  cashMinted: bigint;
  /** The destination fee allowance the program will carry, for the same reason. */
  remoteFeesCash: bigint;
  /** Any valid address for the dispatch fee read; the fee does not depend on the signer's
   *  balance. */
  feeProbeAddress: string;
  /** The burner, once it holds the external. The delivery fee is then priced from the real
   *  forwarded program instead of the stand-in. */
  dryRunFrom?: string;
}): Promise<PsmBatchFees> {
  const cashAsset = { type: "V5", value: INTERNAL.location };
  const probe = (payFeesCash: bigint, maxWeight?: Weight) =>
    buildPsmBatch(args.api, {
      route: args.route,
      externalIn: args.externalIn,
      cashMinted: args.cashMinted,
      payFeesCash,
      remoteFeesCash: args.remoteFeesCash,
      beneficiaryHex: args.beneficiaryHex,
      peopleParaId: args.peopleParaId,
      maxWeight,
    });

  // Only the instruction list matters for the weight.
  const rough = probe(args.cashMinted / 4n);
  const weight = await args.api.apis.XcmPaymentApi.query_xcm_weight(
    (rough.execArgs as { message: unknown }).message as never,
  );
  if (!weight.success) throw new Error("psm batch fee estimate: the runtime would not weigh it");
  const localFee = await args.api.apis.XcmPaymentApi.query_weight_to_asset_fee(
    weight.value,
    cashAsset as never,
  );
  if (!localFee.success) throw new Error("psm batch fee estimate: local fee unavailable");
  const localCash = localFee.value;

  // The forwarded program sets the delivery fee through its size. The real one comes from a dry
  // run of the batch, since the burner holds the external and not the CASH the execute withdraws.
  const forwarded =
    (args.dryRunFrom === undefined
      ? null
      : await realForwardedProgram(
          args.api,
          rough.batch.decodedCall,
          args.peopleParaId,
          args.dryRunFrom,
        )) ??
    forwardedProgramStandIn(INTERNAL.locationOnPeople, args.cashMinted, args.beneficiaryHex);
  const df = await args.api.apis.XcmPaymentApi.query_delivery_fees(
    { type: "V5", value: peopleDest(args.peopleParaId) } as never,
    forwarded as never,
    cashAsset as never,
  );
  if (!df.success) throw new Error("psm batch fee estimate: delivery fee unavailable");
  const deliveryCash = extractFungibleAmount(df.value);
  const payFeesCash = localCash + deliveryCash;
  if (payFeesCash >= args.cashMinted) {
    throw new Error(
      `psm batch fee estimate: ${args.cashMinted} CASH minted does not cover the program's own fees ${payFeesCash}`,
    );
  }

  const maxWeight = { ref_time: weight.value.ref_time, proof_size: weight.value.proof_size };
  // Price the dispatch against the batch carrying the final amounts and the declared weight, so
  // the charge it predicts is the charge the submitted batch pays.
  const options = psmBatchTxOptions(args.route.external);
  const dispatchNative = await probe(payFeesCash, maxWeight).batch.getEstimatedFees(
    args.dryRunFrom ?? args.feeProbeAddress,
    options,
  );
  // ChargeAssetTxPayment swaps exactly the native fee out of the pool, so the external it takes is
  // the exact-out quote for it, pool fee included.
  const dispatchExternal =
    await args.api.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens(
      options.asset,
      asLocation(TOKENS.PAS.location),
      dispatchNative,
      true,
    );
  if (dispatchExternal === undefined) {
    throw new Error(
      "psm batch fee estimate: the pool cannot price the dispatch fee in the external",
    );
  }

  return { localCash, deliveryCash, payFeesCash, dispatchNative, dispatchExternal, maxWeight };
}

/** The §4.3 gate for the batch: `dryRunFundingProgram` over the whole batch rather than the bare
 *  execute, so the mint runs in the dry run too. Refuses, with the reason, a batch Asset Hub
 *  rejects (the PSM refusing the mint included), one that would trap assets on either chain, and
 *  one that would land less than `mustLand` on People. */
export function dryRunPsmBatch(args: {
  api: AssetHubApi;
  peopleApi: PeopleApi;
  batch: PsmBatch;
  /** The burner: it signs the batch and holds the external. */
  from: string;
  beneficiaryHex: string;
  peopleParaId: number;
  assetHubParaId: number;
  /** The least CASH that must reach the beneficiary. */
  mustLand: bigint;
}): Promise<{ landed: bigint }> {
  return dryRunFundingProgram({
    api: args.api,
    peopleApi: args.peopleApi,
    execArgs: args.batch.execArgs,
    call: args.batch.batch.decodedCall,
    from: args.from,
    beneficiaryHex: args.beneficiaryHex,
    peopleParaId: args.peopleParaId,
    assetHubParaId: args.assetHubParaId,
    mustLand: args.mustLand,
  });
}
