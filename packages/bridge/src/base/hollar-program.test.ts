import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { decodeXcm, encodeXcm } from "../snowbridge/codec";
import { HOLLAR, hollarProgram, type HollarProgramInput } from "./hollar-program";

const ACCOUNT = `0x${"42".repeat(32)}`;
const INPUT: HollarProgramInput = {
  account: ACCOUNT,
  hollar: 49_900_000_000_000_000_000n,
  minimumUsdt: 49_401_000n,
  assetHubFeeUsdt: 75_700n,
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
const amount = (id: unknown, value: bigint) => ({ id, fun: { type: "Fungible", value } });
const all = (id: unknown) => ({
  type: "Wild",
  value: { type: "AllOf", value: { id, fun: { type: "Fungible", value: undefined } } },
});
const account = (network?: { type: string }) => ({
  parents: 0,
  interior: { type: "X1", value: { type: "AccountId32", value: { network, id: ACCOUNT } } },
});

describe("hollarProgram", () => {
  const program = hollarProgram(INPUT);

  it("names HOLLAR by the address of its token on Hydration", () => {
    expect(HOLLAR).toEqual({
      parents: 0,
      interior: {
        type: "X1",
        value: {
          type: "AccountKey20",
          value: { network: undefined, key: "0x531a654d1696ed52e7275a8cede955e82620f99a" },
        },
      },
    });
  });

  it("takes the HOLLAR, swaps all of it for at least the minimum, and sends all the USDT", () => {
    expect(program).toEqual([
      { type: "WithdrawAsset", value: [amount(HOLLAR, INPUT.hollar)] },
      {
        type: "ExchangeAsset",
        value: { give: all(HOLLAR), want: [amount(USDT, INPUT.minimumUsdt)], maximal: true },
      },
      {
        type: "InitiateTransfer",
        value: {
          destination: {
            parents: 1,
            interior: { type: "X1", value: { type: "Parachain", value: 1000 } },
          },
          remote_fees: {
            type: "ReserveWithdraw",
            value: { type: "Definite", value: [amount(USDT, INPUT.assetHubFeeUsdt)] },
          },
          preserve_origin: false,
          assets: [{ type: "ReserveWithdraw", value: all(USDT) }],
          remote_xcm: [
            {
              type: "SetHints",
              value: {
                hints: [
                  { type: "AssetClaimer", value: { location: account({ type: "Polkadot" }) } },
                ],
              },
            },
            { type: "RefundSurplus" },
            {
              type: "DepositAsset",
              value: {
                assets: { type: "Wild", value: { type: "AllCounted", value: 1 } },
                beneficiary: account(),
              },
            },
          ],
        },
      },
    ]);
  });

  it("has bytes that read back whole", async () => {
    const bytes = await encodeXcm(program);
    expect(bytesToHex(bytes.subarray(0, 2))).toBe("050c");
    expect(bytesToHex(await encodeXcm(await decodeXcm(bytes)))).toBe(bytesToHex(bytes));
  });

  it("refuses an account that is not 32 bytes", () => {
    expect(() => hollarProgram({ ...INPUT, account: "0x4242" })).toThrow("not an account");
  });

  it.each(["hollar", "minimumUsdt", "assetHubFeeUsdt"] as const)(
    "refuses %s of zero or less",
    (name) => {
      expect(() => hollarProgram({ ...INPUT, [name]: 0n })).toThrow(`${name} must be more`);
      expect(() => hollarProgram({ ...INPUT, [name]: -1n })).toThrow(`${name} must be more`);
    },
  );
});
