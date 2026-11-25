// The offers store lists the direct network's tokens and learns the swap floors for the amount on
// screen. These seed the floors directly; the one learn they let through is faked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { TOKENS, type SourceId } from "@getsome/core";
import { egressFor, type SourceFloorResult } from "@getsome/chainflip";
import { useOffersStore } from "../app/stores/offers";
import { useSessionStore } from "../app/stores/session";
import { learnSourceFloors } from "../lib/source-floors";

vi.mock("../lib/source-floors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/source-floors")>()),
  learnSourceFloors: vi.fn(),
}));

const hosted = { value: false };
vi.mock("../lib/host-account", () => ({ isHosted: () => hosted.value }));
// A hosted build opens real channels only with the broker key; the tests have one.
vi.mock("../lib/chainflip-backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chainflip-backend")>()),
  brokerConfigured: () => true,
}));

const DOT = 10_000_000_000n;
const USDT = 1_000_000n;

function floor(
  sourceId: SourceId,
  minimumBaseUnits: bigint,
  worthDot: bigint,
  unit = DOT,
): SourceFloorResult {
  return {
    kind: "floor",
    floor: {
      sourceId,
      minimumBaseUnits,
      minimumEgressBaseUnits: worthDot * unit,
      etaSeconds: 600,
    },
  };
}

/** A 50 CASH purchase the pool sized at 100 DOT, or could not size when `nativeAmount` is null. */
function sized(session: ReturnType<typeof useSessionStore>, nativeAmount: bigint | null) {
  session.setAmount("50");
  session.loading = false;
  session.quoted = {
    send: "",
    symbol: "DOT",
    nativeAmount,
    depositToken: TOKENS.PAS,
    sourceAsset: null,
    sourceChain: null,
  };
}

/** The same purchase on the PSM tier: 50 CASH sized at 50 USDT. */
function sizedInUsdt(session: ReturnType<typeof useSessionStore>) {
  session.setAmount("50");
  session.loading = false;
  session.quoted = {
    send: "",
    symbol: "USDT",
    nativeAmount: 50n * USDT,
    depositToken: TOKENS.USDT,
    sourceAsset: null,
    sourceChain: null,
  };
}

const LEARNED = new Map<SourceId, SourceFloorResult>([
  ["btc", floor("btc", 40_000n, 160n)], // needs 160 DOT: too small for 100
  ["eth", floor("eth", 10n ** 16n, 25n)], // 25 DOT: fine
  ["usdc-eth", { kind: "unavailable", reason: "Quoting is currently unavailable" }],
  ["usdt-eth", floor("usdt-eth", 20_000_000n, 5n)],
  ["eth-arbitrum", floor("eth-arbitrum", 3_900_000_000_000_000n, 150n)],
  ["usdc-arbitrum", { kind: "unavailable", reason: "Quoting is currently unavailable" }],
  ["usdt-arbitrum", floor("usdt-arbitrum", 10_000_000n, 300n)],
  ["bnb-bsc", floor("bnb-bsc", 2n * 10n ** 16n, 250n)],
  ["usdt-bsc", floor("usdt-bsc", 10n * 10n ** 18n, 20n)], // 10 USDT in 18 decimals, 20 DOT: fine
  ["sol-solana", floor("sol-solana", 68_000_000n, 200n)],
  ["usdc-solana", floor("usdc-solana", 10_000_000n, 300n)],
  ["usdt-solana", floor("usdt-solana", 10_000_000n, 400n)],
  ["trx-tron", { kind: "unavailable", reason: "Chainflip lists no minimum for Tron TRX" }],
  ["usdt-tron", { kind: "unavailable", reason: "Quoting is currently unavailable" }],
]);

