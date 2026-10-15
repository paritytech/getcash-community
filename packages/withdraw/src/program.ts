// The two transactions a withdrawal signs on People, and the pieces that size them.
//
// People has no XCM exchanger, so the PAS the XCM fees need is bought first with a pallet swap,
// paid for in CASH. The XCM comes second and pays its transaction fee in that PAS. The order is
// what makes the CASH exact: a transaction fee is charged before its calls run and is only known
// to the unit at inclusion, so the asset that pays it cannot also be withdrawn to the unit in the
// same transaction. Paying the second fee in PAS moves that uncertainty onto an asset whose
// remainder, below the existential deposit, the chain reaps with the account. The CASH the XCM
// withdraws is the balance read after the swap, all of it.
//
// The XCM withdraws the PAS and the CASH, pays People's execution and delivery fees in PAS with an
// exact allowance, and sends both to Asset Hub: the PAS by teleport, the CASH by teleport or by
// reserve withdrawal as the network's XCM trust allows (CashTransfer). The program Asset Hub
// receives pays its own fees in CASH through the pool, makes the sale the destination asks for in
// the holding, and deposits everything to the destination account. The sale follows the on-ramp's
// tiers the other way round: the pool sells the CASH for PAS, and for a stable sells that PAS
// again on the stable's pool; the PSM redeems the CASH for its stable one to one less the
// redemption fee; the dotUSD tier keeps the CASH and lands it as it is. Whatever the tier, the PAS
// that travelled with the CASH ends up in the landing asset too, so one asset is deposited. The
// program names an asset claimer so a trap on Asset Hub is recoverable.
//
// The PSM redeem is a signed call, so the XCM keeps the key's origin across the hop: on Asset Hub
// the origin is the key's account under People, which has an account of its own there. The CASH
// to redeem is deposited to that account, the redeem runs as it, and the stable it receives is
// withdrawn back into the holding. The fee refund and the PAS that travelled are then sold for the
// stable too, so everything lands in one asset.
//
// CASH is keyed two ways: as People holds it for the calls that run on People, and as Asset Hub
// holds it for the remote program, which is forwarded verbatim and so must speak Asset Hub's view.

import { paseo_people_next } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { TOKENS } from "@getsome/core";
import { permillMulCeil, STABLE_TOKENS, type CashTransfer, type Stable } from "@getsome/funding";
import { CASH_LOCATION } from "@getsome/people";
import { PEOPLE_NATIVE } from "./paseo";

export type PeopleApi = TypedApi<typeof paseo_people_next>;

/** CASH as Asset Hub keys it: local to Asset Hub, so parents 0. The remote program filters on it. */
export const CASH_ON_ASSET_HUB = TOKENS.CASH.location;

/** The native as Asset Hub keys it: the relay token, one hop up. */
const NATIVE_ON_ASSET_HUB = TOKENS.PAS.location;

/** Fallback weight ceiling for the XCM, used when the runtime will not weigh it. */
export const WITHDRAW_XCM_MAX_WEIGHT = { ref_time: 5_000_000_000n, proof_size: 300_000n };

/**
 * The sale the forwarded program makes on Asset Hub, with the floors it is held to. A worse
 * price than a floor fails the program there, and nothing lands.
 */
export type Sale =
  /** All the CASH for the native, at least `minNativeOut`. */
  | { tier: "pool"; external?: undefined; minNativeOut: bigint }
  /** All the CASH for the native, then all the native for the stable, at least `minOut`. */
  | { tier: "pool"; external: Stable; minNativeOut: bigint; minOut: bigint }
  /** `redeemAmount` of CASH through the PSM for `externalOut` of the stable, as the key's own
   *  account on Asset Hub, `holderHex`, with the redeem call encoded for that chain. */
  | {
      tier: "psm";
      external: Stable;
      feeRate: number;
      redeemAmount: bigint;
      externalOut: bigint;
      holderHex: string;
      call: Uint8Array;
    }
  /** No sale of the CASH: it lands as it is, with the PAS that travelled sold for it. */
  | { tier: "dotusd" };

/** The stable a redeem of `cashIn` CASH pays out: the amount less the fee the PSM rounds up. */
export function psmRedeemOut(cashIn: bigint, feeRate: number): bigint {
  return cashIn - permillMulCeil(cashIn, feeRate);
}

const fungible = (id: unknown, value: bigint) => ({ id, fun: { type: "Fungible", value } });
const cash = (v: bigint) => fungible(CASH_LOCATION, v);
const pas = (v: bigint) => fungible(PEOPLE_NATIVE, v);

const account = (hex: string) => ({
  parents: 0,
  interior: {
    type: "X1",
    // papi encodes fixed-size binaries from their hex-string form; a raw Uint8Array mis-encodes.
    value: { type: "AccountId32", value: { network: undefined, id: hex } },
  },
});

const assetHubDest = (assetHubParaId: number) => ({
  parents: 1,
  interior: { type: "X1", value: { type: "Parachain", value: assetHubParaId } },
});

