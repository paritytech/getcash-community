// The rows a top-up's money shows: the live quote while it is being bought, and what was actually
// paid once a fiat top-up has ended.

import { describe, expect, it } from "vitest";
import { paidDetailRows, quoteDetailRows, type QuoteView } from "../app/funding/quote-rows";

const card: QuoteView = { amount: "50.55", symbol: "EUR", fee: "0.55", crypto: false, live: true };

describe("a concluded fiat top-up's rows", () => {
  it("keeps the money row on a refund, because the charge happened", () => {
    // The ribbon says what came back; this says what went out. They are different figures, and
    // dropping the row with the quote would leave the buyer only the smaller one.
    const rows = paidDetailRows(card, { provider: "Transak", reference: "a1f9c3d2-4c2e-4a71" });
    expect(rows.map((r) => r.label)).toEqual(["You paid inc. fees", "Provider", "Transaction ID"]);
    expect(rows[0]?.value).toContain("50.55");
  });

  it("elides the reference but copies it whole", () => {
    const [row] = paidDetailRows(null, { reference: "b7e4a10c-9d31-4f62-8ab5-3c0f7e19d248" });
    expect(row?.copy).toBe("b7e4a10c-9d31-4f62-8ab5-3c0f7e19d248");
    expect(row?.value).not.toBe(row?.copy);
  });

  it("drops a row the record cannot fill rather than showing it blank", () => {
    // Records written before the provider and the reference were kept.
    expect(paidDetailRows(card).map((r) => r.label)).toEqual(["You paid inc. fees"]);
    expect(paidDetailRows(null)).toEqual([]);
  });

  it("leaves the crypto rail's deposit figure to the deposit screen", () => {
    // Restating what was sent beside a refund would read as a second charge; the crypto journey
    // takes that figure from the deposit screen instead.
    const crypto = { amount: "0.00045", symbol: "BTC", crypto: true, live: true, fee: "0.00001" };
    expect(paidDetailRows(crypto, { provider: "Chainflip" }).map((r) => r.label)).toEqual([
      "Provider",
    ]);
  });
});

describe("a live quote's rows", () => {
  it("still shows Fees and Total while the top-up is being bought", () => {
    expect(quoteDetailRows(card).map((r) => r.label)).toEqual(["Fees", "Total"]);
  });
});
