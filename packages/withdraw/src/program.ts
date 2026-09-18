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
// exact allowance, and teleports both to Asset Hub. The program Asset Hub receives pays its own
// fees in CASH through the pool, exchanges the rest of the CASH for PAS in the holding, and
// deposits all the PAS to the destination account. It names an asset claimer so a trap on Asset
// Hub is recoverable.
//
// CASH is keyed two ways: as People holds it for the calls that run on People, and as Asset Hub
// holds it for the remote program, which is forwarded verbatim and so must speak Asset Hub's view.

import { paseo_people_next } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { CASH_LOCATION } from "@getsome/people";
import { PASEO_UNDERLYING_ASSET_ID } from "@getsome/funding";
import { PEOPLE_NATIVE } from "./paseo";

export type PeopleApi = TypedApi<typeof paseo_people_next>;

/** CASH as Asset Hub keys it: local to Asset Hub, so parents 0. The remote program filters on it. */
export const CASH_ON_ASSET_HUB = {
  parents: 0,
  interior: {
    type: "X2",
    value: [
      { type: "PalletInstance", value: 50 },
      { type: "GeneralIndex", value: BigInt(PASEO_UNDERLYING_ASSET_ID) },
    ],
  },
};

/** Fallback weight ceiling for the XCM, used when the runtime will not weigh it. */
export const WITHDRAW_XCM_MAX_WEIGHT = { ref_time: 5_000_000_000n, proof_size: 300_000n };

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

/** The program Asset Hub runs on arrival: claim hint, refund, sell all the CASH for at least
 *  `minPasOut`, deposit everything to the destination. Keyed as Asset Hub sees CASH. */
function remoteProgram(destinationHex: string, claimerHex: string, minPasOut: bigint) {
  return [
    {
      type: "SetHints",
      value: { hints: [{ type: "AssetClaimer", value: { location: account(claimerHex) } }] },
    },
    { type: "RefundSurplus" },
    {
      type: "ExchangeAsset",
      value: {
        give: {
          type: "Wild",
          value: { type: "AllOf", value: { id: CASH_ON_ASSET_HUB, fun: { type: "Fungible" } } },
        },
        want: [fungible({ parents: 1, interior: { type: "Here" } }, minPasOut)],
        maximal: true,
      },
    },
    {
      type: "DepositAsset",
      value: {
        assets: { type: "Wild", value: { type: "AllCounted", value: 2 } },
        beneficiary: account(destinationHex),
      },
    },
  ];
}

export interface WithdrawXcmArgs {
  /** All the CASH the key holds after the swap. */
  cashToTeleport: bigint;
  /** The PAS the XCM withdraws: what the key holds less the transaction fee and its margin. */
  pasToWithdraw: bigint;
  /** People's XCM fee allowance, in PAS. The unspent part travels on with the rest. */
  payFeesPas: bigint;
  /** The CASH the destination fee earmark carries on Asset Hub. */
  remoteFeesCash: bigint;
  /** The least PAS the sale on Asset Hub may return; a worse price fails the program there. */
  minPasOut: bigint;
  /** The account the PAS lands on, Asset Hub public key hex. */
  destinationHex: string;
  /** The account that may claim a trap on Asset Hub, public key hex. */
  claimerHex: string;
  assetHubParaId: number;
  /** The XCM weight ceiling; defaults to WITHDRAW_XCM_MAX_WEIGHT. */
  maxWeight?: { ref_time: bigint; proof_size: bigint };
}

/** The XCM message alone, for weighing and dry runs. */
export function withdrawMessage(args: WithdrawXcmArgs) {
  return {
    type: "V5",
    value: [
      { type: "WithdrawAsset", value: [pas(args.pasToWithdraw), cash(args.cashToTeleport)] },
      { type: "PayFees", value: { asset: pas(args.payFeesPas) } },
      {
        type: "InitiateTransfer",
        value: {
          destination: assetHubDest(args.assetHubParaId),
          remote_fees: {
            type: "Teleport",
            value: { type: "Definite", value: [cash(args.remoteFeesCash)] },
          },
          preserve_origin: false,
          // Both assets teleport: the PAS the fees leave and all the CASH.
          assets: [
            { type: "Teleport", value: { type: "Wild", value: { type: "AllCounted", value: 2 } } },
          ],
          remote_xcm: remoteProgram(args.destinationHex, args.claimerHex, args.minPasOut),
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

/** The message People forwards to Asset Hub for `args`, as the runtime would build it, with the
 *  fee allowance's remainder as the PAS that travels. Used to price the delivery before the
 *  runtime produces the real one. */
export function forwardedStandIn(args: WithdrawXcmArgs) {
  const pasLeft = args.pasToWithdraw - args.payFeesPas;
  return {
    type: "V5",
    value: [
      { type: "ReceiveTeleportedAsset", value: [cash(args.remoteFeesCash)] },
      { type: "PayFees", value: { asset: cash(args.remoteFeesCash) } },
      {
        type: "ReceiveTeleportedAsset",
        value:
          pasLeft > 0n ? [pas(pasLeft), cash(args.cashToTeleport)] : [cash(args.cashToTeleport)],
      },
      { type: "ClearOrigin" },
      ...remoteProgram(args.destinationHex, args.claimerHex, args.minPasOut),
      { type: "SetTopic", value: `0x${"00".repeat(32)}` },
    ],
  };
}
