// The rows a top-up's money shows, and the details rows of a failure.

import { describe, expect, it } from "vitest";
import {
  failureDetailRows,
  journeyMoneyRows,
  liveQuoteView,
  quoteDetailRows,
  storedQuoteView,
  type QuoteView,
} from "../app/funding/quote-rows";

const card: QuoteView = { amount: "50.55", symbol: "EUR", fee: "0.55", crypto: false };

describe("a failure's details rows", () => {
  it("names the provider and its reason, and copies the whole reference from a short mono one", () => {
    const reference = "b7e4a10c-9d31-4f62-8ab5-3c0f7e19d248";
    expect(failureDetailRows({ provider: "Transak", reason: "DECLINED", reference })).toEqual([
      { label: "Provider", value: "Transak" },
      { label: "Reason", value: "DECLINED" },
      { label: "Reference", value: "b7e4-d248", copy: reference, mono: true },
    ]);
  });

  it("drops a row the record cannot fill rather than showing it blank", () => {
    expect(failureDetailRows({ provider: "Chainflip" }).map((r) => r.label)).toEqual(["Provider"]);
    expect(failureDetailRows({})).toEqual([]);
  });
});

describe("a live quote's rows", () => {
  it("says the total includes the fee rather than restating it on its own row", () => {
    // A separate Fees row restated part of the number sitting right beside it. The label carries
    // that now, and the chevron carries the split.
    const [row, ...rest] = quoteDetailRows(card);
    expect(row?.label).toBe("You paid inc. fees");
    expect(row?.value).toContain("50.55");
    expect(rest).toEqual([]);
  });

  it("offers the breakdown wherever the fee is a figure it can split", () => {
    // Including a quote read back off the list: the record persists the components, so a journey
    // opened from history keeps the chevron the design draws on it.
    expect(quoteDetailRows(card)[0]?.fees).toBe(true);
    expect(quoteDetailRows({ ...card, fee: "free" })[0]?.fees).toBe(false);
    expect(quoteDetailRows({ ...card, fee: null })[0]?.fees).toBe(false);
  });

  it("drops the inc.-fees wording when there was no fee to include", () => {
    expect(quoteDetailRows({ ...card, fee: null })[0]?.label).toBe("You paid");
  });

  it("keeps the crypto rail's full-precision ticker form", () => {
    const crypto: QuoteView = { amount: "0.00045", symbol: "BTC", crypto: true };
    expect(quoteDetailRows(crypto)[0]?.value).toBe("0.00045 BTC");
  });

  it("has nothing to show without a quote", () => {
    expect(quoteDetailRows(null)).toEqual([]);
  });
});

describe("which money rows an ending shows", () => {
  const fiat = { crypto: false, expired: false, failed: false };

  it("shows the charge alone while a top-up runs and once it lands", () => {
    // The design's settled frames carry no provider or reference row: a buyer holding their CASH
    // has nobody to chase. This regressed once — the receipt rows leaked onto a credit.
    expect(journeyMoneyRows(fiat)).toBe("quote");
  });

  it("replaces the quote with the receipt when a fiat top-up fails", () => {
    expect(journeyMoneyRows({ ...fiat, failed: true })).toBe("receipt");
  });

  it("shows nothing for a top-up that expired, because nobody was charged", () => {
    expect(journeyMoneyRows({ ...fiat, expired: true, failed: true })).toBe("none");
  });

  it("leaves the crypto rail's deposit figure to the deposit screen", () => {
    const crypto = { ...fiat, crypto: true };
    expect(journeyMoneyRows(crypto)).toBe("none");
    expect(journeyMoneyRows({ ...crypto, failed: true })).toBe("none");
  });
});

describe("resolving which quote a screen reads", () => {
  it("reads the live quote's charge off `send`, and keeps the split with it", () => {
    const view = liveQuoteView(
      { send: "50.55", symbol: "EUR", fee: "0.55", transactionFee: "0.42", chainFee: "0.04" },
      false,
    );
    expect(view).toMatchObject({ amount: "50.55", symbol: "EUR", crypto: false });
    expect(view).toMatchObject({ fee: "0.55", transactionFee: "0.42", chainFee: "0.04" });
    // Absent components read as null rather than undefined, so the breakdown tests one thing.
    expect(view.partnerFee).toBeNull();
  });

  it("carries the stored quote's split too, so a reopened breakdown has something to show", () => {
    // The record persists every component; dropping them here is what killed the drill-in.
    const view = storedQuoteView(
      { amount: "31.80", symbol: "EUR", fee: "1.80", networkFee: "0.30" },
      false,
    );
    expect(view).toMatchObject({ amount: "31.80", fee: "1.80", networkFee: "0.30" });
  });

  it("has no quote to read when the record kept none", () => {
    expect(storedQuoteView(undefined, false)).toBeNull();
  });
});
