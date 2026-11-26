// The swap of ETH for USDC on Base: its call data and the two questions it asks the quoter, each
// against the same call made by another tool.
// TODO: remove this file with the swap, once a forwarder and a relayer make the deposit.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import type { EvmCall } from "../evm-rpc";
import { ethToUsdcSwap, quoteEthIn, quoteUsdcOut } from "./swap";

const hex = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");

const RECIPIENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ETH_IN = 50_000_000_000_000_000n;
const ROUTER = "0x2626664c2603336e57b271c5c0b26f421741e481";
const QUOTER = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a";

/** A node that answers every simulated call with `returned`, and the calls it was asked. */
function node(returned: string) {
  const calls: EvmCall[] = [];
  return {
    calls,
    rpc: {
      call: async (call: EvmCall) => {
        calls.push(call);
        return hexToBytes(returned);
      },
    },
  };
}

describe("ethToUsdcSwap", () => {
  it("calls the router with the ETH as value and the swap as the other tool encodes it", () => {
    const call = ethToUsdcSwap({
      ethIn: ETH_IN,
      minimumUsdcOut: 84_000_000n,
      recipient: RECIPIENT,
    });
    expect(call.to).toBe(ROUTER);
    expect(call.value).toBe(ETH_IN);
    expect(hex(call.data)).toBe(
      "0x04e45aaf0000000000000000000000004200000000000000000000000000000000000006000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000000000b1a2bc2ec50000000000000000000000000000000000000000000000000000000000000501bd000000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("refuses a recipient that is not an address", () => {
    expect(() => ethToUsdcSwap({ ethIn: 1n, minimumUsdcOut: 1n, recipient: "0x12" })).toThrow(
      "not an Ethereum address",
    );
  });
});

describe("quoteUsdcOut", () => {
  it("asks the quoter as the other tool does and reads the USDC from the first word", async () => {
    // What the quoter returns: the amount, the price after, the ticks crossed and the gas.
    const { rpc, calls } = node(word(85_306_348n) + word(3_273_357n) + word(1n) + word(71_967n));
    expect(await quoteUsdcOut(rpc, ETH_IN)).toBe(85_306_348n);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(QUOTER);
    expect(calls[0]!.value).toBeUndefined();
    expect(hex(calls[0]!.data!)).toBe(
      "0xc6a5026a0000000000000000000000004200000000000000000000000000000000000006000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000b1a2bc2ec5000000000000000000000000000000000000000000000000000000000000000001f40000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("refuses a quoter that returned nothing", async () => {
    await expect(quoteUsdcOut(node("").rpc, ETH_IN)).rejects.toThrow("returned no word");
  });
});

describe("quoteEthIn", () => {
  it("asks the quoter as the other tool does and reads the ETH from the first word", async () => {
    const ethIn = 49_820_441_683_901_822n;
    const { rpc, calls } = node(word(ethIn) + word(3_273_357n) + word(1n) + word(71_769n));
    expect(await quoteEthIn(rpc, 85_000_000n)).toBe(ethIn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(QUOTER);
    expect(calls[0]!.value).toBeUndefined();
    expect(hex(calls[0]!.data!)).toBe(
      "0xbd21704a0000000000000000000000004200000000000000000000000000000000000006000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000510ff4000000000000000000000000000000000000000000000000000000000000001f40000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("refuses a quoter that returned nothing", async () => {
    await expect(quoteEthIn(node("").rpc, 85_000_000n)).rejects.toThrow("returned no word");
  });
});
