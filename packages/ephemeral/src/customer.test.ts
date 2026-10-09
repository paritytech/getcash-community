import { utf8ToBytes } from "@noble/hashes/utils.js";
import { verify } from "@scure/sr25519";
import { describe, expect, it } from "vitest";
import { deriveCustomerKey } from "./customer";
import { deriveKeypair } from "./derive";

const seedA = new Uint8Array(32).fill(1);
const seedB = new Uint8Array(32).fill(2);

describe("deriveCustomerKey", () => {
  it("is deterministic and distinct per seed", () => {
    const a = deriveCustomerKey(seedA);
    expect(deriveCustomerKey(new Uint8Array(seedA)).publicKeyHex).toBe(a.publicKeyHex);
    expect(deriveCustomerKey(seedB).publicKeyHex).not.toBe(a.publicKeyHex);
    expect(a.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("derives the same public key as deriveKeypair", () => {
    expect(deriveCustomerKey(seedA).publicKey).toEqual(deriveKeypair(seedA).publicKey);
  });

  it("signs the raw message bytes, not the <Bytes>-wrapped form", () => {
    const key = deriveCustomerKey(seedA);
    const message = new Uint8Array(56).fill(7);
    const signature = key.signRaw(message);
    const wrapped = new Uint8Array([
      ...utf8ToBytes("<Bytes>"),
      ...message,
      ...utf8ToBytes("</Bytes>"),
    ]);
    expect(signature).toHaveLength(64);
    expect(verify(message, signature, key.publicKey)).toBe(true);
    expect(verify(wrapped, signature, key.publicKey)).toBe(false);
  });

  it.each([0, 31, 33, 64])("rejects a %d-byte seed", (len) => {
    expect(() => deriveCustomerKey(new Uint8Array(len))).toThrow(
      new RegExp(`exactly 32 bytes, got ${len}`),
    );
  });
});
