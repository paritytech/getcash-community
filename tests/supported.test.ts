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

  it("fetchSupportedCorridors maps the bulk payload to a country -> corridor map", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/supported/corridors": {
          corridors: [
            {
              country: "US",
              fiat: "USD",
              methods: [
                {
                  paymentMethodType: "CREDIT_DEBIT_CARD",
                  category: "card",
                  min: "10",
                  max: "5000",
                  currency: "USD",
                  providers: ["TRANSAK"],
                },
              ],
            },
            { country: "", fiat: "XX", methods: [] }, // no country -> skipped
          ],
        },
      }),
    );
    const { fetchSupportedCorridors } = await import("../lib/supported");
    const map = await fetchSupportedCorridors();
    expect(map?.size).toBe(1); // the empty-country row is dropped
    expect(map?.get("US")?.methods[0]?.paymentMethodType).toBe("CREDIT_DEBIT_CARD");
    expect(map?.get("US")?.methods[0]?.currency).toBe("USD");
  });

  it("fetchSupportedCorridors caches a non-empty map and retries an empty one", async () => {
    const empty = stubFetch({ "/supported/corridors": { corridors: [] } });
    vi.stubGlobal("fetch", empty);
    const { fetchSupportedCorridors } = await import("../lib/supported");
    expect((await fetchSupportedCorridors())?.size).toBe(0);
    await fetchSupportedCorridors();
    const emptyCalls = empty.mock.calls.filter(([u]) =>
      String(u).includes("/supported/corridors"),
    ).length;
    expect(emptyCalls).toBe(2); // empty result not cached
  });

  it("fetchSupportedCorridors caches a non-empty result and returns null when unreachable", async () => {
    const ok = stubFetch({
      "/supported/corridors": {
        corridors: [{ country: "US", fiat: "USD", methods: [] }],
      },
    });
    vi.stubGlobal("fetch", ok);
    const { fetchSupportedCorridors } = await import("../lib/supported");
    await fetchSupportedCorridors();
    await fetchSupportedCorridors();
    const okCalls = ok.mock.calls.filter(([u]) =>
      String(u).includes("/supported/corridors"),
    ).length;
    expect(okCalls).toBe(1); // second read served from cache

    vi.resetModules();
    vi.stubEnv("VITE_MELD_BASE_URL", BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const reimport = await import("../lib/supported");
    expect(await reimport.fetchSupportedCorridors()).toBeNull(); // throw -> null
  });

  it("corridorOptions leaves every row plain and selectable when the map is null", async () => {
    const { corridorOptions } = await import("../lib/supported");
    const rows = corridorOptions([{ country: "US", name: "United States" }], null, "card");
    expect(rows).toEqual([{ country: "US", name: "United States" }]);
  });

  it("corridorOptions treats an empty map like null: rows stay plain, not all-disabled", async () => {
    const { corridorOptions } = await import("../lib/supported");
    const empty = new Map<string, SupportedCorridor>();
    const rows = corridorOptions([{ country: "US", name: "United States" }], empty, "card");
    // Cold cache must not grey out (and brick) every country.
    expect(rows).toEqual([{ country: "US", name: "United States" }]);
  });

  it("corridorOptions degrades to plain rows when a non-empty map would disable every row", async () => {
    const { corridorOptions } = await import("../lib/supported");
    // A disjoint map (covers only a country not in base, and only for card) must not brick the picker.
    const map = new Map<string, SupportedCorridor>([
      ["JP", { country: "JP", fiat: "JPY", methods: [] }],
    ]);
    const base = [
      { country: "US", name: "United States" },
      { country: "CA", name: "Canada" },
    ];
    const rows = corridorOptions(base, map, "card");
    expect(rows).toEqual(base); // all plain + selectable, no disabled rows
    expect(rows.some((r) => r.disabled)).toBe(false);
  });

  it("trimAmount trims trailing zeros without exponential notation on large bounds", async () => {
    const { corridorOptions } = await import("../lib/supported");
    const map = new Map<string, SupportedCorridor>([
      [
        "US",
        {
          country: "US",
          fiat: "USD",
          methods: [
            {
              paymentMethodType: "CREDIT_DEBIT_CARD",
              category: "card",
              min: "10.50",
              max: "1000000000000000000000",
              currency: "USD",
              providers: [],
            },
          ],
        },
      ],
    ]);
    const rows = corridorOptions([{ country: "US", name: "United States" }], map, "card");
    // No "1e+21"; trailing-zero trim keeps exact text.
    expect(rows[0]?.subLabel).toBe("10.5 to 1000000000000000000000 USD");
  });

  it("corridorOptions omits the limits hint when a supported method carries no bounds", async () => {
    const { corridorOptions } = await import("../lib/supported");
    const map = new Map<string, SupportedCorridor>([
      [
        "US",
        {
          country: "US",
          fiat: "USD",
          methods: [
            {
              paymentMethodType: "CREDIT_DEBIT_CARD",
              category: "card",
              min: "",
              max: "",
              currency: "USD",
              providers: [],
            },
          ],
        },
      ],
    ]);
    const rows = corridorOptions([{ country: "US", name: "United States" }], map, "card");
    // No misleading "0 to 0 USD"; the row is supported (selectable) with just its name.
    expect(rows[0]).toEqual({ country: "US", name: "United States", subLabel: undefined });
  });

  it("corridorOptions greys a row unsupported for the active method and labels its limits", async () => {
    const { corridorOptions } = await import("../lib/supported");
    const map = new Map<string, SupportedCorridor>([
      [
        "US",
        {
          country: "US",
          fiat: "USD",
          methods: [
            {
              paymentMethodType: "CREDIT_DEBIT_CARD",
              category: "card",
              min: "10.00",
              max: "5000",
              currency: "USD",
              providers: [],
            },
          ],
        },
      ],
      // GB carries a bank method so the bank view has a selectable row (not the all-disabled fallback).
      [
        "GB",
        {
          country: "GB",
          fiat: "GBP",
          methods: [
            {
              paymentMethodType: "SEPA",
              category: "bank",
              min: "15",
              max: "55650",
              currency: "GBP",
              providers: [],
            },
          ],
        },
      ],
    ]);
    const base = [
      { country: "US", name: "United States" },
      { country: "BR", name: "Brazil" },
      { country: "GB", name: "United Kingdom" },
    ];
    const card = corridorOptions(base, map, "card");
    expect(card[0]).toEqual({ country: "US", name: "United States", subLabel: "10 to 5000 USD" });
    expect(card[1]?.disabled).toBe(true); // BR absent from the map
    expect(card[1]?.subLabel).toBe("Not available for card");
    const bank = corridorOptions(base, map, "bank");
    expect(bank[0]?.disabled).toBe(true); // US has no bank method
    expect(bank[0]?.subLabel).toBe("Not available for bank transfer");
    expect(bank[2]).toEqual({
      country: "GB",
      name: "United Kingdom",
      subLabel: "15 to 55650 GBP",
    }); // GB bank is supported
  });

  it("nextSelectable steps to the next non-disabled row, wrapping, and firstSelectable finds the first", async () => {
    const { nextSelectable, firstSelectable } = await import("../lib/supported");
    const rows = [
      { country: "A", name: "A", disabled: true },
      { country: "B", name: "B" },
      { country: "C", name: "C", disabled: true },
      { country: "D", name: "D" },
    ];
    expect(firstSelectable(rows)).toBe(1); // skips the leading disabled
    expect(nextSelectable(rows, 1, 1)).toBe(3); // B -> D, skipping C
    expect(nextSelectable(rows, 3, 1)).toBe(1); // D wraps past A to B
    expect(nextSelectable(rows, 1, -1)).toBe(3); // B wraps back to D
    expect(nextSelectable([], 0, 1)).toBe(-1); // empty
    const allOff = [{ country: "A", name: "A", disabled: true }];
    expect(nextSelectable(allOff, 0, 1)).toBe(-1); // none selectable
    expect(firstSelectable(allOff)).toBe(-1);
  });
});
