// A transaction seen in a best block is not final: the chain may yet replace that block. The block
// is kept, number and hash, until the finalized chain is past it and says which it was, as the top
// up keeps its conversion's block. A block that stands is final and is let go; one that was
// replaced took the transaction with it, and the leg that sent it sends it again.

import { bounded } from "./bounded";

/** The best block a transaction was seen in. */
export interface SeenBlock {
  number: number;
  hash: string;
}

/** What the finalized chain says of a seen block: nothing while it is not past it, then that the
 *  block stands or that another took its place. */
export type BlockVerdict = "pending" | "final" | "dropped";

/** The two reads the verdict needs, both at the chain's finalized head. */
export interface FinalizedChain {
  /** The finalized head's number. */
  number: () => Promise<number>;
  /** The hash the finalized chain holds for block `number`. */
  hashAt: (number: number) => Promise<string | undefined>;
}

/** A hash the chain no longer holds reads as zeroes: it keeps only its latest blocks' hashes. */
const forgotten = (hash: string | undefined): boolean => hash === undefined || /^0x0*$/.test(hash);

/**
 * The finalized chain's word on `seen`. Pending until its head is strictly past the block, since
 * a block's hash is recorded by the block after it. A block too old for the chain to name is taken
 * as final: it was settled long ago, and nothing is sent again on a guess.
 */
export async function settleBlock(
  chain: FinalizedChain,
  seen: SeenBlock,
  timeoutMs: number,
): Promise<BlockVerdict> {
  const finalized = await bounded(chain.number(), timeoutMs, "finalized head read");
  if (finalized <= seen.number) return "pending";
  const hash = await bounded(chain.hashAt(seen.number), timeoutMs, "block hash read (finalized)");
  if (forgotten(hash)) return "final";
  return hash === seen.hash ? "final" : "dropped";
}

/** The finalized reads of a chain, from its typed api. */
export const finalizedChainOf = (api: {
  query: {
    System: {
      Number: { getValue: (options: { at: "finalized" }) => Promise<number> };
      BlockHash: {
        getValue: (number: number, options: { at: "finalized" }) => Promise<string | undefined>;
      };
    };
  };
}): FinalizedChain => ({
  number: () => api.query.System.Number.getValue({ at: "finalized" }),
  hashAt: (number) => api.query.System.BlockHash.getValue(number, { at: "finalized" }),
});
