// The funding program the burner submits with PolkadotXcm.execute, and its fee estimator.
//
// The program withdraws the deposit's native, pays the XCM's own fees in native, exchanges the
// rest for the underlying through the AssetConversion pool inside the holding, and teleports the
// result to the burner's People address. The underlying never touches the Asset Hub account. The
// extrinsic is atomic: a failed exchange rolls the whole program back and the deposit stays native,
// minus the dispatch fee.
//
// The PSM tier has a second shape (`buildPsmFundingProgram`): the CASH a Psm.mint has just paid
// onto the burner is withdrawn whole and teleported, the XCM's own fees are paid in the external
// (USDT) the mint left on the burner for them, and what the fees did not spend is deposited back
// there. No exchange, since the mint did the conversion. It runs after the mint inside a
// Utility.batch_all (psm-batch.ts), and the dry run below runs the whole batch.
//
// On the pool tier every fee allowance is exact. The unspent part of a PayFees allowance is not
// returned to the burner, and a dispatch fee refund would land on an account already emptied below
// the existential deposit, so both are sized to what the runtime charges: local execution from the
// weighed message, delivery from the forwarded program, dispatch from the declared weight. A fee
// that moves between the estimate and inclusion fails the program, and the next tick re-prices and
// retries.
//
// The PSM tier's PayFees allowance carries FEE_MARGIN_BPS over the estimate instead, because the
// estimate is structurally short: the runtime quotes execution and delivery against the pool as it
// stands, while the program's execution swap moves that pool before the delivery swap is priced.
// Measured live against the shallow Paseo pool, the delivery quote came in 0.6% under the charge
// (76,204 quoted, 76,665 charged in CASH; 28,857 against 29,032 in USDT) and the exact allowance
// failed the transfer with NotHoldingFees. The program ends with RefundSurplus and a DepositAsset
// to the burner, since whatever is left in the holding when a program ends is trapped, and the dry
// run refuses a program that would trap. Paying the fees in the external rather than in the minted
// CASH keeps the mint at exactly the buyer's target, so no fee misestimate can land it short.
//
// The destination fee allowance is generous by design: the remote RefundSurplus returns what it
// does not consume and the DepositAsset sweeps it to the burner.
//
// Before the program is paid for, both chains run it in a dry run: Asset Hub runs the call as the
// burner, People runs the program Asset Hub forwards. A program that would fail on either chain,
// trap assets, or land short of the target is reported instead of submitted.

import { TOKENS, type XcmJunction, type XcmLocation } from "@getsome/core";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { describeDispatchError } from "./dispatch-error";
import { creditedTo, forwardedTo, siblingOrigin, signedOrigin, trappedIn } from "./xcm-dry-run";

type AssetHubApi = TypedApi<typeof paseo_next_v2>;
export type PeopleApi = TypedApi<typeof paseo_people_next>;
type AssetLocation = Parameters<AssetHubApi["query"]["AssetConversion"]["Pools"]["getValue"]>[0][0];
export type Pool = { native: AssetLocation; underlying: AssetLocation };

/** Native as every chain in this route keys it: the relay token at interior-Here, one up. */
const NATIVE_HERE = { parents: 1, interior: { type: "Here" } };

/** Fallback weight ceiling for execute(), used only when the runtime will not weigh the program.
 *  Its over-charge is refunded to an account that is empty by then, so prefer the estimator's
 *  weight. */
export const FUNDING_PROGRAM_MAX_WEIGHT = { ref_time: 8_000_000_000n, proof_size: 400_000n };

/** Headroom over a measured fee before it is carried as an allowance, in basis points. About
 *  17 times the 0.6% by which the delivery quote under-reports the charge (see the header), so it
 *  also absorbs the pool moving between the estimate and inclusion, and small enough that the
 *  refund it produces is dust. Applied to the PSM program's PayFees and to the destination fee. */
export const FEE_MARGIN_BPS = 1_000n;

/** `fee` plus FEE_MARGIN_BPS of it, rounded up, so a one-unit fee still gains a unit. */
export function withFeeMargin(fee: bigint): bigint {
  return fee + (fee * FEE_MARGIN_BPS + 9_999n) / 10_000n;
}

const native = (v: bigint) => ({ id: NATIVE_HERE, fun: { type: "Fungible", value: v } });

const fungible = (id: XcmLocation, v: bigint) => ({ id, fun: { type: "Fungible", value: v } });

