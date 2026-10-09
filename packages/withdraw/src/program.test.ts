// The two withdrawal transactions' shapes, checked against a recording People api: what each call
// carries, how CASH is keyed on each side, and the sale per tier inside the remote program.

import { describe, expect, it } from "vitest";
import { CASH_LOCATION } from "@getsome/people";
import { PEOPLE_NATIVE } from "./paseo";
import {
  buildSwap,
  buildWithdrawXcm,
  CASH_ON_ASSET_HUB,
  forwardedStandIn,
  psmRedeemOut,
  WITHDRAW_XCM_MAX_WEIGHT,
  withdrawMessage,
  type PeopleApi,
  type Sale,
} from "./program";

type Instruction = { type: string; value: unknown };
type Fungible = { id: unknown; fun: { type: string; value: bigint } };
type Exchange = {
  give: { type: string; value: { type: string; value: { id: AssetLocation } } };
  want: Fungible[];
  maximal: boolean;
};
type AssetLocation = {
  parents: number;
  interior: { type: string; value?: Array<{ type: string; value: unknown }> };
};

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

const SALE: Sale = { tier: "pool", minNativeOut: 700_000_000n };
const XCM = {
  cashToSend: 2_000_000n,
  pasToWithdraw: 958_441_000n,
  payFeesPas: 319_110_000n,
  remoteFeesCash: 300_000n,
  sale: SALE,
  destinationHex: `0x${"aa".repeat(32)}`,
  claimerHex: `0x${"07".repeat(32)}`,
  assetHubParaId: 1500,
  peopleParaId: 1502,
  transfer: "teleport" as const,
};

/** The remote program of the message for `sale`. */
function remoteProgramFor(sale: Sale, destinationHex = XCM.destinationHex): Instruction[] {
  const transfer = withdrawMessage({ ...XCM, sale, destinationHex }).value[2]!.value as {
    remote_xcm: Instruction[];
  };
  return transfer.remote_xcm;
}

/** The instructions of the stand-in for the message People forwards. */
const standInOf = (args: Parameters<typeof forwardedStandIn>[0]): Instruction[] =>
  forwardedStandIn(args).value as Instruction[];

const depositCount = (deposit: Instruction) =>
  (deposit.value as { assets: { value: { value: number } } }).assets.value.value;
