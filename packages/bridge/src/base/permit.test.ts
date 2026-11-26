// The permit: its signature against the same permit signed by another tool, the account of a key
// as the chain itself named it, and the bytes that submit it.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  hydrationAccountOf,
  permitDigest,
  permitExtrinsic,
  signPermit,
  type HydrationPermit,
} from "./permit";

/** The first key of the test mnemonic local nodes fund, and its address. */
const KEY = hexToBytes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const PERMIT: HydrationPermit = {
  from: ADDRESS,
  call: hexToBytes("0d0208cb00de000000"),
  gasLimit: 5_000_000n,
  nonce: 3n,
  deadline: 1_795_560_000n,
};

describe("signPermit", () => {
  it("signs as the other tool signs the same permit", () => {
    const { v, r, s } = signPermit(PERMIT, KEY);
    expect(v).toBe(28);
    expect(bytesToHex(r)).toBe("94ce8ca46023438fcf19e7844ab7770bbf601b55ada6923de4492bcc7b5e55d5");
    expect(bytesToHex(s)).toBe("798f7638b127a00f6821bfcb7cb3332c937593c90a9b30f9f0319ac79f9ab9fa");
  });

  it.each<[string, Partial<HydrationPermit>]>([
    ["another key's address", { from: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" }],
    ["another call", { call: hexToBytes("0d0208cb00de000001") }],
    ["another gas limit", { gasLimit: 5_000_001n }],
    ["another nonce", { nonce: 4n }],
    ["another deadline", { deadline: 1_795_560_001n }],
  ])("signs other bytes for %s", (_name, change) => {
    expect(bytesToHex(permitDigest({ ...PERMIT, ...change }))).not.toBe(
      bytesToHex(permitDigest(PERMIT)),
    );
  });

  it.each<[string, Partial<HydrationPermit>]>([
    ["a negative nonce", { nonce: -1n }],
    ["a deadline past 256 bits", { deadline: 1n << 256n }],
    ["an address that is not one", { from: "0x1234" }],
  ])("refuses %s", (_name, change) => {
    expect(() => permitDigest({ ...PERMIT, ...change })).toThrow();
  });

  it("takes the address in either case", () => {
    const upper = { ...PERMIT, from: "0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266" };
    expect(bytesToHex(permitDigest(upper))).toBe(bytesToHex(permitDigest(PERMIT)));
  });
});

describe("hydrationAccountOf", () => {
  it("gives the account Hydration itself named for an address", () => {
    expect(hydrationAccountOf("0x4378c5c9e59915a96bb5f5647e55951361ecc388")).toBe(
      "0x455448004378c5c9e59915a96bb5f5647e55951361ecc3880000000000000000",
    );
  });

  it("refuses what is not an address", () => {
    expect(() => hydrationAccountOf("0x1234")).toThrow("not an Ethereum address");
  });
});

describe("permitExtrinsic", () => {
  const signature = signPermit(PERMIT, KEY);

  it("writes the permit in the order the chain reads it", () => {
    expect(bytesToHex(permitExtrinsic(PERMIT, signature))).toBe(
      [
        // The length of what follows, an extrinsic that no account signs, and the call.
        "f902",
        "05",
        "cb04",
        // From the key's address, to the address that runs a call of the chain, with no value.
        "f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        "0000000000000000000000000000000000000401",
        "00".repeat(32),
        // The length of the call and the call.
        "24",
        "0d0208cb00de000000",
        // The gas limit and the deadline, the lowest byte first.
        "404b4c0000000000",
        `4012066b${"00".repeat(28)}`,
        // The signature.
        "1c",
        "94ce8ca46023438fcf19e7844ab7770bbf601b55ada6923de4492bcc7b5e55d5",
        "798f7638b127a00f6821bfcb7cb3332c937593c90a9b30f9f0319ac79f9ab9fa",
      ].join(""),
    );
  });

  it("has the length and the start that Hydration's own metadata gave for a call of 228 bytes", () => {
    const permit = { ...PERMIT, call: new Uint8Array(228) };
    const bytes = permitExtrinsic(permit, signPermit(permit, KEY));
    expect(bytes).toHaveLength(412);
    expect(bytesToHex(bytes.subarray(0, 5))).toBe("690605cb04");
  });

  it.each<[string, () => unknown]>([
    [
      "a signature part that is not 32 bytes",
      () => permitExtrinsic(PERMIT, { ...signature, r: new Uint8Array(31) }),
    ],
    [
      "a gas limit past 64 bits",
      () => permitExtrinsic({ ...PERMIT, gasLimit: 1n << 64n }, signature),
    ],
    ["a negative deadline", () => permitExtrinsic({ ...PERMIT, deadline: -1n }, signature)],
  ])("refuses %s", (_name, build) => {
    expect(build).toThrow();
  });
});