/** XCM v5's Junction variants in declaration order, which is what the runtime's `Ord` compares
 *  before the value. */
const JUNCTION_ORDER = [
  "Parachain",
  "AccountId32",
  "AccountIndex64",
  "AccountKey20",
  "PalletInstance",
  "GeneralIndex",
  "GeneralKey",
  "OnlyChild",
  "Plurality",
  "GlobalConsensus",
];

const junctionsOf = (location: XcmLocation): XcmJunction[] =>
  location.interior.type === "Here" ? [] : location.interior.value;

/** `Location`'s `Ord`: parents, then the interior's arity (its variant), then each junction by
 *  variant and value. */
function compareLocations(a: XcmLocation, b: XcmLocation): number {
  if (a.parents !== b.parents) return a.parents - b.parents;
  const ja = junctionsOf(a);
  const jb = junctionsOf(b);
  if (ja.length !== jb.length) return ja.length - jb.length;
  for (let i = 0; i < ja.length; i += 1) {
    const x = ja[i]!;
    const y = jb[i]!;
    if (x.type !== y.type) return JUNCTION_ORDER.indexOf(x.type) - JUNCTION_ORDER.indexOf(y.type);
    const vx = BigInt(x.value);
    const vy = BigInt(y.value);
    if (vx !== vy) return vx < vy ? -1 : 1;
  }
  return 0;
}

/** An XCM `Assets` list in the order the runtime's codec insists on: sorted by id. An unsorted
 *  list fails to decode and the whole call with it. */
export function sortedAssets<A extends { id: XcmLocation }>(assets: A[]): A[] {
  return [...assets].sort((a, b) => compareLocations(a.id, b.id));
}

const cash = (pool: Pool, v: bigint) => ({
  id: pool.underlying,
  fun: { type: "Fungible", value: v },
});

const accountBeneficiary = (beneficiaryHex: string) => ({
  parents: 0,
  interior: {
    type: "X1",
    // papi encodes fixed-size binaries from their hex-string form; a raw Uint8Array mis-encodes.
    value: { type: "AccountId32", value: { network: undefined, id: beneficiaryHex } },
  },
});

export const peopleDest = (peopleParaId: number) => ({
  parents: 1,
  interior: { type: "X1", value: { type: "Parachain", value: peopleParaId } },
});

/** The execute() argument type; built here from plain {type,value} objects and cast. */
type ExecuteArgs = Parameters<AssetHubApi["tx"]["PolkadotXcm"]["execute"]>[0];
/** A decoded call, as a transaction's `decodedCall` carries it and Utility.batch_all takes it. */
export type AssetHubCall = ReturnType<AssetHubApi["tx"]["PolkadotXcm"]["execute"]>["decodedCall"];

/** The destination fee allowance: the sized over-buy, or 1% of the target when that is more. The
 *  remote RefundSurplus returns the unused part, while an allowance too small to execute on traps
 *  the teleport at the destination. */
export function destinationEarmark(underlyingOut: bigint, remoteFeeBuffer: bigint): bigint {
  const onePercent = underlyingOut / 100n;
  const floor = onePercent > remoteFeeBuffer ? onePercent : remoteFeeBuffer;
  return floor > 0n ? floor : 1n;
}

/** The funding program: native in, underlying landed on the burner's People address, every Asset
 *  Hub fee paid in native before the exchange. */
export function buildFundingProgram(args: {
  pool: Pool;
  /** Native withdrawn into the holding: the balance minus the dispatch fee. */
  withdrawNative: bigint;
  /** Local execution plus delivery, in native. */
  payFeesNative: bigint;
  /** The least underlying the exchange may return. Everything withdrawn above the fee allowance
   *  is given, and anything above this floor lands as extra underlying. */
  minUnderlyingOut: bigint;
  /** Destination fee allowance in the underlying. */
  remoteFeesCash: bigint;
  beneficiaryHex: string;
  peopleParaId: number;
  /** The declared weight ceiling. Defaults to FUNDING_PROGRAM_MAX_WEIGHT. */
  maxWeight?: { ref_time: bigint; proof_size: bigint };
}): ExecuteArgs {
  const c = (v: bigint) => cash(args.pool, v);
  const message = {
    type: "V5",
    value: [
      { type: "WithdrawAsset", value: [native(args.withdrawNative)] },
      { type: "PayFees", value: { asset: native(args.payFeesNative) } },
      {
        type: "ExchangeAsset",
        value: {
          give: { type: "Definite", value: [native(args.withdrawNative - args.payFeesNative)] },
          want: [c(args.minUnderlyingOut)],
          // Give all of `give`, receive as much as the pool returns, at least `want`.
          maximal: true,
        },
      },
      teleportHoldingToPeople(c(args.remoteFeesCash), args.beneficiaryHex, args.peopleParaId),
    ],
  };
  return {
    message,
    max_weight: args.maxWeight ?? FUNDING_PROGRAM_MAX_WEIGHT,
  } as unknown as ExecuteArgs;
}

