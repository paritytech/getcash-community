// The Meld region resolver and payment-method mapping. resolveMeldRegion defaults to US/USD and
// an explicit country overrides it.

import { describe, expect, it } from "vitest";
import { meldPaymentMethod, regionForCountry, resolveMeldRegion } from "../lib/region";

describe("resolveMeldRegion", () => {
  it("defaults to US/USD with no explicit country", () => {
    expect(resolveMeldRegion()).toEqual({ country: "US", fiat: "USD" });
  });

  it("maps an explicit country to its fiat", () => {
    expect(resolveMeldRegion("IN")).toEqual({ country: "IN", fiat: "INR" });
    expect(resolveMeldRegion("DE")).toEqual({ country: "DE", fiat: "EUR" });
    expect(resolveMeldRegion("BR")).toEqual({ country: "BR", fiat: "BRL" });
  });

  it("falls back to US/USD for a country we can't name a fiat for", () => {
    expect(resolveMeldRegion("ZZ")).toEqual({ country: "US", fiat: "USD" });
  });
});

describe("regionForCountry", () => {
  it("returns the country + fiat, or US/USD when unmapped", () => {
    expect(regionForCountry("GB")).toEqual({ country: "GB", fiat: "GBP" });
    expect(regionForCountry("XX")).toEqual({ country: "US", fiat: "USD" });
  });
});

describe("meldPaymentMethod", () => {
  it("card is the global code regardless of country", () => {
    expect(meldPaymentMethod("card", "US")).toBe("CREDIT_DEBIT_CARD");
    expect(meldPaymentMethod("card", "IN")).toBe("CREDIT_DEBIT_CARD");
  });

  it("bank resolves to the country's rail where a provider serves this asset", () => {
    // For DOT_ASSETHUB the eurozone quotes SEPA and GB quotes OPEN_BANKING.
    expect(meldPaymentMethod("bank", "DE")).toBe("SEPA");
    expect(meldPaymentMethod("bank", "FR")).toBe("SEPA");
    expect(meldPaymentMethod("bank", "GB")).toBe("OPEN_BANKING");
  });

  it("bank is null where no provider offers a bank rail for this asset (card-only)", () => {
    // US (no ACH for DOT_ASSETHUB), IN, BR all fall through to card only.
    expect(meldPaymentMethod("bank", "US")).toBeNull();
    expect(meldPaymentMethod("bank", "IN")).toBeNull();
    expect(meldPaymentMethod("bank", "BR")).toBeNull();
    expect(meldPaymentMethod("bank", "ZZ")).toBeNull();
  });
});
