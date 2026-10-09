// The transfer details a native bank order shows: which rows each rail carries, the exact text
// each copies, the note on the reference, and the line above them with and without a deadline.

import { describe, expect, it } from "vitest";
import type { BankInstructions } from "@getsome/meld";
import { bankDetailRows, bankDetailsLead } from "../app/funding/meld-bank-details";

const SEPA: BankInstructions = {
  rail: "SEPA",
  amount: "101.20",
  currency: "EUR",
  accountHolderName: "Provider Payments GmbH",
  bankName: "Provider Bank",
  iban: "DE89370400440532013000",
  bic: "COBADEFFXXX",
  reference: "GETCASH-7",
};
const ACH: BankInstructions = {
  rail: "ACH",
  amount: "250.5",
  currency: "USD",
  accountHolderName: "Provider Payments LLC",
  accountNumber: "000123456789",
  routingNumber: "021000021",
};
const PIX: BankInstructions = {
  rail: "PIX",
  amount: "530.00",
  currency: "BRL",
  pixKey: "pagamentos@provider.example",
  reference: "GC7",
};

const labels = (instructions: BankInstructions) =>
  bankDetailRows(instructions).map(({ label }) => label);

describe("bankDetailRows", () => {
  it("lists a SEPA transfer's amount, account, IBAN, BIC and reference", () => {
    expect(labels(SEPA)).toEqual(["Amount", "Account name", "IBAN", "BIC", "Reference"]);
  });

  it("lists an ACH transfer's account and routing number in place of an IBAN", () => {
    expect(labels(ACH)).toEqual(["Amount", "Account name", "Account number", "Routing number"]);
  });

  it("lists a PIX transfer's key", () => {
    expect(labels(PIX)).toEqual(["Amount", "PIX key", "Reference"]);
  });

  it("names each row once, even with every detail present", () => {
    const all = labels({ ...SEPA, ...ACH, ...PIX });
    expect(new Set(all).size).toBe(all.length);
  });

  it("copies the exact amount and shows it in the transfer's currency", () => {
    expect(bankDetailRows(ACH)[0]).toEqual({ label: "Amount", value: "$250.50", copy: "250.5" });
  });

  it("prints the IBAN in groups of four and copies it without spaces", () => {
    const spaced = { ...SEPA, iban: "DE89 3704 0044 0532 0130 00" };
    const iban = bankDetailRows(spaced).find(({ label }) => label === "IBAN");
    expect(iban).toEqual({
      label: "IBAN",
      value: "DE89 3704 0044 0532 0130 00",
      copy: "DE89370400440532013000",
    });
  });

  it("notes that the reference is required, and copies every row as given", () => {
    const rows = bankDetailRows(SEPA);
    expect(rows.find(({ label }) => label === "Reference")).toEqual({
      label: "Reference",
      value: "GETCASH-7",
      copy: "GETCASH-7",
      note: "Required on the transfer",
    });
    expect(rows.filter(({ note }) => note !== undefined)).toHaveLength(1);
    expect(rows.find(({ label }) => label === "BIC")?.copy).toBe("COBADEFFXXX");
  });
});

describe("bankDetailsLead", () => {
  it("says by when to send when the order expires, in the reader's locale and time zone", () => {
    const expiresAt = Date.UTC(2026, 9, 10, 15, 30);
    expect(bankDetailsLead({ ...SEPA, expiresAt }, "en-US")).toMatch(
      /^Send from a bank account in your name, by Oct 1[01], \d{1,2}:30\s[AP]M\. Use these details for this top-up only\.$/,
    );
  });

  it("leaves the deadline out when the order states none", () => {
    expect(bankDetailsLead(SEPA, "en-US")).toBe(
      "Send from a bank account in your name. Use these details for this top-up only.",
    );
  });
});
