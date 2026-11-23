// The transaction signer against known answers: RLP's own examples, and transactions signed by
// another tool with the same keys and fields.
// TODO: remove this file with the signer, once a forwarder and a relayer send the transactions.

import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  evmAddressOf,
  integerBytes,
  rlpEncode,
  signEvmTransaction,
  type EvmTransaction,
  type RlpItem,
} from "./evm-tx";

const hex = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;
const text = (value: string): Uint8Array => utf8ToBytes(value);

const GWEI = 1_000_000_000n;
const ETHER = 1_000_000_000_000_000_000n;

// The first three keys of the test mnemonic that every local Ethereum node ships with.
const KEYS = [
  {
    privateKey: "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  },
  {
    privateKey: "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  },
  {
    privateKey: "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    address: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  },
] as const;

describe("integerBytes", () => {
  it.each<[bigint, string]>([
    [0n, "0x"],
    [1n, "0x01"],
    [127n, "0x7f"],
    [128n, "0x80"],
    [255n, "0xff"],
    [256n, "0x0100"],
    [1024n, "0x0400"],
    [ETHER, "0x0de0b6b3a7640000"],
  ])("writes %d with no leading zero", (value, expected) => {
    expect(hex(integerBytes(value))).toBe(expected);
  });

  it("refuses a negative number", () => {
    expect(() => integerBytes(-1n)).toThrow("negative");
  });
});

describe("rlpEncode", () => {
  const lorem = "Lorem ipsum dolor sit amet, consectetur adipisicing elit";
  it.each<[string, RlpItem, string]>([
    ["the empty string", new Uint8Array(0), "0x80"],
    ["one low byte as itself", Uint8Array.of(0x0f), "0x0f"],
    ["the byte zero as itself", Uint8Array.of(0x00), "0x00"],
    ["one high byte with a prefix", Uint8Array.of(0x80), "0x8180"],
    ["a short string", text("dog"), "0x83646f67"],
    ["the number 1024", integerBytes(1024n), "0x820400"],
    ["a string of 56 bytes", text(lorem), `0xb838${bytesToHex(text(lorem))}`],
    ["the empty list", [], "0xc0"],
    ["a list of strings", [text("cat"), text("dog")], "0xc88363617483646f67"],
    ["lists in lists", [[], [[]], [[], [[]]]], "0xc7c0c1c0c3c0c1c0"],
  ])("encodes %s", (_name, item, expected) => {
    expect(hex(rlpEncode(item))).toBe(expected);
  });

  it("writes the length of a long list in its own bytes", () => {
    const item = Array.from({ length: 30 }, () => text("ab"));
    const encoded = rlpEncode(item);
    // 30 items of 3 bytes each: a 90 byte body, past the 55 a short prefix can name.
    expect(hex(encoded.subarray(0, 2))).toBe("0xf85a");
    expect(encoded.length).toBe(92);
  });

  it("writes a length of two bytes", () => {
    const encoded = rlpEncode(new Uint8Array(1024));
    expect(hex(encoded.subarray(0, 3))).toBe("0xb90400");
    expect(encoded.length).toBe(1027);
  });
});

describe("evmAddressOf", () => {
  it.each(KEYS)("gives $address", ({ privateKey, address }) => {
    expect(evmAddressOf(hexToBytes(privateKey))).toBe(address);
  });
});

describe("signEvmTransaction", () => {
  const transfer: EvmTransaction = {
    chainId: 1n,
    nonce: 7n,
    maxPriorityFeePerGas: 2n * GWEI,
    maxFeePerGas: 30n * GWEI,
    gasLimit: 21_000n,
    to: KEYS[1].address,
    value: ETHER,
    data: new Uint8Array(0),
  };

  it.each<[string, EvmTransaction, string, string]>([
    [
      "a plain transfer",
      transfer,
      KEYS[0].privateKey,
      "0x02f873010784773594008506fc23ac008252089470997970c51812dc3a010c7d01b50e0d17dc79c8880de0b6b3a764000080c080a0972f69499b3f0a3c27bdcf146188807be7b678df3fa9965f96c58361c01aae07a0174c224e94bc3d3091291b5481a8176880647c2f19f29aa0f0ffc2aa563b61b9",
    ],
    [
      "a signature with the other parity",
      { ...transfer, nonce: 10n },
      KEYS[0].privateKey,
      "0x02f873010a84773594008506fc23ac008252089470997970c51812dc3a010c7d01b50e0d17dc79c8880de0b6b3a764000080c001a045aa0bbb8dfcfa76b37850d233da29f90b2e2d669e911f57b56d7c560bdf6a4fa0428b763c5a40d1805a971f9da66332edff44fa812044b6aae0a1e4763170c050",
    ],
    [
      "a signature whose s is one byte short",
      { ...transfer, nonce: 115n },
      KEYS[0].privateKey,
      "0x02f872017384773594008506fc23ac008252089470997970c51812dc3a010c7d01b50e0d17dc79c8880de0b6b3a764000080c080a042019b441698843498dc3326b06f17aaa8d994be86b0ac62cedf567873b4bbf69ff05948409f8bcfcd12e152b72d3c55fa005a4236542045ca793cec555425eb",
    ],
    [
      "a contract call on another chain, with no value and a zero nonce",
      {
        chainId: 8453n,
        nonce: 0n,
        maxPriorityFeePerGas: 1_000n,
        maxFeePerGas: 1_000_000n,
        gasLimit: 250_000n,
        to: "0xd5fd74f570343245afce4a4c0b24b59179cfdfa7",
        value: 0n,
        data: hexToBytes(
          "a9059cbb000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000000000000000000f4240",
        ),
      },
      KEYS[1].privateKey,
      "0x02f8af822105808203e8830f42408303d09094d5fd74f570343245afce4a4c0b24b59179cfdfa780b844a9059cbb000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000000000000000000f4240c080a0badb0e2832df92637178b12b7ab13e4a6d5e5024cab96a0c11a715c3918cba1ba07faaeb7d23a1a42c43a4ab7270c1f17db2c3f8de9bfef94fd0995c9839aba6aa",
    ],
    [
      "a large nonce, no tip and one zero byte of data",
      {
        chainId: 31_337n,
        nonce: 1_234_567n,
        maxPriorityFeePerGas: 0n,
        maxFeePerGas: 123_456_789_012n,
        gasLimit: 500_000n,
        to: "0x0000000000000000000000000000000000000401",
        value: 123_456_789n,
        data: Uint8Array.of(0x00),
      },
      KEYS[2].privateKey,
      "0x02f871827a698312d68780851cbe991a148307a12094000000000000000000000000000000000000040184075bcd1500c080a0aaf54204832fa320019db0e71bf975306e3fa3d25ac89c16c7e99340ea8dca28a0333886f201fbfed100b9884e8d33a99420e8cfc596075f07f06ec51089e91757",
    ],
  ])("signs %s as the other tool does", (_name, tx, privateKey, expected) => {
    expect(hex(signEvmTransaction(tx, hexToBytes(privateKey)).raw)).toBe(expected);
  });

  it("gives the hash of the signed bytes", () => {
    const signed = signEvmTransaction(transfer, hexToBytes(KEYS[0].privateKey));
    expect(hex(signed.hash)).toBe(
      "0xb18cb061195bfb577ef4f608f162bd88a09989cbbaa34ee7e647d4ce468d93f3",
    );
  });

  it("refuses a recipient that is not an address", () => {
    expect(() =>
      signEvmTransaction({ ...transfer, to: "0x1234" }, hexToBytes(KEYS[0].privateKey)),
    ).toThrow("not an Ethereum address");
  });
});
