// The direct ip-api.com region guess: one fetch per tab, hits cached, misses retried, and silence
// on any failure (`null`), because the callers all hold a locale fallback. Module reset per test
// clears the process-wide cache, as in supported.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answering = (status: number, body: unknown) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );

describe("lib/geo", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers ip-api's country and remembers it", async () => {
    const fetchMock = answering(200, {
      status: "success",
      country: "New Zealand",
      countryCode: "NZ",
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchGeoCountry, geoCountry } = await import("../lib/geo");
    expect(geoCountry()).toBeNull();
    await expect(fetchGeoCountry()).resolves.toBe("NZ");
    await expect(fetchGeoCountry()).resolves.toBe("NZ");
    expect(geoCountry()).toBe("NZ");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("http://ip-api.com/json", expect.anything());
  });

  it("shares one request between concurrent callers", async () => {
    const fetchMock = answering(200, { countryCode: "DE" });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchGeoCountry } = await import("../lib/geo");
    await expect(Promise.all([fetchGeoCountry(), fetchGeoCountry()])).resolves.toEqual([
      "DE",
      "DE",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers null on a body that is not a country, and asks again next call", async () => {
    // ip-api's failure shape: status "fail" and no countryCode; `country` alone must not pass.
    const fetchMock = answering(200, { status: "fail", country: "New Zealand" });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchGeoCountry, geoCountry } = await import("../lib/geo");
    await expect(fetchGeoCountry()).resolves.toBeNull();
    await expect(fetchGeoCountry()).resolves.toBeNull();
    expect(geoCountry()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers null on a non-2xx", async () => {
    vi.stubGlobal("fetch", answering(503, {}));
    const { fetchGeoCountry } = await import("../lib/geo");
    await expect(fetchGeoCountry()).resolves.toBeNull();
  });

  it("answers null when fetch itself fails (offline, or no Remote grant)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { fetchGeoCountry } = await import("../lib/geo");
    await expect(fetchGeoCountry()).resolves.toBeNull();
  });

  it("stops waiting for a slow lookup, which still fills the cache for the next caller", async () => {
    vi.useFakeTimers();
    try {
      let answer: ((response: Response) => void) | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
      );
      const { fetchGeoCountry, geoCountry } = await import("../lib/geo");
      const waited = fetchGeoCountry();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(waited).resolves.toBeNull();
      answer?.(
        new Response(JSON.stringify({ countryCode: "FR" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await vi.runAllTimersAsync();
      expect(geoCountry()).toBe("FR");
    } finally {
      vi.useRealTimers();
    }
  });
});