/** The PSM tier's program: the CASH the mint before it in the batch paid onto the burner in, the
 *  same CASH landed on the burner's People address, every Asset Hub fee paid in the external the
 *  mint left on the burner, and the unspent part of that allowance back on the burner.
 *
 *  The refund comes AFTER the transfer: delivery is charged from the fees register inside
 *  InitiateTransfer, and a RefundSurplus before it would empty that register and leave delivery
 *  to be taken from a holding the transfer has already teleported. When the transfer runs the
 *  external sits in the fees register and the holding is CASH alone, so the teleport's
 *  `AllCounted(1)` is unambiguous; after RefundSurplus the holding is the external alone, so the
 *  refund's is too. It counts one asset rather than `Wild(All)`, which is weighed as
 *  MaxAssetsIntoHolding deposits and costs twenty times the fee. The refund lands in an account the
 *  batch keeps alive (psm-batch.ts), and a deposit into a live account has no minimum. Should the
 *  transfer fail, nothing after it runs and batch_all reverts the mint. */
export function buildPsmFundingProgram(args: {
  /** CASH withdrawn into the holding: what the mint paid out. */
  withdrawCash: bigint;
  /** The allowance for local execution plus delivery, in the external the burner holds, with
   *  FEE_MARGIN_BPS on top. Withdrawn beside the CASH and moved whole to the fees register. */
  localFees: { id: XcmLocation; amount: bigint };
  /** Destination fee allowance in CASH. */
  remoteFeesCash: bigint;
  beneficiaryHex: string;
  peopleParaId: number;
  /** The declared weight ceiling. Defaults to FUNDING_PROGRAM_MAX_WEIGHT. */
  maxWeight?: { ref_time: bigint; proof_size: bigint };
}): ExecuteArgs {
  const c = (v: bigint) => fungible(TOKENS.CASH.location, v);
  const fees = fungible(args.localFees.id, args.localFees.amount);
  const message = {
    type: "V5",
    value: [
      { type: "WithdrawAsset", value: sortedAssets([fees, c(args.withdrawCash)]) },
      { type: "PayFees", value: { asset: fees } },
      teleportHoldingToPeople(c(args.remoteFeesCash), args.beneficiaryHex, args.peopleParaId),
      { type: "RefundSurplus" },
      {
        type: "DepositAsset",
        value: {
          assets: { type: "Wild", value: { type: "AllCounted", value: 1 } },
          beneficiary: accountBeneficiary(args.beneficiaryHex),
        },
      },
    ],
  };
  return {
    message,
    max_weight: args.maxWeight ?? FUNDING_PROGRAM_MAX_WEIGHT,
  } as unknown as ExecuteArgs;
}

/** The InitiateTransfer both shapes carry: everything in the holding teleported to People,
 *  `remoteFees` earmarked for the destination's execution. */
function teleportHoldingToPeople(
  remoteFees: unknown,
  beneficiaryHex: string,
  peopleParaId: number,
) {
  return {
    type: "InitiateTransfer",
    value: {
      destination: peopleDest(peopleParaId),
      remote_fees: { type: "Teleport", value: { type: "Definite", value: [remoteFees] } },
      preserve_origin: false,
      assets: [
        { type: "Teleport", value: { type: "Wild", value: { type: "AllCounted", value: 1 } } },
      ],
      remote_xcm: [
        // Return the unused destination allowance to the holding, then sweep everything to the
        // burner.
        { type: "RefundSurplus" },
        {
          type: "DepositAsset",
          value: {
            assets: { type: "Wild", value: { type: "AllCounted", value: 1 } },
            beneficiary: accountBeneficiary(beneficiaryHex),
          },
        },
      ],
    },
  };
}

