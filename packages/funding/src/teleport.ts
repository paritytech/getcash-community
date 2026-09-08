// The teleport leg, paid entirely in the underlying. A self-funding XCM via PolkadotXcm.execute
// withdraws the whole underlying holding, pays local execution, delivery and destination fees
// out of it, and teleports the rest to the burner's own People address.

import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";

type AssetHubApi = TypedApi<typeof paseo_next_v2>;
type AssetLocation = Parameters<AssetHubApi["query"]["AssetConversion"]["Pools"]["getValue"]>[0][0];
export type Pool = { native: AssetLocation; underlying: AssetLocation };

/** Native as every chain in this route keys it: the relay token at interior-Here, one up. */
const NATIVE_HERE = { parents: 1, interior: { type: "Here" } };

/** Fallback local-execution weight ceiling for execute(), used only when the runtime will not
 *  weigh the program. */
export const TELEPORT_MAX_WEIGHT = { ref_time: 8_000_000_000n, proof_size: 400_000n };

/** Headroom over the measured weight: none. The declared ceiling is exactly what
 *  query_xcm_weight reports. */
const WEIGHT_MARGIN_NUM = 1n;
const WEIGHT_MARGIN_DEN = 1n;

/** Margin on the PayFees earmark (local + delivery), ×1.15. Covers pool-rate drift between
 *  pricing and execution of the delivery leg. */
const PAYFEES_MARGIN_NUM = 115n;
const PAYFEES_MARGIN_DEN = 100n;

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

/** The self-funding teleport to submit via PolkadotXcm.execute. `withdrawAmount` is the whole
 *  underlying holding; `payFeesCash` must cover local + delivery (see estimateTeleportFeesCash);
 *  `remoteFeesCash` may be generous. */
