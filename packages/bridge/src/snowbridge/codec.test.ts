import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { decodeXcm, encodeXcm, type XcmInstruction } from "./codec";

const ACCOUNT = `0x${"42".repeat(32)}`;

/** Two instructions with every kind of value in them: a variant with no content, numbers, a list
 *  and the 32 bytes of an account. */
const PROGRAM: XcmInstruction[] = [
  { type: "RefundSurplus" },
  {
    type: "DepositAsset",
    value: {
      assets: { type: "Wild", value: { type: "AllCounted", value: 1 } },
      beneficiary: {
        parents: 0,
        interior: {
          type: "X1",
          value: { type: "AccountId32", value: { network: undefined, id: ACCOUNT } },
        },
      },
    },
  },
];
const PROGRAM_BYTES = `0508140d0102040001010042${"42".repeat(31)}`;

describe("encodeXcm", () => {
  it("writes the version, the number of instructions and each instruction", async () => {
    expect(bytesToHex(await encodeXcm([]))).toBe("0500");
    expect(bytesToHex(await encodeXcm([{ type: "RefundSurplus" }]))).toBe("050414");
    expect(bytesToHex(await encodeXcm(PROGRAM))).toBe(PROGRAM_BYTES);
  });
});

describe("decodeXcm", () => {
  it("reads back the program it was given", async () => {
    expect(await decodeXcm(hexToBytes("0500"))).toEqual([]);
    const decoded = await decodeXcm(hexToBytes(PROGRAM_BYTES));
    expect(decoded.map((instruction) => instruction.type)).toEqual([
      "RefundSurplus",
      "DepositAsset",
    ]);
    expect(bytesToHex(await encodeXcm(decoded))).toBe(PROGRAM_BYTES);
  });

  it("refuses a version that is not 5", async () => {
    await expect(decodeXcm(hexToBytes("0400"))).rejects.toThrow("V4, not V5");
  });

  it.each(["00", "ff", "0500"])("refuses the bytes %s after the program", async (extra) => {
    await expect(decodeXcm(hexToBytes(PROGRAM_BYTES + extra))).rejects.toThrow("not one whole");
  });

  it.each([1, 2, 31, 32, 33, 40])("refuses a program cut short by %d bytes", async (cut) => {
    const short = PROGRAM_BYTES.slice(0, -2 * cut);
    await expect(decodeXcm(hexToBytes(short))).rejects.toThrow();
  });

  it("refuses no bytes at all", async () => {
    await expect(decodeXcm(new Uint8Array(0))).rejects.toThrow();
  });
});