describe("offers store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(learnSourceFloors).mockReset();
    hosted.value = false;
  });

  it("offers the Polkadot tokens as direct deposits with no floor, before any floors and with the rail off", () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    offers.railEnabled = false;
    sized(session, 100n * DOT);
    const polkadot = offers.networks[0]!;
    expect(polkadot).toMatchObject({ chain: "Polkadot", label: "Polkadot", available: true });
    expect(polkadot.checking).toBe(false);
    expect(polkadot.tokens).toEqual([
      { asset: "DOT", sourceId: "dot-assethub", offer: { state: "direct" } },
      { asset: "dotUSD", sourceId: "dotusd-assethub", offer: { state: "direct" } },
      { asset: "USDT", sourceId: "usdt-assethub", offer: { state: "direct" } },
      { asset: "USDC", sourceId: "usdc-assethub", offer: { state: "direct" } },
    ]);
    expect(offers.offeredTokens("Polkadot").map((t) => t.asset)).toEqual([
      "DOT",
      "dotUSD",
      "USDT",
      "USDC",
    ]);
    expect(offers.offeredNetworks.map((n) => n.chain)).toEqual(["Polkadot"]);
  });

  it("is paused when Chainflip answered for nothing", () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    sized(session, 100n * DOT);
    offers.floors = new Map(
      [...LEARNED.keys()].map((id) => [id, { kind: "unavailable", reason: "maintenance" }]),
    );
    expect(offers.paused).toBe(true);
    // The direct network does not depend on Chainflip.
    expect(offers.offeredNetworks.map((n) => n.chain)).toEqual(["Polkadot"]);
  });

  it("keeps the floors a PSM-tier quote is held against apart from the pool's", () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    sized(session, 100n * DOT);
    offers.floors = LEARNED;

    sizedInUsdt(session);
    expect(offers.floors).toBeNull(); // nothing learned in USDT yet
    const inUsdt = new Map<SourceId, SourceFloorResult>([
      ["eth", floor("eth", 10n ** 16n, 25n, USDT)],
    ]);
    offers.floors = inUsdt;
    expect(offers.floors).toBe(inUsdt);

    sized(session, 100n * DOT); // back on the pool tier: its floors were kept
    expect(offers.floors).toBe(LEARNED);
  });

  it("asks for the tier's own asset before a quote has said, so the usual route costs one load", async () => {
    // Guessing the pool's native spent a load on floors the PSM route never uses.
    hosted.value = true;
    vi.mocked(learnSourceFloors).mockResolvedValue(LEARNED);
    await useOffersStore().learn();
    expect(learnSourceFloors).toHaveBeenCalledWith({ egress: egressFor(TOKENS.USDT) });

    setActivePinia(createPinia());
    hosted.value = false;
    await useOffersStore().learn();
    expect(learnSourceFloors).toHaveBeenLastCalledWith({ egress: egressFor(TOKENS.PAS) });
  });

  it("drops an answer for floors that were seeded while it was in flight", async () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    sized(session, 100n * DOT);
    const outage = new Map<SourceId, SourceFloorResult>([["eth", { kind: "unavailable" }]]);
    let answer: (v: ReadonlyMap<SourceId, SourceFloorResult>) => void = () => {};
    vi.mocked(learnSourceFloors).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const load = offers.learn();
    expect(offers.learning).toBe(true);
    offers.floors = LEARNED;
    answer(outage);
    await load;

    expect(offers.floors).toBe(LEARNED);
    expect(offers.learning).toBe(false);
  });

  it("learns the floors for an asset the first time a quote is sized in it", async () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    sized(session, 100n * DOT);
    offers.floors = LEARNED;
    const usdtFloors = new Map<SourceId, SourceFloorResult>([
      ["eth", floor("eth", 10n ** 16n, 25n, USDT)],
    ]);
    vi.mocked(learnSourceFloors).mockResolvedValueOnce(usdtFloors);

    sizedInUsdt(session);
    await nextTick();
    expect(learnSourceFloors).toHaveBeenCalledWith({ egress: egressFor(TOKENS.USDT) });
    expect(offers.learning).toBe(true);
    await offers.learn(); // joins the load in flight
    expect(offers.learning).toBe(false);
    expect(offers.floors).toBe(usdtFloors);
    // The pool tier's floors, already learned, are not asked for again.
    sized(session, 100n * DOT);
    await nextTick();
    expect(learnSourceFloors).toHaveBeenCalledTimes(1);
  });

  it("asks the floors again when a quote came back under a floor the rows did not show", async () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    sized(session, 100n * DOT);
    offers.floors = LEARNED;
    // ETH's floor moved past this purchase since the rows learned it; Chainflip said so on the
    // quote.
    const moved = new Map<SourceId, SourceFloorResult>([
      ...LEARNED,
      ["eth", floor("eth", 10n ** 17n, 250n)],
    ]);
    const fresh = Promise.resolve(moved);
    vi.mocked(learnSourceFloors).mockReturnValueOnce(fresh);
    session.sourcePrice = {
      kind: "minimum",
      minimum: {
        minimumFormatted: "0.1",
        assetSymbol: "ETH",
        minimumBaseUnits: 10n ** 17n,
        neededBaseUnits: 4n * 10n ** 16n,
        neededFormatted: "0.04",
      },
    };
    await nextTick();
    expect(learnSourceFloors).toHaveBeenCalledWith({ egress: egressFor(TOKENS.PAS) });
    await fresh;
    await nextTick();
    expect(offers.floors).toBe(moved);
  });
});
