import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import {
  baasBrokerUrl,
  BelowMinimumSwapAmountError,
  createSwapSdk,
  normalizeQuoteRequestError,
} from "./sdk";

const { constructed, quoted } = vi.hoisted(() => ({
  constructed: [] as unknown[],
  quoted: [] as unknown[],
}));
vi.mock("@chainflip/sdk/swap", () => ({
  SwapSDK: class SwapSDK {
    constructor(options: unknown) {
      constructed.push(options);
    }
    async getQuoteV2(request: unknown) {
      quoted.push(request);
      return { quotes: [] };
    }
  },
}));

describe("Chainflip quote errors", () => {
  it("extracts the live minimum from a below-minimum HTTP 400", () => {
    const error = normalizeQuoteRequestError({
      response: {
        status: 400,
        data: { message: "expected amount is below minimum swap amount (40000)" },
      },
    });

    expect(error).toBeInstanceOf(BelowMinimumSwapAmountError);
    expect((error as BelowMinimumSwapAmountError).minimumBaseUnits).toBe(40_000n);
  });

  it("keeps the HTTP status and server message for other quote failures", () => {
    const error = normalizeQuoteRequestError({
      response: { status: 400, data: { message: "invalid request" } },
    });

    expect(error.message).toBe("Chainflip quote request failed (HTTP 400): invalid request");
  });
});

describe("the SDK's transport", () => {
  const original = axios.defaults.adapter;
  afterEach(() => {
    axios.defaults.adapter = original;
  });

  it("sends over fetch, since the app's host breaks XMLHttpRequest", async () => {
    axios.defaults.adapter = "xhr";
    await createSwapSdk("mainnet");
    expect(axios.defaults.adapter).toBe("fetch");
  });
});

const QUOTE_ARGS = {
  srcChain: "Bitcoin",
  srcAsset: "BTC",
  destChain: "Assethub",
  destAsset: "DOT",
  amount: "250000",
};

describe("the SDK's broker", () => {
  beforeEach(() => {
    constructed.length = 0;
    quoted.length = 0;
  });

  it("opens channels on the broker URL it is given", async () => {
    await createSwapSdk("mainnet", { brokerUrl: "https://broker.example/rpc/key" });
    expect(constructed).toEqual([
      { network: "mainnet", broker: { url: "https://broker.example/rpc/key" } },
    ]);
  });

  it("names no broker without a URL, an empty one included", async () => {
    await createSwapSdk("mainnet");
    await createSwapSdk("mainnet", { brokerUrl: "" });
    expect(constructed).toEqual([{ network: "mainnet" }, { network: "mainnet" }]);
  });

  it("quotes with the broker's commission, so the quote says what lands", async () => {
    const sdk = await createSwapSdk("mainnet", {
      brokerUrl: "https://broker.example/rpc/key",
      brokerCommissionBps: 5,
    });
    await sdk.getQuoteV2(QUOTE_ARGS);
    expect(quoted).toEqual([{ ...QUOTE_ARGS, brokerCommissionBps: 5 }]);
  });

  it("quotes without a commission when none is named", async () => {
    const sdk = await createSwapSdk("mainnet");
    await sdk.getQuoteV2(QUOTE_ARGS);
    expect(quoted).toEqual([QUOTE_ARGS]);
  });

  it("names the BaaS RPC drop-in for an API key", () => {
    expect(baasBrokerUrl("abc123")).toBe("https://chainflip-broker.io/rpc/abc123");
  });
});
