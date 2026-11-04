// The live-capability catalog client: parsing, per-corridor caching and its expiry, the card/bank
// resolver, and the empty-catalog-is-retryable rule. Each test resets modules to clear the process-wide caches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupportedCorridor } from "../lib/supported";
import { installTestMeldAssets } from "./setup-meld-assets";

/** The catalog is keyed by destination asset; these cases all read the pool tier's, which Meld
 *  calls DOT. See lib/supported.ts. */
const DEST = "dot@assethub";

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
  beforeEach(async () => {
    vi.resetModules();
    await installTestMeldAssets();
    vi.stubEnv("VITE_MELD_BASE_URL", BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
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

  it("isMethodDown says whether the corridor's method has every provider failing", async () => {
    const { isMethodDown } = await import("../lib/supported");
    const method = (category: "card" | "bank", down = false) => ({
      paymentMethodType: category,
      category,
      min: "5",
      max: "3000",
      currency: "EUR",
      providers: [],
      ...(down ? { temporarilyUnavailable: true as const } : {}),
    });
    const corridor = {
      country: "DE",
      fiat: "EUR",
      methods: [method("card"), method("bank", true)],
    };
    expect(isMethodDown(corridor, "bank")).toBe(true);
    expect(isMethodDown(corridor, "card")).toBe(false);
    expect(isMethodDown(null, "card")).toBe(false);
  });

  it("asks for a destination under the code the adapter's table names it by", async () => {
    const fetchSpy = stubFetch({
      "/supported/countries": { countries: [{ country: "US", name: "US" }] },
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { fetchSupportedCountries } = await import("../lib/supported");
    await fetchSupportedCountries(DEST);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("destinationCurrencyCode=DOT");
  });

  it("reads the table from the adapter first when the page has none, and asks nothing without it", async () => {
    vi.resetModules();
    const fetchSpy = stubFetch({
      "/assets": { assets: [{ asset: "dot@assethub", code: "DOT_FROM_ADAPTER" }] },
      "/supported/countries": { countries: [{ country: "US", name: "US" }] },
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { fetchSupportedCountries, fetchCorridor } = await import("../lib/supported");
    expect(await fetchSupportedCountries(DEST)).toHaveLength(1);
    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toBe(`${BASE}/assets`);
    expect(urls[1]).toContain("destinationCurrencyCode=DOT_FROM_ADAPTER");
    // An asset the adapter does not serve has no code to ask under: no catalog, and no request.
    expect(await fetchCorridor("usdt@assethub", "US")).toBeNull();
    expect(fetchSpy.mock.calls).toHaveLength(2);
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
    const ca = await fetchCorridor(DEST, "CA");
    expect(ca?.fiat).toBe("CAD"); // fiat resolved server-side, echoed back
    expect(ca?.methods[0]?.paymentMethodType).toBe("CREDIT_DEBIT_CARD");
    expect(await fetchCorridor(DEST, "ZZ")).toBeNull(); // 404 -> null
  });

  it("does not cache an empty catalog: it stays retryable", async () => {
    const fetchMock = stubFetch({ "/supported/countries": { countries: [] } });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchSupportedCountries } = await import("../lib/supported");
    expect(await fetchSupportedCountries(DEST)).toEqual([]);
    await fetchSupportedCountries(DEST);
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
    const a = await fetchSupportedCountries(DEST);
    const b = await fetchSupportedCountries(DEST);
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
    const map = await fetchSupportedCorridors(DEST);
    expect(map?.size).toBe(1); // the empty-country row is dropped
    expect(map?.get("US")?.methods[0]?.paymentMethodType).toBe("CREDIT_DEBIT_CARD");
    expect(map?.get("US")?.methods[0]?.currency).toBe("USD");
  });

  it("reads a method the adapter's probes find down, and counts one without a flag as available", async () => {
    const method = (category: string, availability?: string) => ({
      paymentMethodType: category,
      category,
      min: "5",
      max: "3000",
      currency: "USD",
      ...(availability === undefined ? {} : { availability }),
    });
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/supported/corridors": {
          corridors: [
            {
              country: "US",
              fiat: "USD",
              methods: [
                method("card", "temporarily_unavailable"),
                method("bank", "available"),
                method("wallet"),
              ],
            },
          ],
        },
      }),
    );
    const { fetchSupportedCorridors } = await import("../lib/supported");
    const methods = (await fetchSupportedCorridors(DEST))?.get("US")?.methods ?? [];
    expect(methods.map((m) => m.temporarilyUnavailable)).toEqual([true, undefined, undefined]);
  });

  it("unservedMethods names a method no region offers right now, and none while unread", async () => {
    const { unservedMethods } = await import("../lib/supported");
    const method = (category: "card" | "bank", down = false) => ({
      paymentMethodType: category,
      category,
      min: "5",
      max: "3000",
      currency: "EUR",
      providers: [],
      ...(down ? { temporarilyUnavailable: true as const } : {}),
    });
    const corridors = new Map<string, SupportedCorridor>([
      ["DE", { country: "DE", fiat: "EUR", methods: [method("card", true), method("bank")] }],
      ["FR", { country: "FR", fiat: "EUR", methods: [method("card", true)] }],
    ]);
    expect(unservedMethods(corridors)).toEqual(["card"]);
    corridors.set("ES", { country: "ES", fiat: "EUR", methods: [method("card")] });
    expect(unservedMethods(corridors)).toEqual([]);
    expect(unservedMethods(new Map([["JP", { country: "JP", fiat: "JPY", methods: [] }]]))).toEqual(
      ["card", "bank"],
    );
    expect(unservedMethods(null)).toEqual([]);
    expect(unservedMethods(new Map())).toEqual([]);
  });

  it("reuses a corridor read for ten minutes, then reads it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const us = { country: "US", fiat: "USD", methods: [] };
    const fetchMock = stubFetch({
      "/supported/corridors": { corridors: [us] },
      "/supported/offramp/corridors": { corridors: [us] },
      "/supported/offramp?country=US": us,
      "/supported?country=US": us,
    });
    vi.stubGlobal("fetch", fetchMock);
    const lib = await import("../lib/supported");
    const readAll = () =>
      Promise.all([
        lib.fetchCorridor(DEST, "US"),
        lib.fetchSupportedCorridors(DEST),
        lib.fetchOfframpCorridors(),
        lib.fetchOfframpCorridor("US"),
      ]);

    await readAll();
    vi.setSystemTime(Date.now() + 599_999);
    await readAll();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    vi.setSystemTime(Date.now() + 1);
    await readAll();
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("answers the last catalog read when a later read fails or comes back empty", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const us = { country: "US", fiat: "USD", methods: [] };
    const gb = { country: "GB", fiat: "GBP", methods: [] };
    const json = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
    let answer: () => Promise<Response> = json({ corridors: [us, gb] });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => answer()),
    );
    const lib = await import("../lib/supported");
    const countries = async () =>
      (await Promise.all([lib.fetchSupportedCorridors(DEST), lib.fetchOfframpCorridors()])).map(
        (map) => [...(map?.keys() ?? [])],
      );
    expect(await countries()).toEqual([
      ["US", "GB"],
      ["US", "GB"],
    ]);

    const failures = [
      async () => {
        throw new Error("timeout");
      },
      async () => new Response("unavailable", { status: 503 }),
      json({ corridors: [] }),
    ];
    for (const failure of failures) {
      answer = failure;
      vi.setSystemTime(Date.now() + 600_000);
      expect(await countries()).toEqual([
        ["US", "GB"],
        ["US", "GB"],
      ]);
    }

    answer = json({ corridors: [us] });
    vi.setSystemTime(Date.now() + 600_000);
    expect(await countries()).toEqual([["US"], ["US"]]);
  });

  it("keeps a token's regions and methods in the merged catalog when that token's read fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const card = (down: boolean) => ({
      paymentMethodType: "CREDIT_DEBIT_CARD",
      category: "card",
      min: "10",
      max: "5000",
      currency: "GBP",
      providers: [],
      ...(down ? { availability: "temporarily_unavailable" } : {}),
    });
    // USDT routes card in the UK and Brazil; DOT routes card in the UK only, and it is down there.
    const catalogs: Record<string, unknown[]> = {
      USDT_DOT: [
        { country: "GB", fiat: "GBP", methods: [card(false)] },
        { country: "BR", fiat: "BRL", methods: [card(false)] },
      ],
      DOT: [{ country: "GB", fiat: "GBP", methods: [card(true)] }],
    };
    let usdtFails = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const code = new URL(url).searchParams.get("destinationCurrencyCode") ?? "";
        if (code === "USDT_DOT" && usdtFails) throw new Error("timeout");
        return new Response(JSON.stringify({ corridors: catalogs[code] }), { status: 200 });
      }),
    );
    const lib = await import("../lib/supported");
    const merged = async () =>
      lib.mergeCorridorMaps(
        await lib.fetchSupportedCorridors("usdt@assethub"),
        await lib.fetchSupportedCorridors(DEST),
      );
    await merged();

    usdtFails = true;
    vi.setSystemTime(Date.now() + 600_000);
    const catalog = await merged();
    expect([...(catalog?.keys() ?? [])].sort()).toEqual(["BR", "GB"]);
    expect(lib.isMethodDown(catalog?.get("GB") ?? null, "card")).toBe(false);
  });

  it("reads a country's corridor again while a method is down, and reuses it once all are up", async () => {
    const card = (down: boolean) => ({
      paymentMethodType: "CREDIT_DEBIT_CARD",
      category: "card",
      min: "10",
      max: "5000",
      currency: "GBP",
      providers: [],
      ...(down ? { availability: "temporarily_unavailable" } : {}),
    });
    let down = true;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ country: "GB", fiat: "GBP", methods: [card(down)] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const lib = await import("../lib/supported");
    const read = () => Promise.all([lib.fetchCorridor(DEST, "GB"), lib.fetchOfframpCorridor("GB")]);

    const [buy, sell] = await read();
    expect(lib.isMethodDown(buy, "card")).toBe(true);
    expect(lib.isMethodDown(sell, "card")).toBe(true);
    down = false;
    const [recovered] = await read();
    expect(lib.isMethodDown(recovered, "card")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await read();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fetchSupportedCorridors caches a non-empty map and retries an empty one", async () => {
    const empty = stubFetch({ "/supported/corridors": { corridors: [] } });
    vi.stubGlobal("fetch", empty);
    const { fetchSupportedCorridors } = await import("../lib/supported");
    expect((await fetchSupportedCorridors(DEST))?.size).toBe(0);
    await fetchSupportedCorridors(DEST);
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
    await fetchSupportedCorridors(DEST);
    await fetchSupportedCorridors(DEST);
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
    expect(await reimport.fetchSupportedCorridors(DEST)).toBeNull(); // throw -> null
  });

  it("corridorOptions offers no rows while the corridors are unread or cold", async () => {
    const { corridorOptions } = await import("../lib/supported");
    const base = [{ country: "US", name: "United States" }];
    expect(corridorOptions(base, null, "card")).toBeNull();
    expect(corridorOptions(base, new Map(), "card")).toBeNull();
  });

  it("corridorOptions lists every region, greying one the method does not route", async () => {
    const { corridorOptions } = await import("../lib/supported");
    const method = (paymentMethodType: string, category: "card" | "bank", currency: string) => ({
      paymentMethodType,
      category,
      min: "",
      max: "",
      currency,
      providers: [],
    });
    const corridors = new Map<string, SupportedCorridor>([
      ["DE", { country: "DE", fiat: "EUR", methods: [method("SEPA", "bank", "EUR")] }],
      ["IN", { country: "IN", fiat: "INR", methods: [method("CREDIT_DEBIT_CARD", "card", "INR")] }],
    ]);
    const rows = corridorOptions(
      [
        { country: "DE", name: "Germany" },
        { country: "IN", name: "India" },
      ],
      corridors,
      "bank",
    )!;
    expect(rows.map((r) => [r.country, r.disabled === true])).toEqual([
      ["DE", false],
      ["IN", true],
    ]);
  });

  it("corridorOptions disables every row when no region routes the method", async () => {
    const { corridorOptions } = await import("../lib/supported");
    // A disjoint map (covers only a country not in base, and only for card) must not brick the picker.
    const map = new Map<string, SupportedCorridor>([
      ["JP", { country: "JP", fiat: "JPY", methods: [] }],
    ]);
    const base = [
      { country: "US", name: "United States" },
      { country: "CA", name: "Canada" },
    ];
    const rows = corridorOptions(base, map, "card")!;
    expect(rows.every((r) => r.disabled)).toBe(true);
  });

  it("corridorOptions marks a region whose providers are all failing, without its minimum", async () => {
    const { corridorOptions, isPickable } = await import("../lib/supported");
    const card = {
      paymentMethodType: "CREDIT_DEBIT_CARD",
      category: "card" as const,
      min: "20",
      max: "15000",
      currency: "EUR",
      providers: [],
    };
    const map = new Map<string, SupportedCorridor>([
      ["DE", { country: "DE", fiat: "EUR", methods: [{ ...card, temporarilyUnavailable: true }] }],
      ["FR", { country: "FR", fiat: "EUR", methods: [card] }],
    ]);
    const rows = corridorOptions(
      [
        { country: "DE", name: "Germany" },
        { country: "FR", name: "France" },
      ],
      map,
      "card",
    )!;
    expect(rows[0]).toEqual({
      country: "DE",
      name: "Germany",
      fiat: "EUR",
      temporarilyUnavailable: true,
    });
    expect(rows.map(isPickable)).toEqual([false, true]);
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
    const { trimAmount } = await import("../lib/supported");
    const rows = corridorOptions([{ country: "US", name: "United States" }], map, "card")!;
    // The option carries the raw min; trimAmount trims for display without exponential notation.
    expect(rows[0]).toEqual({
      country: "US",
      name: "United States",
      min: "10.50",
      fiat: "USD",
    });
    expect(trimAmount("10.50")).toBe("10.5");
    expect(trimAmount("1000000000000000000000")).toBe("1000000000000000000000"); // not "1e+21"
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
    const rows = corridorOptions([{ country: "US", name: "United States" }], map, "card")!;
    // No misleading "0" min; the row is supported (selectable), named with the currency it charges.
    expect(rows[0]).toEqual({ country: "US", name: "United States", fiat: "USD" });
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
    const card = corridorOptions(base, map, "card")!;
    expect(card[0]).toEqual({
      country: "US",
      name: "United States",
      min: "10.00",
      fiat: "USD",
    });
    expect(card[1]).toEqual({ country: "BR", name: "Brazil", disabled: true }); // BR absent from the map
    const bank = corridorOptions(base, map, "bank")!;
    // US has no bank method: greyed, but still named by the currency the region charges.
    expect(bank[0]).toEqual({ country: "US", name: "United States", fiat: "USD", disabled: true });
    expect(bank[2]).toEqual({ country: "GB", name: "United Kingdom", min: "15", fiat: "GBP" }); // GB bank supported
  });

  it("corridorOptions greys a corridor whose minimum is above what this purchase pays", async () => {
    const { corridorOptions } = await import("../lib/supported");
    const method = (category: "card" | "bank", min: string, currency: string) => ({
      paymentMethodType: "CREDIT_DEBIT_CARD",
      category,
      min,
      max: "5000",
      currency,
      providers: [],
    });
    const map = new Map<string, SupportedCorridor>([
      ["GB", { country: "GB", fiat: "GBP", methods: [method("card", "40", "GBP")] }],
      ["US", { country: "US", fiat: "USD", methods: [method("card", "40", "USD")] }],
      ["DE", { country: "DE", fiat: "EUR", methods: [method("card", "4", "EUR")] }],
    ]);
    const base = [
      { country: "GB", name: "United Kingdom" },
      { country: "US", name: "United States" },
      { country: "DE", name: "Germany" },
    ];
    // Paying £12.50: GBP 40 is out of reach, EUR 4 is not, and USD 40 is in another currency
    // altogether — no rate to cross with, so it stays pickable rather than guessed at.
    const rows = corridorOptions(base, map, "card", { fiat: "GBP", amount: "12.50" })!;
    expect(rows[0]?.belowMinimum).toBe(true);
    expect(rows[1]?.belowMinimum).toBeUndefined();
    expect(rows[2]?.belowMinimum).toBeUndefined();
    // No floor at all, and an unreadable one, leave every row pickable.
    expect(corridorOptions(base, map, "card")!.some((r) => r.belowMinimum)).toBe(false);
    const blank = corridorOptions(base, map, "card", { fiat: "GBP", amount: "" })!;
    expect(blank.some((r) => r.belowMinimum)).toBe(false);
  });

  const method = (
    category: "card" | "bank",
    min: string,
    max: string,
    currency = "USD",
    providers = ["TRANSAK"],
  ) => ({ paymentMethodType: category, category, min, max, currency, providers });
  const down = (m: ReturnType<typeof method>) => ({ ...m, temporarilyUnavailable: true as const });
  const corridor = (fiat: string, ...methods: ReturnType<typeof method>[]) => ({
    country: "DE",
    fiat,
    methods,
  });

  it.each([
    {
      name: "a method only USDT routes",
      usdt: corridor("USD", method("card", "10", "500")),
      pas: corridor("USD", method("bank", "20", "900")),
      want: corridor("USD", method("card", "10", "500"), method("bank", "20", "900")),
    },
    {
      name: "a method only PAS routes",
      usdt: corridor("USD"),
      pas: corridor("USD", method("card", "5", "300")),
      want: corridor("USD", method("card", "5", "300")),
    },
    {
      name: "both route it: the smaller minimum and the larger maximum",
      usdt: corridor("USD", method("card", "10.5", "500")),
      pas: corridor("USD", method("card", "9.75", "300", "USD", ["MOONPAY", "TRANSAK"])),
      want: corridor("USD", method("card", "9.75", "500", "USD", ["TRANSAK", "MOONPAY"])),
    },
    {
      name: "a bound one side does not give",
      usdt: corridor("USD", method("card", "", "500")),
      pas: corridor("USD", method("card", "5", "300")),
      want: corridor("USD", method("card", "", "500")),
    },
    {
      name: "different fiats: USDT's bounds where it routes the method, else PAS's",
      usdt: corridor("USD", method("card", "10", "500")),
      pas: corridor("EUR", method("card", "5", "900", "EUR"), method("bank", "20", "900", "EUR")),
      want: corridor("USD", method("card", "10", "500"), method("bank", "20", "900", "EUR")),
    },
    {
      name: "only PAS's method is available: it stands alone",
      usdt: corridor("USD", down(method("card", "10", "500"))),
      pas: corridor("USD", method("card", "5", "300")),
      want: corridor("USD", method("card", "5", "300")),
    },
    {
      name: "only USDT's method is available: it stands alone",
      usdt: corridor("USD", method("card", "10", "500")),
      pas: corridor("USD", down(method("card", "5", "900"))),
      want: corridor("USD", method("card", "10", "500")),
    },
    {
      name: "neither is available: widened, and still unavailable",
      usdt: corridor("USD", down(method("card", "10", "500"))),
      pas: corridor("USD", down(method("card", "5", "900"))),
      want: corridor("USD", down(method("card", "5", "900"))),
    },
    {
      name: "USDT unreachable",
      usdt: null,
      pas: corridor("USD", method("card", "5", "300")),
      want: corridor("USD", method("card", "5", "300")),
    },
    {
      name: "PAS unreachable",
      usdt: corridor("USD", method("card", "10", "500")),
      pas: null,
      want: corridor("USD", method("card", "10", "500")),
    },
  ])("mergeCorridor: $name", async ({ usdt, pas, want }) => {
    const { mergeCorridor } = await import("../lib/supported");
    expect(mergeCorridor(usdt, pas)).toEqual(want);
  });

  it.each([
    { name: "both answer", usdt: ["DE", "US"], pas: ["BR", "DE"], want: ["BR", "DE", "US"] },
    { name: "USDT unreachable", usdt: null, pas: ["BR", "DE"], want: ["BR", "DE"] },
    { name: "PAS unreachable", usdt: ["DE", "US"], pas: null, want: ["DE", "US"] },
    { name: "neither answers", usdt: null, pas: null, want: null },
  ])("mergeCountries: $name", async ({ usdt, pas, want }) => {
    const { mergeCountries, countryName } = await import("../lib/supported");
    const rows = (codes: string[] | null) =>
      codes && codes.map((country) => ({ country, name: countryName(country) }));
    expect(mergeCountries(rows(usdt), rows(pas))?.map((c) => c.country) ?? null).toEqual(want);
  });

  it("namedCountry prefers the catalog's own name, then Intl's, then the code", async () => {
    const { namedCountry } = await import("../lib/supported");
    const catalog = [{ country: "GB", name: "United Kingdom of Great Britain" }];
    expect(namedCountry("GB", catalog)).toBe("United Kingdom of Great Britain"); // catalog wins
    expect(namedCountry("BR", catalog)).toBe("Brazil"); // absent from the catalog: Intl names it
    expect(namedCountry("BR", null)).toBe("Brazil"); // no catalog at all
    expect(namedCountry("ZZZ", null)).toBe("ZZZ"); // not a region code: itself
  });

  it("regionGroups pins the detected region and sections the rest by why they cannot be picked", async () => {
    const { regionGroups } = await import("../lib/supported");
    const rows = [
      { country: "US", name: "United States", min: "5", fiat: "USD" },
      { country: "GB", name: "United Kingdom", min: "4", fiat: "GBP" },
      { country: "BR", name: "Brazil", fiat: "BRL", disabled: true },
      { country: "AU", name: "Australia", min: "70", fiat: "AUD", belowMinimum: true },
      { country: "DE", name: "Germany", fiat: "EUR", temporarilyUnavailable: true as const },
    ];
    const groups = regionGroups(rows, "GB");
    expect(groups.map((g) => g.title)).toEqual([
      "Detected country",
      "Or choose another country",
      "Minimum payment amount",
      "Temporarily unavailable",
      "Unsupported country",
    ]);
    expect(groups[0]?.rows.map((r) => r.country)).toEqual(["GB"]);
    expect(groups[1]?.rows.map((r) => r.country)).toEqual(["US"]);
    expect(groups[2]?.rows.map((r) => r.country)).toEqual(["AU"]);
    expect(groups[3]?.rows.map((r) => r.country)).toEqual(["DE"]);
    expect(groups[4]?.rows.map((r) => r.country)).toEqual(["BR"]);
  });

  it("regionGroups never pins a region that cannot be picked, and drops empty sections", async () => {
    const { regionGroups } = await import("../lib/supported");
    const rows = [
      { country: "US", name: "United States", min: "5", fiat: "USD" },
      { country: "AU", name: "Australia", min: "70", fiat: "AUD", belowMinimum: true },
    ];
    // The device's own region is out of reach at this amount: it stays in its section rather than
    // leading the list as something to tap.
    expect(
      regionGroups(
        [{ country: "DE", name: "Germany", temporarilyUnavailable: true as const }],
        "DE",
      ).map((g) => g.title),
    ).toEqual(["Temporarily unavailable"]);
    // With no pin there is nothing to choose "another" of, so the list names itself.
    expect(regionGroups(rows, "AU").map((g) => g.title)).toEqual([
      "All countries",
      "Minimum payment amount",
    ]);
    expect(regionGroups([], "US")).toEqual([]);
  });

  it("regionGroups leads the matches unheaded while a filter is running", async () => {
    const { regionGroups } = await import("../lib/supported");
    const rows = [
      { country: "GB", name: "United Kingdom", min: "4", fiat: "GBP" },
      { country: "BR", name: "Brazil", fiat: "BRL", disabled: true },
    ];
    const groups = regionGroups(rows, "GB", true);
    // No pin, and the search's answer leads without a heading; the reasons keep theirs.
    expect(groups.map((g) => g.title)).toEqual([null, "Unsupported country"]);
    expect(groups[0]?.rows.map((r) => r.country)).toEqual(["GB"]);
  });

  it("reads the off-ramp catalog with each method's lane, and caches only a non-empty one", async () => {
    const body = {
      corridors: [
        {
          country: "DE",
          name: "Germany",
          fiat: "EUR",
          methods: [
            {
              paymentMethodType: "SEPA",
              category: "bank",
              min: "20",
              max: "5000",
              currency: "EUR",
              lanes: [{ code: "DOT", chain: "assethub", min: "20", max: "5000" }],
            },
            {
              paymentMethodType: "PAYOUT_TO_CARD",
              category: "card",
              min: "10",
              max: "2000",
              currency: "EUR",
              lanes: [
                { code: "USDC_ARBITRUM", chain: "arbitrum", min: "10", max: "2000" },
                { code: "USDC_SOLANA", chain: "solana" },
              ],
            },
          ],
        },
        { country: "", fiat: "EUR", methods: [] },
      ],
    };
    const fetchMock = stubFetch({ "/supported/offramp/corridors": body });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchOfframpCorridors } = await import("../lib/supported");
    const map = await fetchOfframpCorridors();
    expect([...map!.keys()]).toEqual(["DE"]);
    expect(map!.get("DE")).toMatchObject({ name: "Germany", fiat: "EUR" });
    expect(map!.get("DE")!.methods.map((m) => m.lanes)).toEqual([
      [{ code: "DOT", chain: "assethub", min: "20", max: "5000" }],
      [
        { code: "USDC_ARBITRUM", chain: "arbitrum", min: "10", max: "2000" },
        { code: "USDC_SOLANA", chain: "solana" },
      ],
    ]);
    await fetchOfframpCorridors();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads one country's off-ramp corridor, dropping malformed lanes", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/supported/offramp?country=BR": {
          country: "BR",
          fiat: "BRL",
          methods: [
            {
              paymentMethodType: "PIX",
              category: "bank",
              min: "5",
              max: "900",
              lanes: [{ code: "" }, null, { code: "USDC_SOLANA", chain: "solana" }],
            },
          ],
        },
      }),
    );
    const { fetchOfframpCorridor, fetchOfframpCorridors } = await import("../lib/supported");
    const corridor = await fetchOfframpCorridor("BR");
    expect(corridor).toMatchObject({ country: "BR", fiat: "BRL" });
    expect(corridor!.methods[0]!.lanes).toEqual([{ code: "USDC_SOLANA", chain: "solana" }]);
    expect(corridor!.methods[0]!.currency).toBe("BRL");
    // An unreachable catalog is null, not empty.
    expect(await fetchOfframpCorridors()).toBeNull();
  });

  it("names a country after 'in', with 'the' where English needs it", async () => {
    const { inCountry } = await import("../lib/supported");
    expect(inCountry("Germany")).toBe("in Germany");
    expect(inCountry("United Kingdom")).toBe("in the United Kingdom");
    expect(inCountry("Dominican Republic")).toBe("in the Dominican Republic");
    expect(inCountry("Cayman Islands")).toBe("in the Cayman Islands");
    expect(inCountry("Netherlands")).toBe("in the Netherlands");
  });
});
