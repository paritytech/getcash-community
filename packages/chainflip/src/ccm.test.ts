import { describe, expect, it } from "vitest";
import vectors from "../../sale-vault-proxy/vectors.json";
import { encodeSaleMessage, SALE_MESSAGE_BYTES, saleRef } from "./ccm";

// The six 32-byte words the message carries, by the offsets the factory's cfReceive reads.
const word = (message: string, i: number): string => message.slice(2 + i * 64, 2 + i * 64 + 64);

const BASE = {
  fundingRequestId: "funding-1",
  recipient: `0x${"11".repeat(20)}`,
  committed: 50_000_000n,
  home: `0x${"ab".repeat(32)}`,
  // 2027-01-01T00:00:00.500Z, so the round down to seconds shows
  paymentExpiresAt: 1_798_761_600_500,
  claimer: `0x${"33".repeat(20)}`,
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
  it("lays out ref, recipient, committed, home, deadline and claimer the way cfReceive decodes them", () => {
    const message = encodeSaleMessage(BASE);
    expect(message).toMatch(/^0x[0-9a-f]{384}$/); // 192 bytes
    expect((message.length - 2) / 2).toBe(SALE_MESSAGE_BYTES);
    expect(`0x${word(message, 0)}`).toBe(saleRef(BASE.fundingRequestId));
    // recipient is right-aligned in its word, the low 20 bytes
    expect(word(message, 1)).toBe(`${"00".repeat(12)}${"11".repeat(20)}`);
    expect(BigInt(`0x${word(message, 2)}`)).toBe(BASE.committed);
    expect(word(message, 3)).toBe("ab".repeat(32));
    // the deadline in unix seconds, rounded down from the record's epoch ms
    expect(BigInt(`0x${word(message, 4)}`)).toBe(1_798_761_600n);
    // the claimer is right-aligned with its high 12 bytes zero, as the factory requires
    expect(word(message, 5)).toBe(`${"00".repeat(12)}${"33".repeat(20)}`);
  });

  it("matches the message the contract's vectors pin", () => {
    const v = vectors.message;
    const message = encodeSaleMessage({ ...v, committed: BigInt(v.committed) });
    expect(message).toBe(v.encoded);
    expect(saleRef(v.fundingRequestId)).toBe(v.ref);
    expect(BigInt(`0x${word(message, 4)}`)).toBe(BigInt(v.deadline));
  });

  it("refuses a recipient that is not a 20-byte address", () => {
    expect(() => encodeSaleMessage({ ...BASE, recipient: "0xabcd" })).toThrow(/20-byte address/);
  });

  it("refuses a claimer that is not a 20-byte address, or is zero", () => {
    expect(() => encodeSaleMessage({ ...BASE, claimer: `0x${"33".repeat(32)}` })).toThrow(
      /claimer must be a 20-byte address/,
    );
    expect(() => encodeSaleMessage({ ...BASE, claimer: "0x1234" })).toThrow(/claimer/);
    expect(() => encodeSaleMessage({ ...BASE, claimer: `0x${"00".repeat(20)}` })).toThrow(
      /zero address/,
    );
  });

  it("binds the claimer into the message, so two claimers never share one", () => {
    expect(encodeSaleMessage(BASE)).not.toBe(
      encodeSaleMessage({ ...BASE, claimer: `0x${"44".repeat(20)}` }),
    );
  });

  it("refuses a home account that is not 32 bytes", () => {
    expect(() => encodeSaleMessage({ ...BASE, home: "0xabcd" })).toThrow(/32 bytes/);
  });

  it("refuses a payment deadline that is not whole epoch ms after the epoch", () => {
    for (const paymentExpiresAt of [Number.NaN, 1.5, 999, -1_000]) {
      expect(() => encodeSaleMessage({ ...BASE, paymentExpiresAt })).toThrow(/payment deadline/);
    }
  });

  it("refuses a negative committed amount", () => {
    expect(() => encodeSaleMessage({ ...BASE, committed: -1n })).toThrow(/negative/);
  });
});
