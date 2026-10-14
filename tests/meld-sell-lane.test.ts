// Which lanes a sale tries, and what each sells: a direct Asset Hub sale of PAS or USDT, a
// Chainflip lane this build can swap into, or nothing at all.

import { afterEach, describe, expect, it, vi } from "vitest";
import { laneCandidates, saleLaneOf } from "../app/composables/useMeldSellQuote";

const ORDER = ["DOT_ASSETHUB", "USDC_ARBITRUM", "USDC_SOLANA"];
const lane = (code: string, chain: string) => ({ code, chain });

describe("saleLaneOf", () => {
  it("sells PAS on Asset Hub for the direct code", () => {
    expect(saleLaneOf("DOT_ASSETHUB")).toBeNull();
  });

  it("sells PAS on Asset Hub under Meld's older Statemint code too", () => {
    expect(saleLaneOf("DOT_STATEMINT")).toBeNull();
  });

  it("sells USDT on Asset Hub with no swap under either of Meld's codes for it", () => {
    expect(saleLaneOf("USDT_ASSETHUB")).toBeNull();
    expect(saleLaneOf("USDT_STATEMINT")).toBeNull();
  });

  it("swaps into a lane this build knows", () => {
    expect(saleLaneOf("USDC_ARBITRUM")?.id).toBe("usdc-arbitrum");
    expect(saleLaneOf("USDC_SOLANA")?.id).toBe("usdc-solana");
  });

  it("sells nothing for another Asset Hub asset or an unknown lane", () => {
    expect(saleLaneOf("USDC_ASSETHUB")).toBeUndefined();
    expect(saleLaneOf("USDC_STATEMINT")).toBeUndefined();
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

  it("tries the Statemint code right after the Asset Hub one, before any swap", () => {
    const order = ["DOT_ASSETHUB", "DOT_STATEMINT", "USDC_ARBITRUM"];
    const found = [lane("USDC_ARBITRUM", "arbitrum"), lane("DOT_STATEMINT", "assethub")];
    expect(laneCandidates(found, order)).toEqual(["DOT_STATEMINT", "USDC_ARBITRUM"]);
  });

  it("tries the direct sale of USDT first, then DOT's, before any swap", () => {
    const order = [
      "USDT_ASSETHUB",
      "USDT_STATEMINT",
      "DOT_ASSETHUB",
      "DOT_STATEMINT",
      "USDC_ARBITRUM",
    ];
    const found = [
      lane("USDC_ARBITRUM", "arbitrum"),
      lane("DOT_STATEMINT", "assethub"),
      lane("USDT_STATEMINT", "assethub"),
      lane("USDT_ASSETHUB", "assethub"),
    ];
    expect(laneCandidates(found, order)).toEqual([
      "USDT_ASSETHUB",
      "USDT_STATEMINT",
      "DOT_STATEMINT",
      "USDC_ARBITRUM",
    ]);
  });

  it("sells PAS on Asset Hub when the method came without lanes", () => {
    expect(laneCandidates(undefined, ORDER)).toEqual(["DOT_ASSETHUB"]);
  });
});

describe("the build's lane order", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("puts USDT on Asset Hub first, then DOT, then the swaps, when the build names none", async () => {
    vi.stubEnv("VITE_OFFRAMP_LANES", "");
    vi.resetModules();
    const { OFFRAMP_LANE_ORDER } = await import("../lib/config");
    expect(OFFRAMP_LANE_ORDER).toEqual([
      "USDT_ASSETHUB",
      "USDT_STATEMINT",
      "DOT_ASSETHUB",
      "DOT_STATEMINT",
      "USDC_ARBITRUM",
      "USDC_SOLANA",
    ]);
  });

  it("takes the build's own order when it names one", async () => {
    vi.stubEnv("VITE_OFFRAMP_LANES", " dot_assethub, USDC_SOLANA ,");
    vi.resetModules();
    const { OFFRAMP_LANE_ORDER } = await import("../lib/config");
    expect(OFFRAMP_LANE_ORDER).toEqual(["DOT_ASSETHUB", "USDC_SOLANA"]);
  });
});
