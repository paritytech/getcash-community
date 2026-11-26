// The Snowbridge program: what it tells each chain to do, and its bytes. The bytes below are the
// ones of the program that dry runs on Asset Hub and Hydration completed with.

import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { decodeXcm, encodeXcm, type XcmInstruction } from "./codec";
import { ETHER, snowbridgeProgram, type SnowbridgeProgramInput } from "./program";

const ACCOUNT = `0x${"42".repeat(32)}`;

const INPUT: SnowbridgeProgramInput = {
  account: ACCOUNT,
  swapEther: 10_000_000_000_000_000n,
  hydrationFeeEther: 200_000_000_000_000n,
  minimumUsdt: 17_000_000n,
  assetHubFeeUsdt: 200_000n,
  assetHubFeeEther: 60_000_000_000_000n,
};

const USDT = {
  parents: 1,
  interior: {
    type: "X3",
    value: [
      { type: "Parachain", value: 1000 },
      { type: "PalletInstance", value: 50 },
      { type: "GeneralIndex", value: 1984n },
    ],
  },
};
const parachain = (id: number) => ({
  parents: 1,
  interior: { type: "X1", value: { type: "Parachain", value: id } },
});
const amount = (id: unknown, value: bigint) => ({ id, fun: { type: "Fungible", value } });
const all = (id: unknown) => ({
  type: "Wild",
  value: { type: "AllOf", value: { id, fun: { type: "Fungible", value: undefined } } },
});
const account = (network?: { type: string }) => ({
  parents: 0,
  interior: { type: "X1", value: { type: "AccountId32", value: { network, id: ACCOUNT } } },
});
const claimer = {
  type: "SetHints",
  value: {
    hints: [{ type: "AssetClaimer", value: { location: account({ type: "Polkadot" }) } }],
  },
};
/** What Asset Hub runs for an asset that Hydration sends back. */
const deposit = [
  claimer,
  { type: "RefundSurplus" },
  {
    type: "DepositAsset",
    value: {
      assets: { type: "Wild", value: { type: "AllCounted", value: 1 } },
      beneficiary: account(),
    },
  },
];

type Transfer = { type: string; value: { remote_xcm: XcmInstruction[] } & Record<string, unknown> };

describe("snowbridgeProgram", () => {
  const program = snowbridgeProgram(INPUT);
  const toHydration = program[0] as Transfer;
  const onHydration = toHydration.value.remote_xcm;

  it("sends the ether to Hydration and gives the account what Asset Hub does not use", () => {
    expect(program.map((instruction) => instruction.type)).toEqual([
      "InitiateTransfer",
      "RefundSurplus",
      "DepositAsset",
    ]);
    expect(toHydration.value).toMatchObject({
      destination: parachain(2034),
      remote_fees: {
        type: "ReserveDeposit",
        value: { type: "Definite", value: [amount(ETHER, INPUT.hydrationFeeEther)] },
      },
      preserve_origin: false,
      assets: [
        {
          type: "ReserveDeposit",
          value: { type: "Definite", value: [amount(ETHER, INPUT.swapEther)] },
        },
      ],
    });
    expect(program[2]).toEqual({
      type: "DepositAsset",
      value: { assets: all(ETHER), beneficiary: account() },
    });
  });

  it("names the account as the claimer on Hydration before anything can fail", () => {
    expect(onHydration.map((instruction) => instruction.type)).toEqual([
      "SetHints",
      "SetErrorHandler",
      "ExchangeAsset",
      "InitiateTransfer",
    ]);
    expect(onHydration[0]).toEqual(claimer);
  });

  it("swaps all the ether for at least the minimum of USDT", () => {
    expect(onHydration[2]).toEqual({
      type: "ExchangeAsset",
      value: { give: all(ETHER), want: [amount(USDT, INPUT.minimumUsdt)], maximal: true },
    });
  });

  it("sends the USDT to the account on Asset Hub, with a fee in USDT", () => {
    expect(onHydration[3]).toEqual({
      type: "InitiateTransfer",
      value: {
        destination: parachain(1000),
        remote_fees: {
          type: "ReserveWithdraw",
          value: { type: "Definite", value: [amount(USDT, INPUT.assetHubFeeUsdt)] },
        },
        preserve_origin: false,
        assets: [{ type: "ReserveWithdraw", value: all(USDT) }],
        remote_xcm: deposit,
      },
    });
  });

  it("sends the ether to the account on Asset Hub when the swap fails, with a fee in ether", () => {
    expect(onHydration[1]).toEqual({
      type: "SetErrorHandler",
      value: [
        {
          type: "InitiateTransfer",
          value: {
            destination: parachain(1000),
            remote_fees: {
              type: "ReserveWithdraw",
              value: { type: "Definite", value: [amount(ETHER, INPUT.assetHubFeeEther)] },
            },
            preserve_origin: false,
            assets: [{ type: "ReserveWithdraw", value: all(ETHER) }],
            remote_xcm: deposit,
          },
        },
      ],
    });
  });

  it("has the bytes of the program the dry runs completed with", async () => {
    expect(bytesToHex(await encodeXcm(program))).toBe(
      "050c31010100c91f010100040201090704000b0080f420e6b500040100040201090704000f0000c16ff286231033040000010101024242424242424242424242424242424242424242424242424242424242424242150431010100a10f010200040201090704000b00c0afd6913600040201010201090704000c33040000010101024242424242424242424242424242424242424242424242424242424242424242140d0102040001010042424242424242424242424242424242424242424242424242424242424242420f010102010907040004010300a10f043205011f0002990d040131010100a10f01020004010300a10f043205011f0002350c000004020101010300a10f043205011f000c33040000010101024242424242424242424242424242424242424242424242424242424242424242140d010204000101004242424242424242424242424242424242424242424242424242424242424242140d0101020109070400000101004242424242424242424242424242424242424242424242424242424242424242",
    );
  });

  it("decodes back as one whole version 5 program", async () => {
    const bytes = await encodeXcm(program);
    expect(bytesToHex(await encodeXcm(await decodeXcm(bytes)))).toBe(bytesToHex(bytes));
  });

  it.each(["0x4242", `0x${"42".repeat(33)}`, "42".repeat(32), `0x${"zz".repeat(32)}`])(
    "refuses %s as the account",
    (bad) => {
      expect(() => snowbridgeProgram({ ...INPUT, account: bad })).toThrow("not an account");
    },
  );

  it.each([
    "swapEther",
    "hydrationFeeEther",
    "minimumUsdt",
    "assetHubFeeUsdt",
    "assetHubFeeEther",
  ] as const)("refuses %s of zero or less", (name) => {
    expect(() => snowbridgeProgram({ ...INPUT, [name]: 0n })).toThrow(`${name} must be more`);
    expect(() => snowbridgeProgram({ ...INPUT, [name]: -1n })).toThrow(`${name} must be more`);
  });
});
