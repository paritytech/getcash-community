// The call encoder against call data made by another tool for the same functions and arguments,
// and the reading of returned words.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  abiAddress,
  abiBytes,
  abiBytesList,
  abiUint,
  abiWord,
  addressBytes,
  encodeCall,
  selector,
  wordAt,
  type AbiArgument,
} from "./evm-abi";

const hex = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;
const bytes = (value: string): Uint8Array => hexToBytes(value);

const ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SEND = "v2_sendMessage(bytes,bytes[],bytes,uint128,uint128)";

describe("addressBytes", () => {
  it("reads an address in either case", () => {
    expect(hex(addressBytes("0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266"))).toBe(ACCOUNT);
  });

  it.each([
    "f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "0xf39f",
    "0xzz9fd6e51aad88f6f4ce6ab8827279cfffb92266",
  ])("refuses %s", (address) => {
    expect(() => addressBytes(address)).toThrow("not an Ethereum address");
  });
});

describe("selector", () => {
  it.each<[string, string]>([
    ["transfer(address,uint256)", "0xa9059cbb"],
    ["balanceOf(address)", "0x70a08231"],
    [SEND, "0xf2e500b2"],
  ])("names %s", (signature, expected) => {
    expect(hex(selector(signature))).toBe(expected);
  });
});

describe("encodeCall", () => {
  it.each<[string, string, AbiArgument[], string]>([
    [
      "a call with no arguments",
      "depositsPaused()",
      [],
      "0x" + bytesToHex(selector("depositsPaused()")),
    ],
    [
      "an address and a number",
      "transfer(address,uint256)",
      [abiAddress(ACCOUNT), abiUint(1_000_000n)],
      "0xa9059cbb000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000000000000000000f4240",
    ],
    [
      "a struct of seven fixed fields, passed field by field",
      "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
      [
        abiAddress(WETH),
        abiAddress(USDC),
        abiUint(500n),
        abiAddress(ACCOUNT),
        abiUint(50_000_000_000_000_000n),
        abiUint(84_000_000n),
        abiUint(0n),
      ],
      "0x04e45aaf0000000000000000000000004200000000000000000000000000000000000006000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000000000b1a2bc2ec50000000000000000000000000000000000000000000000000000000000000501bd000000000000000000000000000000000000000000000000000000000000000000",
    ],
    [
      "bytes of exactly one word",
      "getL1Fee(bytes)",
      [abiBytes(bytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"))],
      "0x49948e0e00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    ],
    [
      "bytes, a list of bytes, bytes and two numbers",
      SEND,
      [
        abiBytes(bytes("aabbcc")),
        abiBytesList([bytes("01"), bytes("0203")]),
        abiBytes(bytes("dd")),
        abiUint(5n),
        abiUint(7n),
      ],
      "0xf2e500b200000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000003aabbcc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000010100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000202030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001dd00000000000000000000000000000000000000000000000000000000000000",
    ],
    [
      "empty bytes, an empty list and bytes longer than one word",
      SEND,
      [
        abiBytes(new Uint8Array(0)),
        abiBytesList([]),
        abiBytes(bytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021")),
        abiUint(300_000_000_000_000n),
        abiUint(100_000_000_000_000n),
      ],
      "0xf2e500b200000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000110d9316ec00000000000000000000000000000000000000000000000000000005af3107a4000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000022000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021000000000000000000000000000000000000000000000000000000000000",
    ],
  ])("encodes %s as the other tool does", (_name, signature, args, expected) => {
    expect(hex(encodeCall(signature, args))).toBe(expected);
  });

  it("passes a value of 32 bytes through as one word", () => {
    const word = bytes("00000000000000000000000042424242424242424242424242424242424242ff");
    expect(hex(encodeCall("deposit(uint256,bytes32)", [abiUint(1n), abiWord(word)]))).toBe(
      `0x${bytesToHex(selector("deposit(uint256,bytes32)"))}${"0".repeat(63)}1${bytesToHex(word)}`,
    );
  });

  it("takes the largest number a word holds", () => {
    const encoded = encodeCall("f(uint256)", [abiUint((1n << 256n) - 1n)]);
    expect(hex(encoded.subarray(4))).toBe(`0x${"f".repeat(64)}`);
  });

  it.each<[string, () => unknown, string]>([
    ["a negative number", () => abiUint(-1n), "does not fit"],
    ["a number past one word", () => abiUint(1n << 256n), "does not fit"],
    ["a word of the wrong length", () => abiWord(new Uint8Array(31)), "32 bytes"],
    [
      "a word argument of the wrong length",
      () => encodeCall("f(uint256)", [{ kind: "word", value: new Uint8Array(33) }]),
      "32 bytes",
    ],
    ["an address that is not one", () => abiAddress("0x1234"), "not an Ethereum address"],
  ])("refuses %s", (_name, build, message) => {
    expect(build).toThrow(message);
  });
});

describe("wordAt", () => {
  const returned = bytes(`${"0".repeat(62)}2a${"0".repeat(56)}0515ad65`);

  it("reads the words a call returned", () => {
    expect(wordAt(returned, 0)).toBe(42n);
    expect(wordAt(returned, 1)).toBe(85_306_725n);
  });

  it.each([2, -1])("refuses position %d, which the call did not return", (index) => {
    expect(() => wordAt(returned, index)).toThrow("returned no word");
  });

  it("refuses a return that ends inside the word", () => {
    expect(() => wordAt(returned.subarray(0, 63), 1)).toThrow("returned no word");
    expect(() => wordAt(new Uint8Array(0), 0)).toThrow("returned no word");
  });
});
