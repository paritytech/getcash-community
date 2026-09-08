// The live-capability catalog client: parsing, per-corridor caching, the card/bank resolver, and
// the empty-catalog-is-retryable rule. Each test resets modules to clear the process-wide caches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupportedCorridor } from "../lib/supported";

const BASE = "https://adapter.test";

/** A `fetch` stub that answers by URL fragment; anything unmatched is a 404. */
function stubFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    for (const [frag, body] of Object.entries(routes)) {
      if (u.includes(frag)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  });
}

describe("lib/supported", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_MELD_BASE_URL", BASE);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("methodFor returns the first method of the chosen category, or null", async () => {
    const { methodFor } = await import("../lib/supported");
    const corridor: SupportedCorridor = {
      country: "US",
      fiat: "USD",
      methods: [
        {
          paymentMethodType: "CREDIT_DEBIT_CARD",
          category: "card",
          min: "5",
          max: "3000",
          currency: "USD",
          providers: ["TRANSAK"],
        },
        {
          paymentMethodType: "ACH",
          category: "bank",
          min: "10",
          max: "1000",
          currency: "USD",
          providers: ["GUARDARIAN"],
        },
      ],
    };
    expect(methodFor(corridor, "card")?.paymentMethodType).toBe("CREDIT_DEBIT_CARD");
    expect(methodFor(corridor, "bank")?.paymentMethodType).toBe("ACH");
    expect(methodFor({ country: "X", fiat: "Y", methods: [] }, "card")).toBeNull();
    expect(methodFor(null, "card")).toBeNull();
  });

  it("fetchCorridor parses methods, and returns null when the adapter has no such corridor", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/supported?country=CA": {
          country: "CA",
          fiat: "CAD",
          methods: [
            {
              paymentMethodType: "CREDIT_DEBIT_CARD",
              category: "card",
              min: "7",
              max: "8314",
              currency: "CAD",
              providers: ["TRANSAK"],
            },
          ],
        },
      }),
    );
    const { fetchCorridor } = await import("../lib/supported");
    const ca = await fetchCorridor("CA");
    expect(ca?.fiat).toBe("CAD"); // fiat resolved server-side, echoed back
    expect(ca?.methods[0]?.paymentMethodType).toBe("CREDIT_DEBIT_CARD");
    expect(await fetchCorridor("ZZ")).toBeNull(); // 404 -> null
  });

  it("does not cache an empty catalog: it stays retryable", async () => {
    const fetchMock = stubFetch({ "/supported/countries": { countries: [] } });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchSupportedCountries } = await import("../lib/supported");
    expect(await fetchSupportedCountries()).toEqual([]);
    await fetchSupportedCountries();
    const calls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/supported/countries"),
    ).length;
    expect(calls).toBe(2); // re-fetched, not served from a cached empty array
  });

  it("caches a non-empty catalog: one upstream call for repeat reads", async () => {
    const fetchMock = stubFetch({
      "/supported/countries": { countries: [{ country: "US", name: "United States" }] },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchSupportedCountries } = await import("../lib/supported");
    const a = await fetchSupportedCountries();
    const b = await fetchSupportedCountries();
    expect(a?.[0]).toEqual({ country: "US", name: "United States" });
    expect(b).toEqual(a);
    const calls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/supported/countries"),
    ).length;
    expect(calls).toBe(1);
  });

  it("flagEmoji maps an ISO code to its flag, and is safe on junk", async () => {
    const { flagEmoji } = await import("../lib/supported");
    expect(flagEmoji("US")).toBe("🇺🇸");
    expect(flagEmoji("ca")).toBe("🇨🇦"); // case-insensitive
    expect(flagEmoji("XYZ")).toBe("🏳️"); // not a 2-letter code -> neutral flag
  });
});
