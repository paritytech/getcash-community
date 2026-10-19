// A hosted card or bank top-up asks the region's providers about each route the chain ranks, on
// the region's corridor for that route's token, and keeps the first they quote. Its region dropdown
// reads both tokens' catalogs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { TOKENS, type MeldAssetId } from "@getsome/core";
import type { ConversionRoute } from "@getsome/funding";
import type { MeldClientLike } from "@getsome/meld";
import {
  createMemoryKeyedStorage,
  setMirrorStorage,
  setRecordStorage,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore } from "../app/stores/session";
import type { SupportedCorridor, SupportedCountry } from "../lib/supported";

const BURNER = "14uAyRtbeRsrgERPLETm72yFPKW3oi3m4RX93arNwGQhsduC";
const PSM: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 1_000 };
const USDT = TOKENS.USDT.meldAsset as MeldAssetId;
const DOT = TOKENS.PAS.meldAsset as MeldAssetId;

const { worlds, adapter, corridors, catalogs } = vi.hoisted(() => ({
  worlds: { builds: [] as string[], disposed: [] as string[] },
  /** Keyed by Meld's code for the token quoted. */
  adapter: new Map<string, { status: number; body: unknown }>(),
  /** The tokens whose corridor a quote read. */
  corridors: { reads: [] as string[], unrouted: new Set<string>() },
  /** The region dropdown's catalogs per token, and every read of them. */
  catalogs: {
    reads: [] as string[],
    countries: new Map<string, SupportedCountry[]>(),
    corridors: new Map<string, Map<string, SupportedCorridor>>(),
  },
}));
vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/worker-rpc", () => ({
  getStorageWorkerManager: () => ({ isAvailable: () => true, call: async () => {}, dispose() {} }),
}));
// The region's corridor per token: card routed unless a test has it not routed for that token.
vi.mock("../lib/supported", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/supported")>()),
  fetchCorridor: async (destination: string, country: string): Promise<SupportedCorridor> => {
    corridors.reads.push(destination);
    const card = {
      paymentMethodType: "CREDIT_DEBIT_CARD",
      category: "card" as const,
      min: "",
      max: "",
      currency: "USD",
      providers: [],
    };
    return { country, fiat: "USD", methods: corridors.unrouted.has(destination) ? [] : [card] };
  },
  fetchSupportedCountries: async (destination: string) => {
    catalogs.reads.push(`countries:${destination}`);
    return catalogs.countries.get(destination) ?? null;
  },
  fetchSupportedCorridors: async (destination: string) => {
    catalogs.reads.push(`corridors:${destination}`);
    return catalogs.corridors.get(destination) ?? null;
  },
}));
// The offline client prices every token, except where a test has the adapter answer otherwise,
// which the real client then reads as it would off the wire.
vi.mock("@getsome/meld", async (importOriginal) => {
  const original = await importOriginal<typeof import("@getsome/meld")>();
  return {
    ...original,
    createFakeMeldClient: (...args: Parameters<typeof original.createFakeMeldClient>) => {
      const fake = original.createFakeMeldClient(...args);
      const getQuote: MeldClientLike["getQuote"] = (req) => {
        const answer = adapter.get(req.destinationCurrencyCode);
        if (answer === undefined) return fake.getQuote(req);
        const fetchImpl = (async () =>
          new Response(JSON.stringify(answer.body), {
            status: answer.status,
          })) as unknown as typeof fetch;
        return original
          .createMeldClient({ baseUrl: "https://adapter.test", fetchImpl })
          .getQuote(req);
      };
      return { ...fake, getQuote };
    },
  };
});
// The hosted world over the offline fakes, on the Meld rail the quote built.
vi.mock("../lib/coinage-live", async () => {
  const { createMockCoinageSession } = await import("../lib/coinage");
  return {
    rankHostedRoutes: async () => [PSM, { tier: "pool" }],
    nextHostedTradeNumber: async () => 1,
    readHostedTradeCounter: async () => 1,
    readFlowSlot: async () => ({ address: BURNER, slot: null }),
    watchTradeBurner: async () => () => {},
    createHostedCoinageWorld: async (
      args: Parameters<typeof createMockCoinageSession>[0] & { route: ConversionRoute },
    ) => {
      const { tier } = args.route;
      worlds.builds.push(tier);
      const mock = await createMockCoinageSession({
        ...args,
        recipient: BURNER,
        nativeBudget: 50_000_000n,
      });
      return {
        ...mock,
        burnerAddress: BURNER,
        budget: 50_000_000n,
        runFunding: async () => {},
        readPurse: async () => 0n,
        readBurnerDepositOnAh: async () => 0n,
        exportBurnerSecret: async () => "0x",
        dispose: () => {
          worlds.disposed.push(tier);
          mock.session.dispose();
        },
      };
    },
  };
});