/** A stand-in for the program People receives, with the underlying keyed as `assetId`. Mirrors
 *  the instruction list the runtime forwards, which is what its weight and delivery fee depend
 *  on. */
export function forwardedProgramStandIn(
  assetId: AssetLocation,
  amount: bigint,
  beneficiaryHex: string,
) {
  const c = (v: bigint) => ({ id: assetId, fun: { type: "Fungible", value: v } });
  return {
    type: "V5",
    value: [
      { type: "ReceiveTeleportedAsset", value: [c(amount)] },
      { type: "PayFees", value: { asset: c(amount) } },
      { type: "ReceiveTeleportedAsset", value: [c(amount)] },
      { type: "ClearOrigin" },
      { type: "RefundSurplus" },
      {
        type: "DepositAsset",
        value: {
          assets: { type: "Wild", value: { type: "AllCounted", value: 1 } },
          beneficiary: accountBeneficiary(beneficiaryHex),
        },
      },
      { type: "SetTopic", value: `0x${"00".repeat(32)}` },
    ],
  };
}

/** The real program People will receive, taken from a dry-run of the actual call. Requires an
 *  origin that already holds what the call withdraws. Returns null when the dry-run cannot
 *  produce it. */
export async function realForwardedProgram(
  api: AssetHubApi,
  call: AssetHubCall,
  peopleParaId: number,
  from: string,
): Promise<unknown | null> {
  try {
    const dr = await api.apis.DryRunApi.dry_run_call(signedOrigin(from) as never, call as never, 5);
    return dr.success ? forwardedTo(dr.value, peopleParaId) : null;
  } catch {
    // A runtime without the dry-run API, or one that rejects this call shape.
    return null;
  }
}

type PeopleDryRun = { landed: bigint; trapped: bigint } | { failed: string };

/** What People does with `program` arriving from Asset Hub, without executing it for real: the
 *  underlying credited to the beneficiary and anything the program would trap. `failed` carries
 *  the reason when People will not run the program or the program does not complete. */
async function dryRunOnPeople(args: {
  peopleApi: PeopleApi;
  assetHubParaId: number;
  program: unknown;
  beneficiaryHex: string;
}): Promise<PeopleDryRun> {
  const dr = await args.peopleApi.apis.DryRunApi.dry_run_xcm(
    siblingOrigin(args.assetHubParaId) as never,
    args.program as never,
  );
  if (!dr.success) return { failed: "People would not dry-run the forwarded program" };
  const outcome = dr.value.execution_result;
  if (outcome.type !== "Complete") {
    const error = (outcome.value as { error?: { type?: string } }).error?.type ?? outcome.type;
    return { failed: `the forwarded program fails on People with ${error}` };
  }
  const events = dr.value.emitted_events;
  return { landed: creditedTo(events, args.beneficiaryHex, "asset"), trapped: trappedIn(events) };
}

/** Asset Hub's dry run rejected the call. Carries the dispatch error so a caller can act on its
 *  kind, as the pipeline does for the PSM's refusals of a mint. */
export class ProgramRejectedError extends Error {
  constructor(
    readonly dispatchError: unknown,
    reason: string,
  ) {
    super(`not submitted: Asset Hub rejects the program: ${reason}`);
    this.name = "ProgramRejectedError";
  }
}

/** Runs the funding program on both chains without submitting it: the call on Asset Hub as the
 *  burner, then the program Asset Hub forwards on People as Asset Hub. Throws with the reason when
 *  either chain fails the program or would trap assets, or when less than `mustLand` would reach
 *  the beneficiary. Returns what would land. */