export function buildSelfFundingTeleport(args: {
  pool: Pool;
  withdrawAmount: bigint;
  payFeesCash: bigint;
  remoteFeesCash: bigint;
  beneficiaryHex: string;
  peopleParaId: number;
  /** The declared weight ceiling; defaults to TELEPORT_MAX_WEIGHT. */
  maxWeight?: { ref_time: bigint; proof_size: bigint };
}): ExecuteArgs {
  const c = (v: bigint) => cash(args.pool, v);
  const message = {
    type: "V5",
    value: [
      { type: "WithdrawAsset", value: [c(args.withdrawAmount)] },
      { type: "PayFees", value: { asset: c(args.payFeesCash) } },
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
            // Return the unused destination earmark to the holding, then sweep everything to
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
  return { message, max_weight: args.maxWeight ?? TELEPORT_MAX_WEIGHT } as unknown as ExecuteArgs;
}

/** A stand-in for the program People receives, used to price the delivery fee when no funded
 *  account can dry-run the real one. Mirrors the instruction list the runtime forwards. */
function forwardedTeleportStandIn(pool: Pool, amount: bigint, beneficiaryHex: string) {
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

/** The real program People will receive, taken from a dry-run of the actual teleport. Requires
 *  an origin that already holds the underlying. Returns null when the dry-run cannot produce it. */
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

export interface TeleportFeesCash {
  /** Local execution fee, in the underlying's base units. */
  localCash: bigint;
  /** Delivery fee, converted from native to the underlying via the pool. */
  deliveryCash: bigint;
  /** What to pass as `payFeesCash`: (local + delivery) × margin. */
  payFeesCash: bigint;
  /** The program's measured weight plus headroom, to declare as the execute() ceiling. */
  maxWeight: { ref_time: bigint; proof_size: bigint };
}

/** Margin on the dispatch-fee slice: none. The slice equals the fee getEstimatedFees reports. */
const DISPATCH_RESERVE_MARGIN_NUM = 1n;
const DISPATCH_RESERVE_MARGIN_DEN = 1n;

/**
 * The underlying held back from the withdrawal to pay the teleport's dispatch fee.
 * `getEstimatedFees` reports the fee in native base units; it is converted through the pool.
 * Throws if either read fails.
 */
export async function reserveForDispatchFee(args: {
  api: AssetHubApi;
  pool: Pool;
  /** A representative teleport; only its call shape sets the fee. */
  execArgs: ExecuteArgs;
  from: string;
}): Promise<bigint> {
  const feeNative = await args.api.tx.PolkadotXcm.execute(args.execArgs).getEstimatedFees(
    args.from,
    { asset: args.pool.underlying as never },
  );
  const feeCash = await args.api.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens(
    args.pool.underlying,
    args.pool.native,
    feeNative,
    true,
  );
  if (feeCash === undefined) {
    throw new Error("teleport dispatch fee: the pool cannot price it in the underlying");
  }
  return (feeCash * DISPATCH_RESERVE_MARGIN_NUM) / DISPATCH_RESERVE_MARGIN_DEN;
}

/** Fund-free estimate of the underlying the teleport spends on the Asset Hub side (local
 *  execution + delivery). Throws when the runtime declines any read; a read that succeeds with
 *  zero is returned as such. */
export async function estimateTeleportFeesCash(args: {
  api: AssetHubApi;
  pool: Pool;
  beneficiaryHex: string;
  peopleParaId: number;
  /** Representative underlying amount; the fees do not depend on it. */
  amount: bigint;
  /** An address already holding `amount` of the underlying. Given one, the delivery fee is
   *  priced from the real forwarded program. */
  dryRunFrom?: string;
}): Promise<TeleportFeesCash> {
  // Provisional earmarks; only the message shape matters for the weight.
  const built = buildSelfFundingTeleport({
    pool: args.pool,
    withdrawAmount: args.amount,
    payFeesCash: args.amount / 4n,
    remoteFeesCash: args.amount / 4n,
    beneficiaryHex: args.beneficiaryHex,
    peopleParaId: args.peopleParaId,
  });
  const message = (built as { message: unknown }).message;

  const weight = await args.api.apis.XcmPaymentApi.query_xcm_weight(message as never);
  if (!weight.success) throw new Error("teleport fee estimate: the runtime would not weigh it");
  const fee = await args.api.apis.XcmPaymentApi.query_weight_to_asset_fee(weight.value, {
    type: "V5",
    value: args.pool.underlying,
  } as never);
  if (!fee.success) {
    throw new Error("teleport fee estimate: the underlying is not a priceable fee asset");
  }
  const localCash = fee.value;

  // The real forwarded program when available, the stand-in otherwise.
  const forwarded =
    (args.dryRunFrom === undefined
      ? null
      : await realForwardedProgram(args.api, built, args.peopleParaId, args.dryRunFrom)) ??
    forwardedTeleportStandIn(args.pool, args.amount, args.beneficiaryHex);
  const df = await args.api.apis.XcmPaymentApi.query_delivery_fees(
    { type: "V5", value: peopleDest(args.peopleParaId) } as never,
    forwarded as never,
    { type: "V5", value: NATIVE_HERE } as never,
  );
  if (!df.success) throw new Error("teleport fee estimate: delivery fee unavailable");
  const deliveryNative = extractNativeAmount(df.value);
  let deliveryCash = 0n;
  if (deliveryNative > 0n) {
    const quoted = await args.api.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens(
      args.pool.underlying,
      args.pool.native,
      deliveryNative,
      true,
    );
    if (quoted === undefined) {
      throw new Error("teleport fee estimate: the pool cannot price the delivery fee");
    }
    deliveryCash = quoted;
  }

  const payFeesCash = ((localCash + deliveryCash) * PAYFEES_MARGIN_NUM) / PAYFEES_MARGIN_DEN;
  return {
    localCash,
    deliveryCash,
    payFeesCash,
    maxWeight: {
      ref_time: (weight.value.ref_time * WEIGHT_MARGIN_NUM) / WEIGHT_MARGIN_DEN,
      proof_size: (weight.value.proof_size * WEIGHT_MARGIN_NUM) / WEIGHT_MARGIN_DEN,
    },
  };
}

/** The fungible amount out of a VersionedAssets delivery-fee result (its single native entry). */
function extractNativeAmount(versioned: unknown): bigint {
  const assets = (versioned as { value?: Array<{ fun?: { type?: string; value?: bigint } }> })
    .value;
  const first = Array.isArray(assets) ? assets[0] : undefined;
  return first?.fun?.type === "Fungible" ? BigInt(first.fun.value ?? 0n) : 0n;
}
