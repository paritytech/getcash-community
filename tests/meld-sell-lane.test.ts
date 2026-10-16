// Which lanes a sale tries, and what each sells: a direct Asset Hub sale of PAS or USDT, a
// Chainflip lane this build can swap into, or nothing at all.

import { afterEach, describe, expect, it, vi } from "vitest";
import { laneCandidates, saleLaneOf, sellableCorridor } from "../app/composables/useMeldSellQuote";
import type { MeldAssetId } from "@getsome/core";
import type { SupportedCorridor, SupportedMethod } from "../lib/supported";

const ORDER: MeldAssetId[] = ["dot@assethub", "usdc@arbitrum", "usdc@solana"];
/** A lane as an adapter that names no asset sends it: matched by the asset table's reading of its code. */
const lane = (code: string, chain: string) => ({ code, chain });

describe("saleLaneOf", () => {
  it("sells PAS on Asset Hub for the direct code", () => {
    expect(saleLaneOf("DOT")).toBeNull();
  });

  it("sells nothing under a code Meld retired, which the adapter's table no longer names", () => {
    for (const code of ["DOT_ASSETHUB", "DOT_STATEMINT", "USDT_ASSETHUB", "USDT_STATEMINT"]) {
      expect(saleLaneOf(code)).toBeUndefined();
    }
  });

  it("sells USDT on Asset Hub with no swap", () => {
    expect(saleLaneOf("USDT_DOT")).toBeNull();
  });

  it("swaps into a lane this build knows", () => {
    expect(saleLaneOf("USDC_ARBITRUM")?.id).toBe("usdc-arbitrum");
    expect(saleLaneOf("USDC_SOLANA")?.id).toBe("usdc-solana");
  });

  it("sells nothing for another Asset Hub asset or an unknown lane", () => {
    expect(saleLaneOf("USDC_DOT")).toBeUndefined();
    expect(saleLaneOf("USDC_STATEMINT")).toBeUndefined();
    expect(saleLaneOf("USDT_TRON")).toBeUndefined();
  });
});

describe("laneCandidates", () => {
  it("tries the lanes the adapter found, in this build's order", () => {
    const found = [lane("USDC_SOLANA", "solana"), lane("DOT", "assethub")];
    expect(laneCandidates(found, ORDER)).toEqual(["DOT", "USDC_SOLANA"]);
  });

  it("drops a lane this build does not offer", () => {
    const found = [lane("USDC_ARBITRUM", "arbitrum"), lane("USDT_SOLANA", "solana")];
    expect(laneCandidates(found, ORDER)).toEqual(["USDC_ARBITRUM"]);
    expect(laneCandidates(found, ["dot@assethub"])).toEqual([]);
  });

  it("tries the direct sale of USDT first, then DOT's, before any swap", () => {
    const order: MeldAssetId[] = ["usdt@assethub", "dot@assethub", "usdc@arbitrum"];
    const found = [
      lane("USDC_ARBITRUM", "arbitrum"),
      lane("DOT", "assethub"),
      lane("USDT_DOT", "assethub"),
    ];
    expect(laneCandidates(found, order)).toEqual(["USDT_DOT", "DOT", "USDC_ARBITRUM"]);
  });

  it("matches a lane by the asset the adapter names, under whatever code it sends", () => {
    // An adapter whose config renamed DOT again: the build's order names the asset, not the code.
    const found = [{ asset: "dot@assethub" as const, code: "DOT_RENAMED", chain: "assethub" }];
    expect(laneCandidates(found, ["dot@assethub"])).toEqual(["DOT_RENAMED"]);
  });

  it("sells PAS on Asset Hub when the method came without lanes", () => {
    expect(laneCandidates(undefined, ORDER)).toEqual(["DOT"]);
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
const DIRECT: MeldAssetId[] = ["usdt@assethub", "dot@assethub"];
const WITH_SWAPS: MeldAssetId[] = [...DIRECT, "usdc@arbitrum", "usdc@solana"];

describe("sellableCorridor", () => {
  it("drops a method only a swap lane routes when the build sells no swaps", () => {
    const routed = corridor(
      method("card", [lane("USDC_ARBITRUM", "arbitrum"), lane("USDC_SOLANA", "solana")]),
      method("bank", [lane("DOT", "assethub")]),
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
    expect(sellableCorridor(routed, WITH_SWAPS).methods).toEqual([]);
    // Listed, and a lane of this build's, but with no swap behind it.
    const usdc = corridor(method("card", [lane("USDC_DOT", "assethub")]));
    expect(sellableCorridor(usdc, ["usdc@assethub"]).methods).toEqual([]);
  });

  it("keeps the direct lanes of a method that also swaps, with their own limits", () => {
    const routed = corridor(
      method(
        "card",
        [
          { ...lane("DOT", "assethub"), min: "20", max: "1000" },
          { ...lane("USDC_SOLANA", "solana"), min: "5", max: "9000" },
        ],
        { min: "5", max: "9000" },
      ),
    );
    const [card] = sellableCorridor(routed, DIRECT).methods;
    expect(card?.lanes?.map((l) => l.code)).toEqual(["DOT"]);
    expect([card?.min, card?.max]).toEqual(["20", "1000"]);
  });

  it("keeps the method's limits when a kept lane names none", () => {
    const routed = corridor(
      method("card", [lane("DOT", "assethub"), lane("USDC_SOLANA", "solana")]),
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
    vi.stubEnv("VITE_OFFRAMP_LANES", " dot@assethub, USDC@SOLANA ,");
    vi.resetModules();
    const { OFFRAMP_LANE_ORDER } = await import("../lib/config");
    expect(OFFRAMP_LANE_ORDER).toEqual(["dot@assethub", "usdc@solana"]);
  });

  it("drops, with a warning, an entry that is a Meld code rather than an asset id", async () => {
    // A build variable still listing the codes Meld retired would otherwise sell through nothing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("VITE_OFFRAMP_LANES", "USDT_ASSETHUB,DOT_STATEMINT,dot@assethub");
    vi.resetModules();
    const { OFFRAMP_LANE_ORDER } = await import("../lib/config");
    expect(OFFRAMP_LANE_ORDER).toEqual(["dot@assethub"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("usdt_assethub, dot_statemint"));
    warn.mockRestore();
  });

  it("falls back to the direct sales when every entry is unknown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("VITE_OFFRAMP_LANES", "DOT_ASSETHUB");
    vi.resetModules();
    const { OFFRAMP_LANE_ORDER } = await import("../lib/config");
    expect(OFFRAMP_LANE_ORDER).toEqual(DIRECT);
    vi.restoreAllMocks();
  });
});
