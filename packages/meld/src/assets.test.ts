// Reading the adapter's asset table: once, shared by concurrent callers, and asked again after a
// failure. Each case starts from a fresh module, so from a page that has read nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeldAsset } from "@getsome/core";
import { TEST_MELD_ASSETS } from "../../../tests/setup-meld-assets";
import { createFakeMeldClient } from "./fake";

beforeEach(() => {
  vi.resetModules();
});

const load = async () => ({
  core: await import("@getsome/core"),
  ...(await import("./assets")),
});

describe("ensureMeldAssets", () => {
  it("installs the table the adapter names, reading it once for concurrent callers", async () => {
    const { core, ensureMeldAssets } = await load();
    const getAssets = vi.fn(async () => [...TEST_MELD_ASSETS]);
    await Promise.all([ensureMeldAssets({ getAssets }), ensureMeldAssets({ getAssets })]);
    await ensureMeldAssets({ getAssets });
    expect(getAssets).toHaveBeenCalledTimes(1);
    expect(core.meldCodeOf("dot@assethub")).toBe("DOT");
  });

  it("forgets a failed read, so the next call asks again", async () => {
    const { core, ensureMeldAssets } = await load();
    const getAssets = vi
      .fn<() => Promise<MeldAsset[]>>()
      .mockRejectedValueOnce(new Error("adapter down"))
      .mockResolvedValueOnce([...TEST_MELD_ASSETS]);
    await expect(ensureMeldAssets({ getAssets })).rejects.toThrow("adapter down");
    expect(core.meldAssetsInstalled()).toBe(false);
    await ensureMeldAssets({ getAssets });
    expect(core.meldCodeOf("usdt@assethub")).toBe("USDT_DOT");
    expect(getAssets).toHaveBeenCalledTimes(2);
  });
});

describe("the offline stand-in", () => {
  it("names each asset by its own id: there is no Meld behind it to name them", async () => {
    const rows = await createFakeMeldClient().getAssets();
    expect(rows).toContainEqual({ asset: "dot@assethub", code: "dot@assethub" });
    expect(rows.every((r) => r.code === r.asset)).toBe(true);
  });
});
