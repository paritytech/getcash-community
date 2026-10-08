import { describe, expect, it } from "vitest";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { isLaneId, LANES, laneById, laneByMeldCode, laneSellToken } from "./lanes";

describe("lane catalog", () => {
  it("has unique ids", () => {
    expect(new Set(LANES.map((l) => l.id)).size).toBe(LANES.length);
    expect(isLaneId("usdt-solana")).toBe(true);
    expect(isLaneId("dot-assethub")).toBe(false);
  });

  it("agrees with the Chainflip catalog on each asset's decimals", () => {
    for (const lane of LANES) {
      const source = SOURCE_CONFIG_BY_ID.get(lane.id);
      expect(source?.chain, lane.id).toBe(lane.chainflip.chain);
      expect(source?.asset).toBe(lane.chainflip.asset);
      expect(source?.decimals).toBe(lane.decimals);
    }
  });

  it("names the lane's asset for a Meld sale", () => {
    expect(laneSellToken(laneById("usdt-solana"))).toEqual({
      symbol: "USDT",
      decimals: 6,
      meldCurrencyCode: "USDT_SOL",
    });
  });
});

describe("laneByMeldCode", () => {
  it("finds the lane a Meld code sells through, and none for an Asset Hub code", () => {
    expect(laneByMeldCode("USDC_SOL")?.id).toBe("usdc-solana");
    expect(laneByMeldCode("DOT_ASSETHUB")).toBeNull();
  });
});
