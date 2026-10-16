// The page's copy of the adapter's asset table: what it accepts, what a lookup answers before and
// after it is installed, and that a Meld rename reaches the tokens without a release.

import { afterEach, describe, expect, it } from "vitest";
import { TEST_MELD_ASSETS } from "../../../tests/setup-meld-assets";
import {
  installMeldAssets,
  isMeldAssetId,
  MeldAssetsUnavailable,
  meldAssetOf,
  meldAssetsInstalled,
  meldCodeOf,
  parseMeldAssets,
} from "./meld-assets";
import { TOKENS } from "./tokens";

afterEach(() => {
  installMeldAssets(TEST_MELD_ASSETS);
});

describe("the adapter's asset table", () => {
  it("is read from the adapter's body, dropping rows the app cannot use", () => {
    expect(
      parseMeldAssets({
        assets: [
          { asset: "dot@assethub", code: "DOT", chain: "assethub", deliverable: true },
          { asset: "btc@bitcoin", code: "BTC" },
          { asset: "usdt@assethub", code: "" },
          { asset: "usdc@assethub" },
          null,
        ],
      }),
    ).toEqual([{ asset: "dot@assethub", code: "DOT" }]);
  });

  it("is refused when the body carries no table", () => {
    expect(() => parseMeldAssets({})).toThrow(MeldAssetsUnavailable);
    expect(() => parseMeldAssets(null)).toThrow(MeldAssetsUnavailable);
  });

  it("answers both ways once installed", () => {
    expect(meldAssetsInstalled()).toBe(true);
    expect(meldCodeOf("dot@assethub")).toBe("DOT");
    expect(meldCodeOf("usdt@assethub")).toBe("USDT_DOT");
    expect(meldAssetOf("USDC_ARBITRUM")).toBe("usdc@arbitrum");
    expect(meldAssetOf("DOT_ASSETHUB")).toBeUndefined();
    expect(meldAssetOf(undefined)).toBeUndefined();
  });

  it("names no code for an asset the adapter does not serve", () => {
    installMeldAssets([{ asset: "dot@assethub", code: "DOT" }]);
    expect(() => meldCodeOf("usdt@assethub")).toThrow("The adapter does not serve usdt@assethub.");
  });

  it("is what the tokens read their code from, so a rename needs no release", () => {
    expect(TOKENS.PAS.meldAsset).toBe("dot@assethub");
    expect(TOKENS.PAS.meldCurrencyCode).toBe("DOT");
    expect(TOKENS.USDT.meldCurrencyCode).toBe("USDT_DOT");
    installMeldAssets([
      { asset: "dot@assethub", code: "DOT_RENAMED" },
      { asset: "usdt@assethub", code: "USDT_RENAMED" },
    ]);
    expect(TOKENS.PAS.meldCurrencyCode).toBe("DOT_RENAMED");
    expect(TOKENS.USDT.meldCurrencyCode).toBe("USDT_RENAMED");
  });

  it("tells an asset id from anything else, a Meld code included", () => {
    expect(isMeldAssetId("usdc@solana")).toBe(true);
    expect(isMeldAssetId("USDC_SOLANA")).toBe(false);
    expect(isMeldAssetId(undefined)).toBe(false);
  });
});

describe("before the table is read", () => {
  it("names no code at all, rather than one nobody checked", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    const fresh = await import("./meld-assets");
    expect(fresh.meldAssetsInstalled()).toBe(false);
    expect(() => fresh.meldCodeOf("dot@assethub")).toThrow(
      "Meld's asset codes have not been read from the adapter yet.",
    );
    expect(fresh.meldAssetOf("DOT")).toBeUndefined();
    vi.resetModules();
  });
});