/** The key's origin as Asset Hub sees it: its account under People. */
export const originOnAssetHub = (peopleParaId: number, originHex: string) => ({
  parents: 1,
  interior: {
    type: "X2",
    value: [
      { type: "Parachain", value: peopleParaId },
      { type: "AccountId32", value: { network: undefined, id: originHex } },
    ],
  },
});

/** Every unit of one asset in the holding. */
const allOf = (id: unknown) => ({
  type: "Wild",
  value: { type: "AllOf", value: { id, fun: { type: "Fungible" } } },
});

/** One hop on a pool: give every unit of one asset, take at least the floor of another. */
const exchange = (give: unknown, want: unknown) => ({
  type: "ExchangeAsset",
  value: { give, want: [want], maximal: true },
});

const deposit = (assets: unknown, beneficiaryHex: string) => ({
  type: "DepositAsset",
  value: { assets, beneficiary: account(beneficiaryHex) },
});

const allCounted = (count: number) => ({
  type: "Wild",
  value: { type: "AllCounted", value: count },
});

export interface SwapArgs {
  /** The key that signs and receives the PAS, SS58. */
  keyAddress: string;
  /** PAS to buy; at least People's existential deposit, since the pool refuses less. */
  pasOut: bigint;
  /** The most CASH the swap may spend. What it does not spend stays and leaves with the XCM. */
  cashInMax: bigint;
}

/** The swap: CASH for an exact amount of PAS, credited to the key. Paid for in CASH. */
export function buildSwap(peopleApi: PeopleApi, args: SwapArgs) {
  return peopleApi.tx.AssetConversion.swap_tokens_for_exact_tokens({
    path: [CASH_LOCATION, PEOPLE_NATIVE],
    amount_out: args.pasOut,
    amount_in_max: args.cashInMax,
    send_to: args.keyAddress,
    keep_alive: false,
  } as never);
}

/** The program Asset Hub runs on arrival: claim hint, the sale, deposit everything to the
 *  destination. Keyed as Asset Hub sees the assets. The pool tiers refund the fee surplus into
 *  the sale; the PSM tier redeems a fixed amount as the key's account, then sells the surplus
 *  and the PAS that travelled for the stable, so the deposit is one asset. Each deposit counts
 *  what the holding can carry by then. */
function remoteProgram(destinationHex: string, claimerHex: string, sale: Sale) {
  const hints = {
    type: "SetHints",
    value: { hints: [{ type: "AssetClaimer", value: { location: account(claimerHex) } }] },
  };
  if (sale.tier === "psm") {
    const stable = STABLE_TOKENS[sale.external].location;
    return [
      hints,
      deposit(
        { type: "Definite", value: [fungible(CASH_ON_ASSET_HUB, sale.redeemAmount)] },
        sale.holderHex,
      ),
      {
        type: "Transact",
        value: {
          origin_kind: { type: "SovereignAccount" },
          fallback_max_weight: undefined,
          call: sale.call,
        },
      },
      // A refused redeem fails the program here, named as such, rather than at the withdrawal
      // of a stable the account never received.
      { type: "ExpectTransactStatus", value: { type: "Success" } },
      { type: "WithdrawAsset", value: [fungible(stable, sale.externalOut)] },
      { type: "RefundSurplus" },
      exchange(allOf(CASH_ON_ASSET_HUB), fungible(NATIVE_ON_ASSET_HUB, 1n)),
      exchange(allOf(NATIVE_ON_ASSET_HUB), fungible(stable, 1n)),
      deposit(allCounted(2), destinationHex),
    ];
  }
  // The dotUSD tier keeps the CASH and sells only the PAS that travelled, dust at any price, so
  // the destination gets dotUSD alone and never a native deposit it may be too small for.
  const hops =
    sale.tier === "dotusd"
      ? [exchange(allOf(NATIVE_ON_ASSET_HUB), fungible(CASH_ON_ASSET_HUB, 1n))]
      : [
          exchange(allOf(CASH_ON_ASSET_HUB), fungible(NATIVE_ON_ASSET_HUB, sale.minNativeOut)),
          ...(sale.external === undefined
            ? []
            : [
                exchange(
                  allOf(NATIVE_ON_ASSET_HUB),
                  fungible(STABLE_TOKENS[sale.external].location, sale.minOut),
                ),
              ]),
        ];
  return [
    hints,
    { type: "RefundSurplus" },
    ...hops,
    deposit(allCounted(hops.length === 2 ? 3 : 2), destinationHex),
  ];
}

