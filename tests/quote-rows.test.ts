// The rows a top-up's money shows: the live quote while it is being bought, and what was actually
// paid once a fiat top-up has ended.

import { describe, expect, it } from "vitest";
import {
  journeyMoneyRows,
  paidDetailRows,
  quoteDetailRows,
  type QuoteView,
} from "../app/funding/quote-rows";

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
    // Restating what was sent beside a refund reads as a second charge. The refunded swap gets
    // its context — the network and the rail — and the money's own story belongs to the guide.
    const crypto = { amount: "0.00045", symbol: "BTC", crypto: true, live: true, fee: "0.00001" };
    const rows = paidDetailRows(crypto, { network: "Bitcoin", provider: "Chainflip" });
    expect(rows.map((r) => r.label)).toEqual(["Network", "Provider"]);
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

  it("offers the breakdown only where the fee is a figure it can split", () => {
    expect(quoteDetailRows(card)[0]?.fees).toBe(true);
    expect(quoteDetailRows({ ...card, fee: "free" })[0]?.fees).toBe(false);
    expect(quoteDetailRows({ ...card, fee: null })[0]?.fees).toBe(false);
  });

  it("drops the inc.-fees wording when there was no fee to include", () => {
    expect(quoteDetailRows({ ...card, fee: null })[0]?.label).toBe("You paid");
  });

  it("keeps the crypto rail's full-precision ticker form", () => {
    const crypto: QuoteView = { amount: "0.00045", symbol: "BTC", crypto: true, live: true };
    expect(quoteDetailRows(crypto)[0]?.value).toBe("0.00045 BTC");
  });

  it("has nothing to show without a quote", () => {
    expect(quoteDetailRows(null)).toEqual([]);
  });
});

describe("which money rows an ending shows", () => {
  const fiat = { crypto: false, expired: false, failed: false, refunded: false };

  it("shows the charge alone while a top-up runs and once it lands", () => {
    // The design's settled frames carry no provider or reference row: a buyer holding their CASH
    // has nobody to chase. This regressed once — the receipt rows leaked onto a credit.
    expect(journeyMoneyRows(fiat)).toBe("quote");
  });

  it("replaces the quote with the receipt when a fiat top-up fails", () => {
    expect(journeyMoneyRows({ ...fiat, failed: true })).toBe("receipt");
    expect(journeyMoneyRows({ ...fiat, failed: true, refunded: true })).toBe("receipt");
  });

  it("shows nothing for a top-up that expired, because nobody was charged", () => {
    expect(journeyMoneyRows({ ...fiat, expired: true, failed: true })).toBe("none");
  });

  it("leaves the crypto rail's deposit figure to the deposit screen", () => {
    const crypto = { ...fiat, crypto: true };
    expect(journeyMoneyRows(crypto)).toBe("none");
    expect(journeyMoneyRows({ ...crypto, failed: true })).toBe("none");
    // Except on a refund, where the receipt names the network and the rail that handled it.
    expect(journeyMoneyRows({ ...crypto, failed: true, refunded: true })).toBe("receipt");
  });
});
