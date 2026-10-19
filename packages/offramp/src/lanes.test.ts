import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { installMeldAssets } from "@getsome/core";
import { TEST_MELD_ASSETS } from "../../../tests/setup-meld-assets";
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
      meldCurrencyCode: "USDT_SOLANA",
    });
  });
});

describe("laneByMeldCode", () => {
  afterEach(() => {
    installMeldAssets(TEST_MELD_ASSETS);
  });

  it("finds the lane a Meld code sells through, and none for an Asset Hub code", () => {
    expect(laneByMeldCode("USDC_SOLANA")?.id).toBe("usdc-solana");
    expect(laneByMeldCode("DOT")).toBeNull();
    expect(laneByMeldCode("NOT_A_CODE")).toBeNull();
  });

  it("follows the adapter's table when Meld renames a lane's code", () => {
    installMeldAssets([{ asset: "usdc@solana", code: "USDC_SOL" }]);
    expect(laneByMeldCode("USDC_SOL")?.id).toBe("usdc-solana");
    expect(laneByMeldCode("USDC_SOLANA")).toBeNull();
    expect(laneSellToken(laneById("usdc-solana")).meldCurrencyCode).toBe("USDC_SOL");
  });
});
