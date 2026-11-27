// Which lanes a sale tries: the direct Asset Hub sales of PAS and USDT, in the build's order, and
// no other.

import { afterEach, describe, expect, it, vi } from "vitest";
import { laneCandidates, sellableCorridor } from "../app/composables/useMeldSellQuote";
import type { MeldAssetId } from "@getsome/core";
import type { SupportedCorridor, SupportedMethod } from "../lib/supported";

const ORDER: MeldAssetId[] = ["dot@assethub", "usdt@assethub"];
/** A lane as an adapter that names no asset sends it: matched by the asset table's reading of its code. */
const lane = (code: string, chain: string) => ({ code, chain });

describe("laneCandidates", () => {
  it("tries the lanes the adapter found, in this build's order", () => {
    const found = [lane("USDT_DOT", "assethub"), lane("DOT", "assethub")];
    expect(laneCandidates(found, ORDER)).toEqual(["DOT", "USDT_DOT"]);
  });

  it("drops a lane this build does not offer", () => {
    const found = [lane("USDC_DOT", "assethub"), lane("USDC_ARBITRUM", "arbitrum")];
    expect(laneCandidates(found, ["usdc@assethub", "dot@assethub"])).toEqual(["USDC_DOT"]);
    expect(laneCandidates(found, ["dot@assethub"])).toEqual([]);
  });

  it("tries the direct sale of USDT first, then DOT's", () => {
    const order: MeldAssetId[] = ["usdt@assethub", "dot@assethub"];
    const found = [lane("DOT", "assethub"), lane("USDT_DOT", "assethub")];
    expect(laneCandidates(found, order)).toEqual(["USDT_DOT", "DOT"]);
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

describe("sellableCorridor", () => {
  it("drops a method only a lane on another chain routes", () => {
    const routed = corridor(
      method("card", [lane("USDC_ARBITRUM", "arbitrum"), lane("USDC_SOLANA", "solana")]),
      method("bank", [lane("DOT", "assethub")]),
    );
    const sellable = sellableCorridor(routed, DIRECT);
    expect(sellable.methods.map((m) => m.category)).toEqual(["bank"]);
  });

  it("drops a lane the order names but no sale sells", () => {
    const routed = corridor(method("card", [lane("USDT_TRON", "tron")]));
    expect(sellableCorridor(routed, DIRECT).methods).toEqual([]);
    const usdc = corridor(method("card", [lane("USDC_DOT", "assethub")]));
    expect(sellableCorridor(usdc, ["usdc@assethub"]).methods).toEqual([]);
  });

  it("keeps the direct lanes of a method that another chain's lane also routes, with their own limits", () => {
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

  it("takes the build's own order when it names one", async () => {
    vi.stubEnv("VITE_OFFRAMP_LANES", " dot@assethub, USDT@ASSETHUB ,");
    vi.resetModules();
    const { OFFRAMP_LANE_ORDER } = await import("../lib/config");
    expect(OFFRAMP_LANE_ORDER).toEqual(["dot@assethub", "usdt@assethub"]);
  });

  it.each([
    // A build variable still listing the codes Meld retired would otherwise sell through nothing.
    [
      "a Meld code rather than an asset id",
      "USDT_ASSETHUB,DOT_STATEMINT,dot@assethub",
      "usdt_assethub, dot_statemint",
    ],
    ["an asset no sale sells", "dot@assethub,usdc@assethub", "usdc@assethub"],
  ])("drops, with a warning, an entry that is %s", async (_what, lanes, named) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("VITE_OFFRAMP_LANES", lanes);
    vi.resetModules();
    const { OFFRAMP_LANE_ORDER } = await import("../lib/config");
    expect(OFFRAMP_LANE_ORDER).toEqual(["dot@assethub"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(named));
    warn.mockRestore();
  });

  it.each(["DOT_ASSETHUB", "usdc@arbitrum,usdc@solana"])(
    "falls back to the direct sales when every entry is dropped (%s)",
    async (lanes) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubEnv("VITE_OFFRAMP_LANES", lanes);
      vi.resetModules();
      const { OFFRAMP_LANE_ORDER } = await import("../lib/config");
      expect(OFFRAMP_LANE_ORDER).toEqual(DIRECT);
      vi.restoreAllMocks();
    },
  );
});
