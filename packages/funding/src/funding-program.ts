// The funding program the burner submits with PolkadotXcm.execute, and its fee estimator.
//
// The program withdraws the deposit's native, pays the XCM's own fees in native, exchanges the
// rest for the underlying through the AssetConversion pool inside the holding, and teleports the
// result to the burner's People address. The underlying never touches the Asset Hub account. The
// extrinsic is atomic: a failed exchange rolls the whole program back and the deposit stays native,
// minus the dispatch fee.
//
// Every fee allowance is exact. The unspent part of a PayFees allowance is not returned to the
// burner, and a dispatch fee refund would land on an account already emptied below the existential
// deposit, so both are sized to what the runtime charges: local execution from the weighed message,
// delivery from the forwarded program, dispatch from the declared weight. A fee that moves between
// the estimate and inclusion fails the program, and the next tick re-prices and retries.
//
// The destination fee allowance is generous by design: the remote RefundSurplus returns what it
// does not consume and the DepositAsset sweeps it to the burner.

import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";

type AssetHubApi = TypedApi<typeof paseo_next_v2>;
type AssetLocation = Parameters<AssetHubApi["query"]["AssetConversion"]["Pools"]["getValue"]>[0][0];
export type Pool = { native: AssetLocation; underlying: AssetLocation };

/** Native as every chain in this route keys it: the relay token at interior-Here, one up. */
const NATIVE_HERE = { parents: 1, interior: { type: "Here" } };

/** Fallback weight ceiling for execute(), used only when the runtime will not weigh the program.
 *  Its over-charge is refunded to an account that is empty by then, so prefer the estimator's
 *  weight. */
export const FUNDING_PROGRAM_MAX_WEIGHT = { ref_time: 8_000_000_000n, proof_size: 400_000n };

const native = (v: bigint) => ({ id: NATIVE_HERE, fun: { type: "Fungible", value: v } });

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

const peopleDest = (peopleParaId: number) => ({
  parents: 1,
  interior: { type: "X1", value: { type: "Parachain", value: peopleParaId } },
});

/** The execute() argument type; built here from plain {type,value} objects and cast. */
type ExecuteArgs = Parameters<AssetHubApi["tx"]["PolkadotXcm"]["execute"]>[0];

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
      {
        type: "InitiateTransfer",
        value: {
          destination: peopleDest(args.peopleParaId),
          remote_fees: {
            type: "Teleport",
            value: { type: "Definite", value: [c(args.remoteFeesCash)] },
          },
          preserve_origin: false,
          assets: [
            { type: "Teleport", value: { type: "Wild", value: { type: "AllCounted", value: 1 } } },
          ],
          remote_xcm: [
            // Return the unused destination allowance to the holding, then sweep everything to
            // the burner.
            { type: "RefundSurplus" },
            {
              type: "DepositAsset",
              value: {
                assets: { type: "Wild", value: { type: "AllCounted", value: 1 } },
                beneficiary: accountBeneficiary(args.beneficiaryHex),
              },
            },
          ],
        },
      },
    ],
  };
  return {
    message,
    max_weight: args.maxWeight ?? FUNDING_PROGRAM_MAX_WEIGHT,
  } as unknown as ExecuteArgs;
}

/** A stand-in for the program People receives, used to price the delivery fee when no funded
 *  account can dry-run the real one. Mirrors the instruction list the runtime forwards. */
function forwardedProgramStandIn(pool: Pool, amount: bigint, beneficiaryHex: string) {
  const c = (v: bigint) => cash(pool, v);
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
 *  origin that already holds the native. Returns null when the dry-run cannot produce it. */
async function realForwardedProgram(
  api: AssetHubApi,
  execArgs: ExecuteArgs,
  peopleParaId: number,
  from: string,
): Promise<unknown | null> {
  try {
    const dr = await api.apis.DryRunApi.dry_run_call(
      { type: "system", value: { type: "Signed", value: from } } as never,
      api.tx.PolkadotXcm.execute(execArgs).decodedCall as never,
      5,
    );
    if (!dr.success) return null;
    const forwarded = (dr.value as { forwarded_xcms?: Array<[unknown, unknown[]]> }).forwarded_xcms;
    const toPeople = forwarded?.find(([dest]) => {
      const loc = (
        dest as { value?: { parents?: number; interior?: { value?: { value?: number } } } }
      ).value;
      return loc?.parents === 1 && loc?.interior?.value?.value === peopleParaId;
    });
    return toPeople?.[1]?.[0] ?? null;
  } catch {
    // A runtime without the dry-run API, or one that rejects this call shape.
    return null;
  }
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
          probe(args.nativeBalance / 4n, 1n),
          args.peopleParaId,
          args.dryRunFrom,
        )) ?? forwardedProgramStandIn(args.pool, args.minUnderlyingOut, args.beneficiaryHex);
  const df = await args.api.apis.XcmPaymentApi.query_delivery_fees(
    { type: "V5", value: peopleDest(args.peopleParaId) } as never,
    forwarded as never,
    { type: "V5", value: NATIVE_HERE } as never,
  );
  if (!df.success) throw new Error("funding program fee estimate: delivery fee unavailable");
  const deliveryNative = extractNativeAmount(df.value);
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

/** The fungible amount out of a VersionedAssets delivery-fee result (its single native entry). */
function extractNativeAmount(versioned: unknown): bigint {
  const assets = (versioned as { value?: Array<{ fun?: { type?: string; value?: bigint } }> })
    .value;
  const first = Array.isArray(assets) ? assets[0] : undefined;
  return first?.fun?.type === "Fungible" ? BigInt(first.fun.value ?? 0n) : 0n;
}
