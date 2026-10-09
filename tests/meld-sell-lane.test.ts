// Which lanes a sale tries, and what each sells: today's Asset Hub sale, a Chainflip lane this build
// can swap into, or nothing at all.

import { describe, expect, it } from "vitest";
import { laneCandidates, saleLaneOf } from "../app/composables/useMeldSellQuote";

const ORDER = ["DOT_ASSETHUB", "USDC_ARBITRUM", "USDC_SOLANA"];
const lane = (code: string, chain: string) => ({ code, chain });

describe("saleLaneOf", () => {
  it("sells PAS on Asset Hub for the direct code", () => {
    expect(saleLaneOf("DOT_ASSETHUB")).toBeNull();
  });

  it("swaps into a lane this build knows", () => {
    expect(saleLaneOf("USDC_ARBITRUM")?.id).toBe("usdc-arbitrum");
    expect(saleLaneOf("USDC_SOLANA")?.id).toBe("usdc-solana");
  });

  it("sells nothing for another Asset Hub asset or an unknown lane", () => {
    expect(saleLaneOf("USDT_ASSETHUB")).toBeUndefined();
    expect(saleLaneOf("USDT_TRON")).toBeUndefined();
  });
});

describe("laneCandidates", () => {
  it("tries the lanes the adapter found, in this build's order", () => {
    const found = [lane("USDC_SOLANA", "solana"), lane("DOT_ASSETHUB", "assethub")];
    expect(laneCandidates(found, ORDER)).toEqual(["DOT_ASSETHUB", "USDC_SOLANA"]);
  });

  it("drops a lane this build does not offer", () => {
    const found = [lane("USDC_ARBITRUM", "arbitrum"), lane("USDT_SOLANA", "solana")];
    expect(laneCandidates(found, ORDER)).toEqual(["USDC_ARBITRUM"]);
    expect(laneCandidates(found, ["DOT_ASSETHUB"])).toEqual([]);
  });

  it("sells PAS on Asset Hub when the method came without lanes", () => {
    expect(laneCandidates(undefined, ORDER)).toEqual(["DOT_ASSETHUB"]);
  });
});
