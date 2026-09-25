// The PSM tier's funding call: one Utility.batch_all that mints CASH from the burner's USDT
// through the PSM and teleports it to the burner's People address, with its sizing, its fee
// estimate and its dry run.
//
// A batch of two calls rather than one XCM with a Transact: no XCM instruction swaps through the
// PSM (ExchangeAsset resolves to the pool), and a batch says what it means where a Transact
// buries a dispatch inside a program and depends on ExpectTransactStatus to fail with it. The
// mint completes before the XCM runs, so the XCM withdraws what it needs from the burner.
//
// Fees. The burner holds only USDT when the batch is dispatched, so the dispatch fee is charged in
// USDT through ChargeAssetTxPayment, which prices it in the USDT/PAS pool. The XCM's own fees are
// paid in USDT too, priced in the same pool, from an allowance the mint leaves on the burner and
// the program withdraws, spends from and deposits the rest of back. Every fee here is measured
// exactly; the cushion over them is taken once, in psmDepositNeeded (FEE_MARGIN_BPS,
// funding-program.ts), and is asked for rather than held back, so it reaches the mint. The
// destination fee is the CASH earmark the pool tier uses.
//
// THE BURNER'S USDT ACCOUNT MUST STAY ALIVE THROUGH THE BATCH. pallet-assets reaps an account a
// transfer or withdrawal leaves below the asset's min_balance and sweeps the remainder with it, and
// a deposit that would create an account below min_balance is refused. USDt's min_balance here is
// 70,000 (0.07 USDT), above the whole fee allowance: a mint that held back only the allowance
// killed the account and the program failed at its first instruction with FailedToTransactAsset,
// and a refund into a killed account failed with BelowMinimum (both dry-run on 2026-09-23). So
// the mint holds back min_balance PLUS the allowance, the program withdraws only the allowance,
// and the account never dips below min_balance: after the mint it holds both, after the withdrawal
// exactly min_balance, after the refund min_balance plus the unspent allowance. That min_balance is
// read live, never assumed, and staying on the burner is its accepted cost.
//
// Atomicity. batch_all reverts the mint when the XCM returns an error, but an XCM
// that completes while trapping assets or landing short returns Ok. The dry run of the whole batch
// before the submit refuses those, so the two together give all-or-nothing.

import { TOKENS, type TokenSpec } from "@getsome/core";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import {
  buildPsmFundingProgram,
  dryRunFundingProgram,
  extractFungibleAmount,
  forwardedProgramStandIn,
  peopleDest,
  realForwardedProgram,
  withFeeMargin,
  type PeopleApi,
  type StableLegFees,
} from "./funding-program";
import type { ConversionRoute } from "./route";
import { STABLE_TOKENS, asLocation, stableTxOptions, type Location } from "./stable";

type AssetHubApi = TypedApi<typeof paseo_next_v2>;
type Weight = { ref_time: bigint; proof_size: bigint };
/** The recorded route on the PSM tier: the external the burner holds and the Permill fee rate
 *  the buyer was quoted, which the call carries verbatim as `max_fee`. */
export type PsmRoute = Extract<ConversionRoute, { tier: "psm" }>;

/** Parts in a Permill. */
export const PERMILL = 1_000_000n;

const INTERNAL = TOKENS.CASH;
/** The externals with the pallet-assets id their `min_balance` is read under. */
const EXTERNAL_TOKENS = STABLE_TOKENS;

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
export const psmBatchTxOptions: (external: PsmRoute["external"]) => { asset: Location } =
  stableTxOptions;

export interface PsmBatchArgs {
  route: PsmRoute;
  /** The external the mint consumes, in its base units. */
  externalIn: bigint;
  /** The CASH the mint pays out, withdrawn whole into the holding. */
  cashMinted: bigint;
  /** The allowance for local execution plus delivery, in the external: the estimate with
   *  FEE_MARGIN_BPS on top. The mint leaves it on the burner beside the external's min_balance,
   *  the program withdraws it, and what it does not spend comes back to the burner. */
  feeAllowanceExternal: bigint;
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
  const external = EXTERNAL_TOKENS[args.route.external];
  const execArgs = buildPsmFundingProgram({
    withdrawCash: args.cashMinted,
    localFees: { id: external.location, amount: args.feeAllowanceExternal },
    remoteFeesCash: args.remoteFeesCash,
    beneficiaryHex: args.beneficiaryHex,
    peopleParaId: args.peopleParaId,
    maxWeight: args.maxWeight,
  });
  const mint = api.tx.Psm.mint({
    internal_asset: asLocation(INTERNAL.location),
    external_asset: asLocation(external.location),
    external_amount: args.externalIn,
    max_fee: args.route.feeRate,
  });
  const execute = api.tx.PolkadotXcm.execute(execArgs);
  const batch = api.tx.Utility.batch_all({ calls: [mint.decodedCall, execute.decodedCall] });
  return { batch, execArgs };
}