export async function dryRunFundingProgram(args: {
  api: AssetHubApi;
  peopleApi: PeopleApi;
  execArgs: ExecuteArgs;
  /** The call to run: the bare execute of `execArgs` unless given. The PSM tier passes its
   *  Utility.batch_all, so the mint runs too and a program that completes but misbehaves is
   *  caught here, the one outcome batch_all does not revert (local/psm/PLAN.md §4.3). */
  call?: AssetHubCall;
  /** The burner: it signs the call and holds what it withdraws. */
  from: string;
  beneficiaryHex: string;
  peopleParaId: number;
  assetHubParaId: number;
  /** The least underlying that must reach the beneficiary. */
  mustLand: bigint;
}): Promise<{ landed: bigint }> {
  const call = args.call ?? args.api.tx.PolkadotXcm.execute(args.execArgs).decodedCall;
  const dr = await args.api.apis.DryRunApi.dry_run_call(
    signedOrigin(args.from) as never,
    call as never,
    5,
  );
  if (!dr.success) {
    throw new Error(`not submitted: Asset Hub would not dry-run the call (${dr.value.type})`);
  }
  const effects = dr.value;
  if (!effects.execution_result.success) {
    const { error } = effects.execution_result.value;
    throw new ProgramRejectedError(error, describeDispatchError(error, args.execArgs));
  }
  const trappedOnAssetHub = trappedIn(effects.emitted_events);
  if (trappedOnAssetHub > 0n) {
    throw new Error(`not submitted: the program would trap ${trappedOnAssetHub} on Asset Hub`);
  }
  const forwarded = forwardedTo(effects, args.peopleParaId);
  if (forwarded === null) {
    throw new Error("not submitted: Asset Hub forwards nothing to People");
  }
  const run = await dryRunOnPeople({
    peopleApi: args.peopleApi,
    assetHubParaId: args.assetHubParaId,
    program: forwarded,
    beneficiaryHex: args.beneficiaryHex,
  });
  if ("failed" in run) throw new Error(`not submitted: ${run.failed}`);
  if (run.trapped > 0n) {
    throw new Error(`not submitted: the program would trap ${run.trapped} on People`);
  }
  if (run.landed < args.mustLand) {
    throw new Error(
      `not submitted: only ${run.landed} of ${args.mustLand} underlying would reach the beneficiary on People`,
    );
  }
  return { landed: run.landed };
}

export interface FundingProgramFees {
  /** Local XCM execution fee, native. */
  localNative: bigint;
  /** Delivery fee for the forwarded program, native. */
  deliveryNative: bigint;
  /** What to pass as `payFeesNative`: local plus delivery, exactly. */
  payFeesNative: bigint;
  /** The execute() dispatch fee, native. Subtract it from the balance to get `withdrawNative`. */
  dispatchNative: bigint;
  /** The weighed weight, declared as the execute() ceiling. */
  maxWeight: { ref_time: bigint; proof_size: bigint };
}

/** Every native cost of the program, measured against the message itself. Throws when the
 *  runtime declines a read. */
export async function estimateFundingProgramFees(args: {
  api: AssetHubApi;
  pool: Pool;
  beneficiaryHex: string;
  peopleParaId: number;
  /** The native the program will withdraw, at its real magnitude: the dispatch fee has a per-byte
   *  component and compact-encoded amounts change length with magnitude. */
  nativeBalance: bigint;
  /** The exchange floor the program will carry, for the same reason. */
  minUnderlyingOut: bigint;
  /** The destination fee allowance the program will carry, for the same reason. */
  remoteFeesCash: bigint;
  /** Any valid address for the dispatch fee read; the fee does not depend on the signer's
   *  balance. */
  feeProbeAddress: string;
  /** The burner, once it holds the native. The delivery fee is then priced from the real
   *  forwarded program instead of the stand-in. */
  dryRunFrom?: string;
}): Promise<FundingProgramFees> {
  const probe = (
    payFeesNative: bigint,
    minUnderlyingOut: bigint,
    maxWeight?: { ref_time: bigint; proof_size: bigint },
  ) =>
    buildFundingProgram({
      pool: args.pool,
      withdrawNative: args.nativeBalance,
      payFeesNative,
      minUnderlyingOut,
      remoteFeesCash: args.remoteFeesCash,
      beneficiaryHex: args.beneficiaryHex,
      peopleParaId: args.peopleParaId,
      maxWeight,
    });

  // Only the instruction list matters for the weight.
  const rough = probe(args.nativeBalance / 4n, args.minUnderlyingOut);
  const weight = await args.api.apis.XcmPaymentApi.query_xcm_weight(
    (rough as { message: unknown }).message as never,
  );
  if (!weight.success)
    throw new Error("funding program fee estimate: the runtime would not weigh it");
  const localFee = await args.api.apis.XcmPaymentApi.query_weight_to_asset_fee(weight.value, {
    type: "V5",
    value: NATIVE_HERE,
  } as never);
  if (!localFee.success) throw new Error("funding program fee estimate: local fee unavailable");
  const localNative = localFee.value;

  // The forwarded program sets the delivery fee through its size. The dry-run charges no dispatch
  // fee and must reach the send, so it runs with the whole balance and no exchange floor.
  const forwarded =
    (args.dryRunFrom === undefined
      ? null
      : await realForwardedProgram(
          args.api,
          args.api.tx.PolkadotXcm.execute(probe(args.nativeBalance / 4n, 1n)).decodedCall,
          args.peopleParaId,
          args.dryRunFrom,
        )) ??
    forwardedProgramStandIn(args.pool.underlying, args.minUnderlyingOut, args.beneficiaryHex);
  const df = await args.api.apis.XcmPaymentApi.query_delivery_fees(
    { type: "V5", value: peopleDest(args.peopleParaId) } as never,
    forwarded as never,
    { type: "V5", value: NATIVE_HERE } as never,
  );
  if (!df.success) throw new Error("funding program fee estimate: delivery fee unavailable");
  const deliveryNative = extractFungibleAmount(df.value);
  const payFeesNative = localNative + deliveryNative;
  if (payFeesNative >= args.nativeBalance) {
    throw new Error(
      `funding program fee estimate: ${args.nativeBalance} native does not cover the program's own fees ${payFeesNative}`,
    );
  }

  const maxWeight = { ref_time: weight.value.ref_time, proof_size: weight.value.proof_size };
  // Price the dispatch against a call carrying the final amounts and the declared weight, so the
  // charge it predicts is the charge the submitted call pays.
  const dispatchNative = await args.api.tx.PolkadotXcm.execute(
    probe(payFeesNative, args.minUnderlyingOut, maxWeight),
  ).getEstimatedFees(args.dryRunFrom ?? args.feeProbeAddress);

  return { localNative, deliveryNative, payFeesNative, dispatchNative, maxWeight };
}

