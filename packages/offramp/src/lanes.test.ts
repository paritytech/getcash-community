import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { installMeldAssets } from "@getsome/core";
import { TEST_MELD_ASSETS } from "../../../tests/setup-meld-assets";
import {
  isLaneId,
  LANES,
  laneById,
  laneByMeldCode,
  laneSellable,
  laneSellToken,
  UNSOLD_LANE_ASSETS,
} from "./lanes";

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

describe("lane senders", () => {
  it("pays Arbitrum from the sale's proxy and has no sender on Solana", () => {
    expect(laneById("usdc-arbitrum").refundSender).toBe("sale-vault-proxy");
    expect(laneById("usdc-solana").refundSender).toBe("none");
    expect(laneById("usdt-solana").refundSender).toBe("none");
  });

  it("lists only the lanes with a sender, and names the rest's assets", () => {
    expect(LANES.map((l) => l.id)).toEqual(["usdc-arbitrum"]);
    expect(LANES.every(laneSellable)).toBe(true);
    expect(UNSOLD_LANE_ASSETS).toEqual(["usdt@solana", "usdc@solana"]);
  });
});

describe("laneByMeldCode", () => {
  afterEach(() => {
    installMeldAssets(TEST_MELD_ASSETS);
  });

  it("finds the lane a Meld code sells through, and none for an Asset Hub code", () => {
    expect(laneByMeldCode("USDC_ARBITRUM")?.id).toBe("usdc-arbitrum");
    expect(laneByMeldCode("DOT")).toBeNull();
    expect(laneByMeldCode("NOT_A_CODE")).toBeNull();
  });

  it("finds no lane for a code whose lane cannot be sold", () => {
    expect(laneByMeldCode("USDC_SOLANA")).toBeNull();
    expect(laneByMeldCode("USDT_SOLANA")).toBeNull();
  });

  it("follows the adapter's table when Meld renames a lane's code", () => {
    installMeldAssets([{ asset: "usdc@arbitrum", code: "USDC_ARB" }]);
    expect(laneByMeldCode("USDC_ARB")?.id).toBe("usdc-arbitrum");
    expect(laneByMeldCode("USDC_ARBITRUM")).toBeNull();
    expect(laneSellToken(laneById("usdc-arbitrum")).meldCurrencyCode).toBe("USDC_ARB");
  });
});
