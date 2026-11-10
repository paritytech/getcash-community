// The finalized chain's word on a block a transaction was seen in: nothing until it is past the
// block, then whether the block stands or another took its place.

import { describe, expect, it } from "vitest";
import { finalizedChainOf, settleBlock, type FinalizedChain } from "./inclusion";

const SEEN = { number: 500, hash: "0xseen" };

/** A finalized chain at `number`, holding `hash` for the seen block. */
function chain(number: number, hash: string | undefined) {
  const asked: number[] = [];
  const reads: FinalizedChain = {
    number: async () => number,
    hashAt: async (at) => {
      asked.push(at);
      return hash;
    },
  };
  return { reads, asked };
}

describe("a block a transaction was seen in", () => {
  it("is pending, with no hash read, until the finalized head is strictly past it", async () => {
    for (const number of [498, 500]) {
      const { reads, asked } = chain(number, "0xseen");
      expect(await settleBlock(reads, SEEN, 1_000)).toBe("pending");
      // At the block's own height the chain has not recorded its hash yet.
      expect(asked).toEqual([]);
    }
  });

  it("is final when the finalized chain holds that block", async () => {
    const { reads, asked } = chain(501, "0xseen");
    expect(await settleBlock(reads, SEEN, 1_000)).toBe("final");
    expect(asked).toEqual([500]);
  });

  it("is dropped when the finalized chain holds another block at that height", async () => {
    expect(await settleBlock(chain(501, "0xother").reads, SEEN, 1_000)).toBe("dropped");
  });

  it("is unknown when the chain no longer names a block that old", async () => {
    // The chain keeps only its latest hashes; one it has let go reads as zeroes, or not at all.
    const zeroes = `0x${"00".repeat(32)}`;
    expect(await settleBlock(chain(9_000, zeroes).reads, SEEN, 1_000)).toBe("unknown");
    expect(await settleBlock(chain(9_000, undefined).reads, SEEN, 1_000)).toBe("unknown");
  });

  it("reads both at the chain's finalized head", async () => {
    const asked: unknown[] = [];
    const reads = finalizedChainOf({
      query: {
        System: {
          Number: {
            getValue: async (options) => {
              asked.push(options);
              return 501;
            },
          },
          BlockHash: {
            getValue: async (number, options) => {
              asked.push([number, options]);
              return "0xseen";
            },
          },
        },
      },
    });
    expect(await settleBlock(reads, SEEN, 1_000)).toBe("final");
    expect(asked).toEqual([{ at: "finalized" }, [500, { at: "finalized" }]]);
  });
});
