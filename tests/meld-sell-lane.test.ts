// Which lanes a sale tries, and what each sells: a direct Asset Hub sale of PAS or USDT, a
// Chainflip lane this build can swap into, or nothing at all.

import { afterEach, describe, expect, it, vi } from "vitest";
import { laneCandidates, saleLaneOf, sellableCorridor } from "../app/composables/useMeldSellQuote";
import type { SupportedCorridor, SupportedMethod } from "../lib/supported";

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

const method = (
  category: SupportedMethod["category"],
  lanes: SupportedMethod["lanes"],
  limits: { min: string; max: string } = { min: "10", max: "5000" },
): SupportedMethod => ({
  paymentMethodType: category === "bank" ? "PAYOUT_TO_BANK" : "PAYOUT_TO_CARD",
  category,
  ...limits,
  currency: "EUR",
  providers: [],
  ...(lanes === undefined ? {} : { lanes }),
});
const corridor = (...methods: SupportedMethod[]): SupportedCorridor => ({
  country: "DE",
  fiat: "EUR",
  methods,
});
const DIRECT = ["USDT_ASSETHUB", "USDT_STATEMINT", "DOT_ASSETHUB", "DOT_STATEMINT"];
const WITH_SWAPS = [...DIRECT, "USDC_ARBITRUM", "USDC_SOLANA"];

describe("sellableCorridor", () => {
  it("drops a method only a swap lane routes when the build sells no swaps", () => {
    const routed = corridor(
      method("card", [lane("USDC_ARBITRUM", "arbitrum"), lane("USDC_SOLANA", "solana")]),
      method("bank", [lane("DOT_ASSETHUB", "assethub")]),
    );
    const sellable = sellableCorridor(routed, DIRECT);
    expect(sellable.methods.map((m) => m.category)).toEqual(["bank"]);
  });

  it("keeps the swap-only method when the build lists the swap lane", () => {
    const routed = corridor(method("card", [lane("USDC_ARBITRUM", "arbitrum")]));
    expect(sellableCorridor(routed, WITH_SWAPS)).toEqual(routed);
  });

  it("drops a lane the build lists but cannot sell", () => {
    const routed = corridor(method("card", [lane("USDT_TRON", "tron")]));
    expect(sellableCorridor(routed, ["USDT_TRON"]).methods).toEqual([]);
  });

  it("keeps the direct lanes of a method that also swaps, with their own limits", () => {
    const routed = corridor(
      method(
        "card",
        [
          { ...lane("DOT_ASSETHUB", "assethub"), min: "20", max: "1000" },
          { ...lane("USDC_SOLANA", "solana"), min: "5", max: "9000" },
        ],
        { min: "5", max: "9000" },
      ),
    );
    const [card] = sellableCorridor(routed, DIRECT).methods;
    expect(card?.lanes?.map((l) => l.code)).toEqual(["DOT_ASSETHUB"]);
    expect([card?.min, card?.max]).toEqual(["20", "1000"]);
  });

  it("keeps the method's limits when a kept lane names none", () => {
    const routed = corridor(
      method("card", [lane("DOT_ASSETHUB", "assethub"), lane("USDC_SOLANA", "solana")]),
    );
    const [card] = sellableCorridor(routed, DIRECT).methods;
    expect([card?.min, card?.max]).toEqual(["10", "5000"]);
  });

  it("keeps a method that came without lanes: it sells PAS on Asset Hub", () => {
    const routed = corridor(method("card", undefined));
    expect(sellableCorridor(routed, DIRECT)).toEqual(routed);
  });
});

describe("the build's lane order", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("sells USDT on Asset Hub first, then DOT, and no swap, when the build names none", async () => {
    vi.stubEnv("VITE_OFFRAMP_LANES", "");
    vi.resetModules();
    const { OFFRAMP_LANE_ORDER } = await import("../lib/config");
    expect(OFFRAMP_LANE_ORDER).toEqual(DIRECT);
  });

  it("offers a swap lane only when the build names it", async () => {
    vi.stubEnv("VITE_OFFRAMP_LANES", WITH_SWAPS.join(","));
    vi.resetModules();
    const { OFFRAMP_LANE_ORDER } = await import("../lib/config");
    expect(OFFRAMP_LANE_ORDER).toEqual(WITH_SWAPS);
  });

  it("takes the build's own order when it names one", async () => {
    vi.stubEnv("VITE_OFFRAMP_LANES", " dot_assethub, USDC_SOLANA ,");
    vi.resetModules();
    const { OFFRAMP_LANE_ORDER } = await import("../lib/config");
    expect(OFFRAMP_LANE_ORDER).toEqual(["DOT_ASSETHUB", "USDC_SOLANA"]);
  });
});
