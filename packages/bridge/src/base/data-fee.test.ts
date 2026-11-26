// The question about Base's data fee, against the same call made by another tool.
// TODO: remove this file with the data fee, once a forwarder and a relayer send the transactions.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import type { EvmCall } from "../evm-rpc";
import { baseDataFee } from "./data-fee";

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

describe("baseDataFee", () => {
  it("asks the oracle as the other tool does and reads the fee from the first word", async () => {
    const { rpc, calls } = node(2_403_754_184n.toString(16).padStart(64, "0"));
    expect(await baseDataFee(rpc, hexToBytes("02f8b1"))).toBe(2_403_754_184n);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe("0x420000000000000000000000000000000000000f");
    expect(calls[0]!.value).toBeUndefined();
    expect(`0x${bytesToHex(calls[0]!.data!)}`).toBe(
      "0x49948e0e0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000302f8b10000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("refuses an oracle that returned nothing", async () => {
    await expect(baseDataFee(node("").rpc, hexToBytes("02"))).rejects.toThrow("returned no word");
  });
});