const noProvider = { status: 422, body: { error: { tag: "NoQuotesAvailable" } } };
const noProviderMessage =
  "Not available for this payment method in your region (United States). Try another method.";
const underMinimum = {
  status: 400,
  body: { error: { tag: "BelowMinimum", value: { amount: "30", currency: "USD" } } },
};
const outage = { status: 503, body: { error: { tag: "ProviderTimeout" } } };
const emptyList = { status: 200, body: { quotes: [] } };

describe("a hosted Meld quote", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    worlds.builds.length = 0;
    worlds.disposed.length = 0;
    corridors.reads.length = 0;
    corridors.unrouted.clear();
    catalogs.reads.length = 0;
    catalogs.countries.clear();
    catalogs.corridors.clear();
    adapter.clear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setMirrorStorage(null);
  });

  it.each([
    { name: "USDT accepted", read: [USDT], asked: ["psm"], landed: "psm" },
    {
      name: "USDT not routed for the method, DOT accepted",
      unrouted: [USDT],
      read: [USDT, DOT],
      asked: ["pool"],
      landed: "pool",
    },
    {
      name: "no provider quotes USDT, DOT accepted",
      usdt: noProvider,
      read: [USDT, DOT],
      asked: ["psm", "pool"],
      landed: "pool",
    },
    {
      name: "USDT under every provider's minimum, DOT accepted",
      usdt: underMinimum,
      read: [USDT, DOT],
      asked: ["psm", "pool"],
      landed: "pool",
    },
    {
      name: "the adapter down on USDT",
      usdt: outage,
      read: [USDT],
      asked: ["psm"],
      error: "Couldn't reach the payment provider. Please try again.",
    },
    { name: "neither routed for the method", unrouted: [USDT, DOT], read: [USDT, DOT], asked: [] },
    {
      name: "neither quoted",
      usdt: noProvider,
      dot: emptyList,
      read: [USDT, DOT],
      asked: ["psm", "pool"],
      error: noProviderMessage,
    },
  ])("$name", async ({ unrouted, usdt, dot, read, asked, landed, error }) => {
    for (const asset of unrouted ?? []) corridors.unrouted.add(asset);
    if (usdt) adapter.set(TOKENS.USDT.meldCurrencyCode as string, usdt);
    if (dot) adapter.set(TOKENS.PAS.meldCurrencyCode as string, dot);
    const session = useSessionStore();
    session.setMethod("card");
    session.setAmount("50");
    await session.fetchMeldQuote();
    expect(corridors.reads).toEqual(read);
    expect(worlds.builds).toEqual(asked);
    // Every world but the one kept is let go.
    expect(worlds.disposed).toEqual(landed === undefined ? asked : asked.slice(0, -1));
    expect(session.live?.route.tier).toBe(landed);
    expect(session.meldMethodUnavailable).toBe(landed === undefined && error === undefined);
    expect(session.quoteError).toBe(error ?? null);
    expect(session.quoteFailures).toBe(error === undefined ? 0 : 1);
  });

  it("judges the region dropdown on both tokens' catalogs, whichever route quotes", async () => {
    const card = (min: string) => ({
      paymentMethodType: "CREDIT_DEBIT_CARD",
      category: "card" as const,
      min,
      max: "5000",
      currency: "EUR",
      providers: [],
    });
    catalogs.countries.set(USDT, [{ country: "DE", name: "Germany" }]);
    catalogs.countries.set(DOT, [
      { country: "BR", name: "Brazil" },
      { country: "DE", name: "Germany" },
    ]);
    catalogs.corridors.set(
      USDT,
      new Map([["DE", { country: "DE", fiat: "EUR", methods: [card("20")] }]]),
    );
    catalogs.corridors.set(
      DOT,
      new Map([
        ["BR", { country: "BR", fiat: "EUR", methods: [card("30")] }],
        ["DE", { country: "DE", fiat: "EUR", methods: [card("15")] }],
      ]),
    );
    const session = useSessionStore();
    await Promise.all([session.loadSupportedCountries(), session.loadSupportedCorridors()]);
    expect(catalogs.reads.sort()).toEqual(
      [`corridors:${DOT}`, `corridors:${USDT}`, `countries:${DOT}`, `countries:${USDT}`].sort(),
    );
    expect(session.supportedCountries?.map((c) => c.country)).toEqual(["BR", "DE"]);
    expect(session.corridorByCountry?.get("BR")?.methods[0]?.min).toBe("30");
    expect(session.corridorByCountry?.get("DE")?.methods[0]?.min).toBe("15");

    // A quote that lands on DOT leaves the dropdown as it is.
    corridors.unrouted.add(USDT);
    session.setMethod("card");
    session.setAmount("50");
    await session.fetchMeldQuote();
    expect(session.live?.route.tier).toBe("pool");
    expect(catalogs.reads).toHaveLength(4);
  });
});