const beneficiaryOf = (deposit: Instruction) =>
  (deposit.value as { beneficiary: { interior: { value: { value: { id: string } } } } }).beneficiary
    .interior.value.value.id;

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
    expect(withdrawn.map((a) => a.fun.value)).toEqual([XCM.pasToWithdraw, XCM.cashToSend]);
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

  it("withdraws the CASH from People's reserve when the chains allow no teleport, the PAS still teleporting", () => {
    const { api, seen } = recordingApi();
    buildWithdrawXcm(api, { ...XCM, transfer: "reserve" });
    const execute = seen.execute as { message: { value: Instruction[] } };
    const t = execute.message.value[2]!.value as {
      remote_fees: { type: string; value: { type: string; value: Fungible[] } };
      assets: unknown;
    };
    expect(t.remote_fees.type).toBe("ReserveWithdraw");
    expect(t.remote_fees.value).toEqual({
      type: "Definite",
      value: [{ id: CASH_LOCATION, fun: { type: "Fungible", value: XCM.remoteFeesCash } }],
    });
    expect(t.assets).toEqual([
      {
        type: "Teleport",
        value: {
          type: "Wild",
          value: { type: "AllOf", value: { id: PEOPLE_NATIVE, fun: { type: "Fungible" } } },
        },
      },
      {
        type: "ReserveWithdraw",
        value: {
          type: "Wild",
          value: { type: "AllOf", value: { id: CASH_LOCATION, fun: { type: "Fungible" } } },
        },
      },
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
    const give = (exchange!.value as Exchange).give.value.value.id;
    // Local to Asset Hub: parents 0, the pallet and the asset index.
    expect(give.parents).toBe(0);
    expect(give.interior.type).toBe("X2");
    const want = (exchange!.value as Exchange).want[0]!;
    expect(want.fun.value).toBe(SALE.minNativeOut);
    expect((exchange!.value as Exchange).maximal).toBe(true);
    const beneficiary = (
      deposit!.value as { beneficiary: { interior: { value: { value: { id: string } } } } }
    ).beneficiary.interior.value.value.id;
    expect(beneficiary).toBe(XCM.destinationHex);
    expect(depositCount(deposit!)).toBe(2);
  });

  it("sells the native again for a stable on its pool, then deposits the three assets the holding can carry", () => {
    const program = remoteProgramFor({
      tier: "pool",
      external: "USDC",
      minNativeOut: 700_000_000n,
      minOut: 68_000n,
    });
    expect(program.map((i) => i.type)).toEqual([
      "SetHints",
      "RefundSurplus",
      "ExchangeAsset",
      "ExchangeAsset",
      "DepositAsset",
    ]);
    const [, , first, second, deposit] = program;
    expect((first!.value as Exchange).want[0]!.fun.value).toBe(700_000_000n);
    // The second hop gives every unit of the native the first bought, named so stable dust in
    // the holding cannot be picked, and wants USDC as Asset Hub keys it.
    const give = (second!.value as Exchange).give;
    expect(give.type).toBe("Wild");
    expect(give.value.type).toBe("AllOf");
    expect(give.value.value.id).toEqual({ parents: 1, interior: { type: "Here" } });
    const want = (second!.value as Exchange).want[0]!;
    expect(want.fun.value).toBe(68_000n);
    const index = (want.id as AssetLocation).interior.value![1]!;
    expect(index).toEqual({ type: "GeneralIndex", value: 1337n });
    expect((second!.value as Exchange).maximal).toBe(true);
    expect(depositCount(deposit!)).toBe(3);
  });

  it("keeps the CASH on the dotUSD tier and sells only the PAS that travelled for it", () => {
    const program = remoteProgramFor({ tier: "dotusd" });
    expect(program.map((i) => i.type)).toEqual([
      "SetHints",
      "RefundSurplus",
      "ExchangeAsset",
      "DepositAsset",
    ]);
    const hop = program[2]!.value as Exchange;
    expect(hop.give.value.value.id).toEqual({ parents: 1, interior: { type: "Here" } });
    expect(hop.want[0]!.id).toEqual(CASH_ON_ASSET_HUB);
    expect(hop.want[0]!.fun.value).toBe(1n);
    expect(depositCount(program[3]!)).toBe(2);
  });

  it("lands the CASH on the key itself on the PSM tier, the dotUSD program aimed there, with no origin kept", () => {
    const sale: Sale = { tier: "psm", external: "USDT", feeRate: 5_000 };
    const key = `0x${"0d".repeat(32)}`;
    const transfer = withdrawMessage({ ...XCM, sale, destinationHex: key }).value[2]!.value as {
      preserve_origin: boolean;
      remote_xcm: Instruction[];
    };
    expect(transfer.preserve_origin).toBe(false);
    expect(transfer.remote_xcm).toEqual(remoteProgramFor({ tier: "dotusd" }, key));
    expect(transfer.remote_xcm.map((i) => i.type)).toEqual([
      "SetHints",
      "RefundSurplus",
      "ExchangeAsset",
      "DepositAsset",
    ]);
    expect(beneficiaryOf(transfer.remote_xcm[3]!)).toBe(key);
    // The stand-in clears the origin on every tier.
    expect(standInOf({ ...XCM, sale })[3]).toEqual({ type: "ClearOrigin" });
    expect(standInOf(XCM)[3]).toEqual({ type: "ClearOrigin" });
  });

  it("pays a redeem out less the fee the PSM rounds up", () => {
    expect(psmRedeemOut(4_950_000n, 5_000)).toBe(4_925_250n);
    expect(psmRedeemOut(1_000_001n, 5_000)).toBe(1_000_001n - 5_001n);
  });

  it("stands in for the forwarded message with the fee remainder travelling as PAS", () => {
    const standIn = standInOf(XCM);
    expect(standIn.map((i) => i.type)).toEqual([
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
    const travelling = standIn[2]!.value as Fungible[];
    // The earmark comes out of the CASH, so less of it travels.
    expect(travelling.map((a) => a.fun.value)).toEqual([
      XCM.pasToWithdraw - XCM.payFeesPas,
      XCM.cashToSend - XCM.remoteFeesCash,
    ]);
    // An allowance that takes every PAS leaves only the CASH travelling.
    const allSpent = standInOf({ ...XCM, payFeesPas: XCM.pasToWithdraw });
    expect((allSpent[2]!.value as Fungible[]).length).toBe(1);
  });

  it("stands in for a reserve withdrawal with the CASH withdrawn on Asset Hub and the PAS received by teleport", () => {
    const standIn = standInOf({ ...XCM, transfer: "reserve" });
    expect(standIn.map((i) => i.type)).toEqual([
      "WithdrawAsset",
      "PayFees",
      "ReceiveTeleportedAsset",
      "WithdrawAsset",
      "ClearOrigin",
      "SetHints",
      "RefundSurplus",
      "ExchangeAsset",
      "DepositAsset",
      "SetTopic",
    ]);
    const [fee, , travellingPas, travellingCash] = standIn;
    expect(fee!.value).toEqual([
      { id: CASH_LOCATION, fun: { type: "Fungible", value: XCM.remoteFeesCash } },
    ]);
    expect(travellingPas!.value).toEqual([
      { id: PEOPLE_NATIVE, fun: { type: "Fungible", value: XCM.pasToWithdraw - XCM.payFeesPas } },
    ]);
    // The earmark was withdrawn first, so the rest is what travels.
    expect(travellingCash!.value).toEqual([
      { id: CASH_LOCATION, fun: { type: "Fungible", value: XCM.cashToSend - XCM.remoteFeesCash } },
    ]);
  });

  it("keeps the reserve withdrawal's shape when the allowance takes every PAS, the PAS arriving empty", () => {
    const allSpent = { ...XCM, transfer: "reserve" as const, payFeesPas: XCM.pasToWithdraw };
    const { api, seen } = recordingApi();
    buildWithdrawXcm(api, allSpent);
    const execute = seen.execute as { message: { value: Instruction[] } };
    const t = execute.message.value[2]!.value as { assets: unknown };
    expect(t.assets).toEqual([
      {
        type: "Teleport",
        value: {
          type: "Wild",
          value: { type: "AllOf", value: { id: PEOPLE_NATIVE, fun: { type: "Fungible" } } },
        },
      },
      {
        type: "ReserveWithdraw",
        value: {
          type: "Wild",
          value: { type: "AllOf", value: { id: CASH_LOCATION, fun: { type: "Fungible" } } },
        },
      },
    ]);
    const standIn = standInOf(allSpent);
    expect(standIn.slice(0, 4).map((i) => i.type)).toEqual([
      "WithdrawAsset",
      "PayFees",
      "ReceiveTeleportedAsset",
      "WithdrawAsset",
    ]);
    expect(standIn[2]!.value).toEqual([]);
  });
});
