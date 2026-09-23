import { afterEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { BelowMinimumSwapAmountError, createSwapSdk, normalizeQuoteRequestError } from "./sdk";

vi.mock("@chainflip/sdk/swap", () => ({ SwapSDK: class SwapSDK {} }));

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