export interface WithdrawXcmArgs {
  /** All the CASH the key holds after the swap. */
  cashToSend: bigint;
  /** The PAS the XCM withdraws: what the key holds less the transaction fee and its margin. */
  pasToWithdraw: bigint;
  /** People's XCM fee allowance, in PAS. The unspent part travels on with the rest. */
  payFeesPas: bigint;
  /** The CASH the destination fee earmark carries on Asset Hub. */
  remoteFeesCash: bigint;
  /** The sale on Asset Hub and its floors. */
  sale: Sale;
  /** The account the funds land on, Asset Hub public key hex. */
  destinationHex: string;
  /** The account that may claim a trap on Asset Hub, public key hex. */
  claimerHex: string;
  /** The key that signs the XCM, public key hex: the origin the PSM tier keeps across the hop. */
  originHex: string;
  assetHubParaId: number;
  peopleParaId: number;
  /** How the CASH moves to Asset Hub. */
  transfer: CashTransfer;
  /** The XCM weight ceiling; defaults to WITHDRAW_XCM_MAX_WEIGHT. */
  maxWeight?: { ref_time: bigint; proof_size: bigint };
}

/** The transfer's asset filters: the PAS the fees leave and all the CASH. The PAS always
 *  teleports, since the relay token moves between system chains by teleport everywhere; only the
 *  CASH follows `transfer`. A teleport takes both in one filter. A reserve withdrawal names each,
 *  the PAS filter present even when the allowance leaves none: the message is weighed once,
 *  before the PAS left over is known, so its shape must not depend on the amounts. */
function transferFilters(args: WithdrawXcmArgs) {
  if (args.transfer === "teleport") {
    return [{ type: "Teleport", value: allCounted(2) }];
  }
  return [
    { type: "Teleport", value: allOf(PEOPLE_NATIVE) },
    { type: "ReserveWithdraw", value: allOf(CASH_LOCATION) },
  ];
}

/** The XCM message alone, for weighing and dry runs. */
export function withdrawMessage(args: WithdrawXcmArgs) {
  return {
    type: "V5",
    value: [
      { type: "WithdrawAsset", value: [pas(args.pasToWithdraw), cash(args.cashToSend)] },
      { type: "PayFees", value: { asset: pas(args.payFeesPas) } },
      {
        type: "InitiateTransfer",
        value: {
          destination: assetHubDest(args.assetHubParaId),
          remote_fees: {
            type: args.transfer === "teleport" ? "Teleport" : "ReserveWithdraw",
            value: { type: "Definite", value: [cash(args.remoteFeesCash)] },
          },
          // The PSM tier redeems as the key, so its origin travels; the others need none.
          preserve_origin: args.sale.tier === "psm",
          assets: transferFilters(args),
          remote_xcm: remoteProgram(args.destinationHex, args.claimerHex, args.sale),
        },
      },
    ],
  };
}

/** The XCM transaction. Paid for in PAS. */
export function buildWithdrawXcm(peopleApi: PeopleApi, args: WithdrawXcmArgs) {
  return peopleApi.tx.PolkadotXcm.execute({
    message: withdrawMessage(args),
    max_weight: args.maxWeight ?? WITHDRAW_XCM_MAX_WEIGHT,
  } as never);
}

/** The instructions that land the assets on Asset Hub, one per filter of the transfer in filter
 *  order, the fee's first with its PayFees: teleported assets arrive by ReceiveTeleportedAsset,
 *  reserve-withdrawn CASH by WithdrawAsset from People's account there. The earmark comes out of
 *  the CASH, so less of it travels. A reserve withdrawal's PAS filter stays when no PAS is left,
 *  so its ReceiveTeleportedAsset arrives empty. */
function arrivals(args: WithdrawXcmArgs) {
  const pasLeft = args.pasToWithdraw - args.payFeesPas;
  const cashLeft = cash(args.cashToSend - args.remoteFeesCash);
  if (args.transfer === "teleport") {
    return [
      { type: "ReceiveTeleportedAsset", value: [cash(args.remoteFeesCash)] },
      { type: "PayFees", value: { asset: cash(args.remoteFeesCash) } },
      {
        type: "ReceiveTeleportedAsset",
        value: pasLeft > 0n ? [pas(pasLeft), cashLeft] : [cashLeft],
      },
    ];
  }
  return [
    { type: "WithdrawAsset", value: [cash(args.remoteFeesCash)] },
    { type: "PayFees", value: { asset: cash(args.remoteFeesCash) } },
    { type: "ReceiveTeleportedAsset", value: pasLeft > 0n ? [pas(pasLeft)] : [] },
    { type: "WithdrawAsset", value: [cashLeft] },
  ];
}

/** The message People forwards to Asset Hub for `args`, as the runtime would build it, with the
 *  fee allowance's remainder as the PAS that travels. Used to price the delivery before the
 *  runtime produces the real one. The PSM tier keeps the key's origin, the others clear it. */
export function forwardedStandIn(args: WithdrawXcmArgs) {
  return {
    type: "V5",
    value: [
      ...arrivals(args),
      args.sale.tier === "psm"
        ? { type: "AliasOrigin", value: originOnAssetHub(args.peopleParaId, args.originHex) }
        : { type: "ClearOrigin" },
      ...remoteProgram(args.destinationHex, args.claimerHex, args.sale),
      { type: "SetTopic", value: `0x${"00".repeat(32)}` },
    ],
  };
}
