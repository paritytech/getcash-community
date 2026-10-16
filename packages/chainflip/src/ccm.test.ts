import { describe, expect, it } from "vitest";
import { encodeSaleMessage, saleRef } from "./ccm";

// The four 32-byte words the message carries, by the offsets SaleVault.cfReceive reads.
const word = (message: string, i: number): string => message.slice(2 + i * 64, 2 + i * 64 + 64);

const BASE = {
  fundingRequestId: "funding-1",
  recipient: `0x${"11".repeat(20)}`,
  committed: 50_000_000n,
  home: `0x${"ab".repeat(32)}`,
};

describe("saleRef", () => {
  it("is a deterministic 32-byte keccak of the id, differing per id", () => {
    const ref = saleRef("funding-1");
    expect(ref).toMatch(/^0x[0-9a-f]{64}$/);
    expect(saleRef("funding-1")).toBe(ref);
    expect(saleRef("funding-2")).not.toBe(ref);
  });
});

describe("encodeSaleMessage", () => {
  it("lays out ref, recipient, committed and home the way cfReceive decodes them", () => {
    const message = encodeSaleMessage(BASE);
    expect(message).toMatch(/^0x[0-9a-f]{256}$/); // 128 bytes
    expect(`0x${word(message, 0)}`).toBe(saleRef(BASE.fundingRequestId));
    // recipient is right-aligned in its word, the low 20 bytes
    expect(word(message, 1)).toBe(`${"00".repeat(12)}${"11".repeat(20)}`);
    expect(BigInt(`0x${word(message, 2)}`)).toBe(BASE.committed);
    expect(word(message, 3)).toBe("ab".repeat(32));
  });

  it("refuses a recipient that is not a 20-byte address", () => {
    expect(() => encodeSaleMessage({ ...BASE, recipient: "0xabcd" })).toThrow(/20-byte address/);
  });

  it("refuses a home account that is not 32 bytes", () => {
    expect(() => encodeSaleMessage({ ...BASE, home: "0xabcd" })).toThrow(/32 bytes/);
  });

  it("refuses a negative committed amount", () => {
    expect(() => encodeSaleMessage({ ...BASE, committed: -1n })).toThrow(/negative/);
  });
});
