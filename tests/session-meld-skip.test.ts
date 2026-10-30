// The demo's Skip on a hosted card or bank top-up behaves as Skip does on every route: the press
// stamps the request and sends the faucet's deposit at once, and the screen plays the provider's
// steps on top. Nothing but the press stamps it, and the faucet's state is the stamped request's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { ConversionRoute } from "@getsome/funding";
import { createMemoryKeyedStorage, setRecordStorage } from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore } from "../app/stores/session";
import type { SupportedCorridor } from "../lib/supported";

const BURNER = "14uAyRtbeRsrgERPLETm72yFPKW3oi3m4RX93arNwGQhsduC";
const PSM: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 1_000 };

const { faucet, trades } = vi.hoisted(() => ({
  /** The number the next request is given. */
  trades: { next: 1 },
  faucet: {
    calls: [] as unknown[],
    /** What the next transfer waits on before it is broadcast; a rejection is a refusal. */
    broadcast: (): Promise<void> => Promise.resolve(),
  },
}));
vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/worker-rpc", () => ({
  getStorageWorkerManager: () => ({ isAvailable: () => true, call: async () => {}, dispose() {} }),
}));
vi.mock("../lib/faucet", () => ({
  isFaucetConfigured: () => true,
  fundFromFaucet: async (args: unknown) => {
    faucet.calls.push(args);
    await faucet.broadcast();
  },
}));
vi.mock("../lib/supported", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/supported")>()),
  fetchCorridor: async (_destination: string, country: string): Promise<SupportedCorridor> => ({
    country,
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
  }),
}));
// The hosted world over the offline fakes, on the Meld rail the quote built, with an empty burner.
vi.mock("../lib/coinage-live", async () => {
  const { createMockCoinageSession } = await import("../lib/coinage");
  return {
    rankHostedRoutes: async () => [PSM],
    nextHostedTradeNumber: async () => trades.next++,
    ensureChainSubmitGrant: async () => {},
    readHostedTradeCounter: async () => 1,
    readFlowSlot: async () => ({ address: BURNER, slot: null }),
    probeTradeBurner: async () => ({ address: BURNER, free: 0n }),
    lostRequestHandoff: async () => {
      throw new Error("no lost request to recover");
    },
    watchTradeBurner: async () => () => {},
    createHostedCoinageWorld: async (
      args: Parameters<typeof createMockCoinageSession>[0] & { route: ConversionRoute },
    ) => {
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
        dispose: () => mock.session.dispose(),
      };
    },
  };
});

/** A hosted card request on screen, awaiting its payment. */
async function cardOnScreen() {
  const session = useSessionStore();
  const requests = useRequestsStore();
  session.setMethod("card");
  session.setAmount("50");
  await session.fetchMeldQuote();
  await session.start();
  expect(requests.phase).toBe("awaiting-deposit");
  const ref = requests.foregroundRecord?.ref;
  if (ref === undefined) throw new Error("no request on screen");
  return { session, requests, ref };
}

describe("Skip on a hosted Meld top-up", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    trades.next = 1;
    faucet.calls.length = 0;
    faucet.broadcast = () => Promise.resolve();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    requests.stopMeldPoll();
    await requests.flush();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("is not stamped by the provider settling the payment", async () => {
    const { requests, ref } = await cardOnScreen();
    await requests.observe(ref, {
      source: "provider",
      provider: "meld",
      at: Date.now(),
      result: { status: "complete" },
    });
    expect(requests.meldStage).toBe("complete");
    await requests.flush();
    expect(requests.depositSkipped).toBe(false);
    expect(faucet.calls).toEqual([]);
  });

  it("hides on the widget's press, before the transfer is out, as on every other Skip", async () => {
    const { session, requests } = await cardOnScreen();
    faucet.broadcast = () => new Promise<void>(() => {});
    session.simulateMeldPayment();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(faucet.calls).toHaveLength(1);
    expect(requests.depositSkipped).toBe(true);
    expect(session.canSkipDeposit).toBe(false);
  });

  it.each([
    { name: "goes out", settle: (resolve: () => void) => resolve() },
    {
      name: "is refused",
      settle: (_: () => void, reject: (e: Error) => void) => reject(new Error("refused")),
    },
  ])(
    "stays on offer for the next top-up when the last one's transfer $name",
    async ({ settle }) => {
      const first = await cardOnScreen();
      let release = () => {};
      faucet.broadcast = () =>
        new Promise<void>((resolve, reject) => {
          release = () => settle(resolve, reject);
        });
      const funding = first.session.fundFaucet();
      first.session.reset();
      const second = await cardOnScreen();
      expect(second.ref).not.toEqual(first.ref);
      release();
      await funding;
      expect(second.session.faucetState).toBe("idle");
      expect(second.session.canSkipDeposit).toBe(true);
      expect(second.requests.transientError).toBeNull();
    },
  );

  it("sends the deposit on the widget's press, so leaving mid-play keeps it", async () => {
    const { session, requests, ref } = await cardOnScreen();
    vi.useFakeTimers();
    session.simulateMeldPayment();
    session.reset();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(faucet.calls).toHaveLength(1);
    expect(requests.get(ref)?.depositSkippedAt).toBeTypeOf("number");
    // The play went with the screen: no provider status was written behind the buyer.
    expect(requests.get(ref)?.observedAt?.receiving).toBeUndefined();
  });
});