/** The underlying as People keys it. An asset local to Asset Hub sits behind Asset Hub's parachain
 *  junction one hop up; an asset already keyed from the relay or beyond reads the same on both. */
function underlyingOnPeople(pool: Pool, assetHubParaId: number): AssetLocation {
  const local = pool.underlying as unknown as { parents: number; interior: { value?: unknown } };
  if (local.parents !== 0) return pool.underlying;
  const inner = local.interior.value;
  const junctions = Array.isArray(inner) ? inner : inner === undefined ? [] : [inner];
  const all = [{ type: "Parachain", value: assetHubParaId }, ...junctions];
  const value = all.length === 1 ? all[0] : all;
  return { parents: 1, interior: { type: `X${all.length}`, value } } as unknown as AssetLocation;
}

/** The destination's execution fee for the forwarded program, in the underlying, with
 *  FEE_MARGIN_BPS on top so it is never a bare measurement. People runs the program in a dry run
 *  as if Asset Hub had sent it, and the fee is whatever the teleported amount loses before it
 *  reaches the beneficiary. People cannot price a weight in the underlying directly, so this reads
 *  the charge its fee logic actually makes. Throws when the dry run does not complete. */
export async function estimateDestinationFeeCash(args: {
  peopleApi: PeopleApi;
  pool: Pool;
  assetHubParaId: number;
  beneficiaryHex: string;
  /** Representative underlying amount. The fee does not depend on it, but the deposit must clear
   *  the asset's minimum balance for the dry run to complete. */
  amount: bigint;
}): Promise<bigint> {
  const asset = underlyingOnPeople(args.pool, args.assetHubParaId);
  const program = forwardedProgramStandIn(asset, args.amount, args.beneficiaryHex);
  const run = await dryRunOnPeople({
    peopleApi: args.peopleApi,
    assetHubParaId: args.assetHubParaId,
    program,
    beneficiaryHex: args.beneficiaryHex,
  });
  if ("failed" in run) throw new Error(`destination fee estimate: ${run.failed}`);
  if (run.landed === 0n) {
    throw new Error("destination fee estimate: nothing reached the beneficiary in the dry run");
  }
  // The stand-in teleports the amount twice and deposits what is left to the beneficiary.
  return withFeeMargin(2n * args.amount - run.landed);
}

/** The fungible amount out of a VersionedAssets delivery-fee result (its single entry). */
export function extractFungibleAmount(versioned: unknown): bigint {
  const assets = (versioned as { value?: Array<{ fun?: { type?: string; value?: bigint } }> })
    .value;
  const first = Array.isArray(assets) ? assets[0] : undefined;
  return first?.fun?.type === "Fungible" ? BigInt(first.fun.value ?? 0n) : 0n;
}
