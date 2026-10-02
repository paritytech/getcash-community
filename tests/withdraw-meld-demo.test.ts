// The offline sale runs in a demo build only. Its sale is real on the chain, and its provider's
// deposit address is made up, so a build that names no adapter and is not a demo has no client to
// quote or open a sale through, and hands the worker no stand-in to trust.

import { afterEach, describe, expect, it, vi } from "vitest";

const demo = vi.hoisted(() => ({ on: true }));
vi.mock("../app/utils/demo", () => ({ isDemoBuild: () => demo.on }));
vi.mock("@novasamatech/host-api", () => ({
  PaymentRequestErr: class PaymentRequestErr extends Error {},
  PaymentStatusErr: class PaymentStatusErr extends Error {},
}));
vi.mock("../lib/host-payments", () => ({
  requestPayment: vi.fn(),
  subscribePaymentStatus: vi.fn(),
}));
vi.mock("../lib/host-chain", () => ({
  ASSET_HUB: "asset-hub",
  PEOPLE: "people",
  ASSET_HUB_GENESIS: "0xah",
  PEOPLE_GENESIS: "0xpe",
  connectChain: vi.fn(),
}));

import { meldSellClient, setMeldSellClient } from "../app/withdraw/meld-client";
import { meldHandoffConfig } from "../lib/withdraw-live";

const SALE = {
  serviceProvider: "TRANSAK",
  orderRef: "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ",
  country: "DE",
  sourceCurrencyCode: "DOT_ASSETHUB",
  sourceAmount: "23.4521",
  destinationCurrencyCode: "EUR",
  paymentMethodType: "SEPA",
};

describe("the offline sale", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setMeldSellClient(null);
    demo.on = true;
  });

  it("stands in for the adapter in a demo build that names none", async () => {
    vi.stubEnv("VITE_MELD_BASE_URL", "");
    const client = meldSellClient();
    expect(client).not.toBeNull();
    expect((await client!.createSellSession(SALE)).fundingRequestId).toBe("mock-sell-1");
    expect(meldHandoffConfig()).toEqual({ offline: true });
  });

  it("is not there at all in any other build without an adapter", () => {
    vi.stubEnv("VITE_MELD_BASE_URL", "");
    demo.on = false;
    expect(meldSellClient()).toBeNull();
    expect(meldHandoffConfig()).toBeNull();
  });

  it("gives way to the adapter a build names, demo or not", () => {
    vi.stubEnv("VITE_MELD_BASE_URL", "https://adapter.test");
    vi.stubEnv("VITE_MELD_PRODUCT_ID", "getcash.dev");
    for (const on of [true, false]) {
      demo.on = on;
      setMeldSellClient(null);
      expect(meldSellClient()).not.toBeNull();
      expect(meldHandoffConfig()).toEqual({
        baseUrl: "https://adapter.test",
        productId: "getcash.dev",
      });
    }
  });
});