export type PsmBatch = ReturnType<typeof buildPsmBatch>;

/** The batch's costs: the stable leg's shape, every figure in the external. `heldBackExternal`
 *  is what stays out of the mint beside the dispatch fee. */
export type PsmBatchFees = StableLegFees;

/** Every cost of the batch, measured against the batch itself, all in the external. Throws when
 *  the runtime declines a read or the deposit does not cover what is held back from the mint. */
export async function estimatePsmBatchFees(args: {
  api: AssetHubApi;
  route: PsmRoute;
  beneficiaryHex: string;
  peopleParaId: number;
  /** The external the batch is carved from, at its real magnitude: the dispatch fee has a
   *  per-byte component and compact-encoded amounts change length with magnitude. */
  depositExternal: bigint;
  /** The destination fee allowance the program will carry, for the same reason. */
  remoteFeesCash: bigint;
  /** Any valid address for the dispatch fee read; the fee does not depend on the signer's
   *  balance. */
  feeProbeAddress: string;
  /** The burner, once it holds the external. The delivery fee is then priced from the real
   *  forwarded program instead of the stand-in. */
  dryRunFrom?: string;
}): Promise<PsmBatchFees> {
  const external = EXTERNAL_TOKENS[args.route.external];
  const externalAsset = { type: "V5", value: external.location };
  const details = await args.api.query.Assets.Asset.getValue(external.assetHubId);
  if (details === undefined) {
    throw new Error(`psm batch fee estimate: ${external.symbol} is not an asset on Asset Hub`);
  }
  const minBalance = details.min_balance;
  // The batch carved from the deposit with `feeAllowance` and `dispatchExternal` kept out of the
  // mint beside the min_balance. Only the amounts' encoded lengths matter to the fees read off it.
  const probe = (feeAllowance: bigint, dispatchExternal: bigint, maxWeight?: Weight) => {
    const externalIn = args.depositExternal - dispatchExternal - minBalance - feeAllowance;
    if (externalIn <= 0n) {
      throw new Error(
        `psm batch fee estimate: ${args.depositExternal} of the external does not cover the ${minBalance + feeAllowance} held back for fees`,
      );
    }
    return buildPsmBatch(args.api, {
      route: args.route,
      externalIn,
      cashMinted: psmMintOut(externalIn, args.route.feeRate),
      feeAllowanceExternal: feeAllowance,
      remoteFeesCash: args.remoteFeesCash,
      beneficiaryHex: args.beneficiaryHex,
      peopleParaId: args.peopleParaId,
      maxWeight,
    });
  };

  // Only the instruction list matters for the weight, and the dry run below needs an allowance
  // that clears, so a quarter of the deposit.
  const rough = probe(args.depositExternal / 4n, 0n);
  const weight = await args.api.apis.XcmPaymentApi.query_xcm_weight(
    (rough.execArgs as { message: unknown }).message as never,
  );
  if (!weight.success) throw new Error("psm batch fee estimate: the runtime would not weigh it");
  const localFee = await args.api.apis.XcmPaymentApi.query_weight_to_asset_fee(
    weight.value,
    externalAsset as never,
  );
  if (!localFee.success) throw new Error("psm batch fee estimate: local fee unavailable");
  const localExternal = localFee.value;

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
    forwardedProgramStandIn(
      INTERNAL.locationOnPeople,
      psmMintOut(args.depositExternal, args.route.feeRate),
      args.beneficiaryHex,
    );
  const df = await args.api.apis.XcmPaymentApi.query_delivery_fees(
    { type: "V5", value: peopleDest(args.peopleParaId) } as never,
    forwarded as never,
    externalAsset as never,
  );
  if (!df.success) throw new Error("psm batch fee estimate: delivery fee unavailable");
  const deliveryExternal = extractFungibleAmount(df.value);

  const maxWeight = { ref_time: weight.value.ref_time, proof_size: weight.value.proof_size };
  // Price the dispatch against the batch carrying the final amounts and the declared weight, so
  // the charge it predicts is the charge the submitted batch pays. The dispatch fee itself is not
  // yet known to keep out of the probe's mint; a few thousand units do not change a compact
  // encoding's length.
  const options = psmBatchTxOptions(args.route.external);
  const dispatchNative = await probe(
    localExternal + deliveryExternal,
    0n,
    maxWeight,
  ).batch.getEstimatedFees(args.dryRunFrom ?? args.feeProbeAddress, options);
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

  const feeAllowanceExternal = withFeeMargin(localExternal + deliveryExternal);
  const heldBackExternal = minBalance + feeAllowanceExternal;

  return {
    localExternal,
    deliveryExternal,
    feeAllowanceExternal,
    minBalanceExternal: minBalance,
    heldBackExternal,
    dispatchNative,
    dispatchExternal,
    maxWeight,
  };
}

/** The atomicity gate for the batch: `dryRunFundingProgram` over the whole batch rather than the bare
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
