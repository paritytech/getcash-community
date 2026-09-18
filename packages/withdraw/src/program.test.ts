// The two withdrawal transactions' shapes, checked against a recording People api: what each call
// carries, and how CASH is keyed on each side.

import { describe, expect, it } from "vitest";
import { CASH_LOCATION } from "@getsome/people";
import { PEOPLE_NATIVE } from "./paseo";
import {
  buildSwap,
  buildWithdrawXcm,
  forwardedStandIn,
  WITHDRAW_XCM_MAX_WEIGHT,
  type PeopleApi,
} from "./program";

type Instruction = { type: string; value: unknown };
type Fungible = { id: unknown; fun: { type: string; value: bigint } };

/** A People api that records the arguments of the two calls. */
function recordingApi() {
  const seen: { swap?: unknown; execute?: unknown } = {};
  const api = {
    tx: {
      AssetConversion: {
        swap_tokens_for_exact_tokens: (args: unknown) => {
          seen.swap = args;
          return { decodedCall: { type: "AssetConversion", value: { type: "swap", value: args } } };
        },
      },
      PolkadotXcm: {
        execute: (args: unknown) => {
          seen.execute = args;
          return { decodedCall: { type: "PolkadotXcm", value: { type: "execute", value: args } } };
        },
      },
    },
  } as unknown as PeopleApi;
  return { api, seen };
}

const XCM = {
  cashToTeleport: 2_000_000n,
  pasToWithdraw: 958_441_000n,
  payFeesPas: 319_110_000n,
  remoteFeesCash: 300_000n,
  minPasOut: 700_000_000n,
  destinationHex: `0x${"aa".repeat(32)}`,
  claimerHex: `0x${"07".repeat(32)}`,
  assetHubParaId: 1500,
};

describe("withdrawal transactions", () => {
  it("swaps CASH, within a cap, for exactly the PAS the fees need, credited to the key without keeping it alive", () => {
    const { api, seen } = recordingApi();
    buildSwap(api, { keyAddress: "5Key", pasOut: 1_000_000_000n, cashInMax: 410_000n });
    expect(seen.swap).toEqual({
      path: [CASH_LOCATION, PEOPLE_NATIVE],
      amount_out: 1_000_000_000n,
      amount_in_max: 410_000n,
      send_to: "5Key",
      keep_alive: false,
    });
  });

  it("withdraws the PAS and CASH, pays People in PAS, and teleports both with the remote program", () => {
    const { api, seen } = recordingApi();
    buildWithdrawXcm(api, XCM);
    const execute = seen.execute as { message: { value: Instruction[] }; max_weight: unknown };
    expect(execute.max_weight).toEqual(WITHDRAW_XCM_MAX_WEIGHT);
    const [withdraw, payFees, transfer] = execute.message.value;
    expect(execute.message.value.map((i) => i.type)).toEqual([
      "WithdrawAsset",
      "PayFees",
      "InitiateTransfer",
    ]);
    const withdrawn = withdraw!.value as Fungible[];
    expect(withdrawn.map((a) => a.fun.value)).toEqual([XCM.pasToWithdraw, XCM.cashToTeleport]);
    expect(withdrawn[0]!.id).toEqual(PEOPLE_NATIVE);
    expect(withdrawn[1]!.id).toEqual(CASH_LOCATION);
    expect((payFees!.value as { asset: Fungible }).asset).toEqual({
      id: PEOPLE_NATIVE,
      fun: { type: "Fungible", value: XCM.payFeesPas },
    });
    const t = transfer!.value as {
      destination: { interior: { value: { value: number } } };
      remote_fees: { type: string; value: { value: Fungible[] } };
      preserve_origin: boolean;
      assets: Array<{ type: string; value: { value: { value: number } } }>;
      remote_xcm: Instruction[];
    };
    expect(t.destination.interior.value.value).toBe(1500);
    expect(t.remote_fees.type).toBe("Teleport");
    expect(t.remote_fees.value.value[0]).toEqual({
      id: CASH_LOCATION,
      fun: { type: "Fungible", value: XCM.remoteFeesCash },
    });
    expect(t.preserve_origin).toBe(false);
    expect(t.assets[0]!.value.value.value).toBe(2);
    expect(t.remote_xcm.map((i) => i.type)).toEqual([
      "SetHints",
      "RefundSurplus",
      "ExchangeAsset",
      "DepositAsset",
    ]);
  });

  it("declares the weight ceiling it is given", () => {
    const { api, seen } = recordingApi();
    const maxWeight = { ref_time: 2_358_560_232n, proof_size: 61_000n };
    buildWithdrawXcm(api, { ...XCM, maxWeight });
    expect((seen.execute as { max_weight: unknown }).max_weight).toEqual(maxWeight);
  });

  it("keys CASH as Asset Hub sees it inside the remote program, and names the claimer and destination", () => {
    const { api, seen } = recordingApi();
    buildWithdrawXcm(api, XCM);
    const execute = seen.execute as { message: { value: Instruction[] } };
    const transfer = execute.message.value[2]!.value as { remote_xcm: Instruction[] };
    const [hints, , exchange, deposit] = transfer.remote_xcm;
    const claimer = (
      hints!.value as {
        hints: Array<{ value: { location: { interior: { value: { value: { id: string } } } } } }>;
      }
    ).hints[0]!.value.location.interior.value.value.id;
    expect(claimer).toBe(XCM.claimerHex);
    const give = (
      exchange!.value as {
        give: { value: { value: { id: { parents: number; interior: { type: string } } } } };
      }
    ).give.value.value.id;
    // Local to Asset Hub: parents 0, the pallet and the asset index.
    expect(give.parents).toBe(0);
    expect(give.interior.type).toBe("X2");
    const want = (exchange!.value as { want: Fungible[]; maximal: boolean }).want[0]!;
    expect(want.fun.value).toBe(XCM.minPasOut);
    expect((exchange!.value as { maximal: boolean }).maximal).toBe(true);
    const beneficiary = (
      deposit!.value as { beneficiary: { interior: { value: { value: { id: string } } } } }
    ).beneficiary.interior.value.value.id;
    expect(beneficiary).toBe(XCM.destinationHex);
  });

  it("stands in for the forwarded message with the fee remainder travelling as PAS", () => {
    const standIn = forwardedStandIn(XCM);
    expect(standIn.value.map((i) => i.type)).toEqual([
      "ReceiveTeleportedAsset",
      "PayFees",
      "ReceiveTeleportedAsset",
      "ClearOrigin",
      "SetHints",
      "RefundSurplus",
      "ExchangeAsset",
      "DepositAsset",
      "SetTopic",
    ]);
    const travelling = standIn.value[2]!.value as Fungible[];
    expect(travelling.map((a) => a.fun.value)).toEqual([
      XCM.pasToWithdraw - XCM.payFeesPas,
      XCM.cashToTeleport,
    ]);
    // An allowance that takes every PAS leaves only the CASH travelling.
    const allSpent = forwardedStandIn({ ...XCM, payFeesPas: XCM.pasToWithdraw });
    expect((allSpent.value[2]!.value as Fungible[]).length).toBe(1);
  });
});
