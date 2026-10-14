// The SaleVault adapter client: mapping the on-chain sale read, and the soft outcomes of a return.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "https://adapter.test";

const saleBody = (over: Record<string, unknown> = {}) => ({
  sale: {
    fundingRequestId: "funding-1",
    chain: "arbitrum-sepolia",
    contract: `0x${"22".repeat(20)}`,
    ref: `0x${"11".repeat(32)}`,
    status: "paid",
    recipient: `0x${"33".repeat(20)}`,
    amount: "50000000",
    home: `0x${"ab".repeat(32)}`,
    held: "0",
    returnStatus: "none",
    returnTx: null,
    ...over,
  },
});

const respond = (body: unknown, status = 200) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );

describe("the SaleVault adapter client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_MELD_BASE_URL", BASE);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reads and maps a paid sale", async () => {
    vi.stubGlobal("fetch", respond(saleBody()));
    const { fetchSaleVaultStatus } = await import("../lib/sale-vault");
    expect(await fetchSaleVaultStatus("funding-1")).toEqual({
      status: "paid",
      recipient: `0x${"33".repeat(20)}`,
      amount: "50000000",
      held: "0",
      returnStatus: "none",
      returnTx: null,
    });
  });

  it("maps a held sale with its held amount", async () => {
    vi.stubGlobal("fetch", respond(saleBody({ status: "held", held: "49999000" })));
    const { fetchSaleVaultStatus } = await import("../lib/sale-vault");
    expect(await fetchSaleVaultStatus("funding-1")).toMatchObject({
      status: "held",
      held: "49999000",
    });
  });

  it("is null on a 404 and when no adapter is configured", async () => {
    vi.stubGlobal("fetch", respond("no", 404));
    const mod = await import("../lib/sale-vault");
    expect(await mod.fetchSaleVaultStatus("funding-1")).toBeNull();
    vi.unstubAllEnvs();
    expect(await mod.fetchSaleVaultStatus("funding-1")).toBeNull();
  });

  it("returns a held sale and reports returning", async () => {
    vi.stubGlobal(
      "fetch",
      respond(
        saleBody({ status: "held", returnStatus: "returning", returnTx: `0x${"cd".repeat(32)}` }),
      ),
    );
    const { requestSaleVaultReturn } = await import("../lib/sale-vault");
    expect(await requestSaleVaultReturn("funding-1")).toEqual({
      outcome: "returning",
      status: {
        status: "held",
        recipient: `0x${"33".repeat(20)}`,
        amount: "50000000",
        held: "0",
        returnStatus: "returning",
        returnTx: `0x${"cd".repeat(32)}`,
      },
    });
  });

  it("maps 409 to not-returnable and 404 to not-found", async () => {
    vi.stubGlobal("fetch", respond({ error: { value: { code: "SALE_NOT_RETURNABLE" } } }, 409));
    const mod = await import("../lib/sale-vault");
    expect(await mod.requestSaleVaultReturn("funding-1")).toEqual({ outcome: "not-returnable" });
    vi.stubGlobal("fetch", respond({ error: {} }, 404));
    expect(await mod.requestSaleVaultReturn("funding-1")).toEqual({ outcome: "not-found" });
  });

  it("is unavailable when no adapter is configured", async () => {
    vi.unstubAllEnvs();
    const { requestSaleVaultReturn } = await import("../lib/sale-vault");
    expect(await requestSaleVaultReturn("funding-1")).toEqual({ outcome: "unavailable" });
  });
});
