import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, mnemonicToMiniSecret } from "@polkadot-labs/hdkd-helpers";
import { sign, verify } from "@scure/sr25519";
import { describe, expect, it } from "vitest";
import type { EntropyPort } from "@getsome/core";
import {
  ASSET_HUB_SS58_PREFIX,
  deriveKeypair,
  deriveKeypairWithSecret,
  toEphemeralSigner,
  toHandoffKey,
  toSchnorrkelSecret,
} from "./derive";
import { createEphemeral } from "./ephemeral";

const entropyA = new Uint8Array(32).fill(1);
const entropyB = new Uint8Array(32).fill(2);

describe("deriveKeypair", () => {
  it("is deterministic: same entropy -> same address and publicKey", () => {
    const a = deriveKeypair(entropyA);
    const b = deriveKeypair(new Uint8Array(entropyA));
    expect(a.address).toBe(b.address);
    expect(a.publicKey).toEqual(b.publicKey);
  });

  it("distinct entropy -> distinct address", () => {
    expect(deriveKeypair(entropyA).address).not.toBe(deriveKeypair(entropyB).address);
  });

  it("encodes with SS58 prefix 0 (starts with 1, not the generic-42 5)", () => {
    expect(ASSET_HUB_SS58_PREFIX).toBe(0);
    for (const entropy of [entropyA, entropyB]) {
      const { address } = deriveKeypair(entropy);
      expect(address.startsWith("1")).toBe(true);
      expect(address.startsWith("5")).toBe(false);
    }
  });

  it.each([0, 16, 31, 33])("throws a clear error on %d-byte entropy", (len) => {
    expect(() => deriveKeypair(new Uint8Array(len))).toThrow(
      new RegExp(`exactly 32 bytes, got ${len}`),
    );
  });

  it("produces a signer whose publicKey matches the keypair and that signs", async () => {
    const kp = deriveKeypair(entropyA);
    expect(kp.signer.publicKey).toEqual(kp.publicKey);
    expect(kp.publicKey).toHaveLength(32);
    // signBytes exercises the raw sr25519 sign path without needing chain metadata.
    const sig = await kp.signer.signBytes(new Uint8Array([1, 2, 3]));
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
  });
});

describe("deriveKeypairWithSecret", () => {
  it("exports a 64-byte secret for the same account as deriveKeypair", () => {
    const kp = deriveKeypair(entropyA);
    const withSecret = deriveKeypairWithSecret(entropyA);
    expect(withSecret.secretKey).toHaveLength(64);
    expect(withSecret.address).toBe(kp.address);
    expect(withSecret.publicKey).toEqual(kp.publicKey);
  });

  it("the exported secret actually signs for the derived publicKey (cross-proof)", () => {
    const { secretKey, publicKey } = deriveKeypairWithSecret(entropyA);
    const msg = new Uint8Array([1, 2, 3]);
    expect(verify(msg, sign(secretKey, msg), publicKey)).toBe(true);
  });

  it("is deterministic and distinct per entropy", () => {
    expect(deriveKeypairWithSecret(entropyA).secretKey).toEqual(
      deriveKeypairWithSecret(new Uint8Array(entropyA)).secretKey,
    );
    expect(deriveKeypairWithSecret(entropyA).secretKey).not.toEqual(
      deriveKeypairWithSecret(entropyB).secretKey,
    );
  });

  it("enforces the 32-byte entropy contract like deriveKeypair", () => {
    expect(() => deriveKeypairWithSecret(new Uint8Array(16))).toThrow(/exactly 32 bytes/);
  });

  it("matches the frozen known-answer vector (guards encoding drift across dep bumps)", () => {
    // Frozen wire encoding of the secret (schnorrkel scalar plus nonce).
    const { secretKey, publicKey, address } = deriveKeypairWithSecret(entropyA);
    const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex(secretKey)).toBe(
      "6095634d2e35e734e5d9ce870582c54f3701f558eb9ebac9c52980533bcdb750459effdf005a2138d510adb013b63e783bbf7426004c033a380df6988fb6ee7c",
    );
    expect(hex(publicKey)).toBe("62aad60d3d943495496ef3e68baa23c6a4a1272cef2a800d18b675ce25c47674");
    expect(address).toBe("13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9");
  });

  it("anchors the derivation chain to Substrate ground truth (//Alice dev vector)", () => {
    // The canonical sr25519 //Alice public key, reproducible with `subkey inspect //Alice`.
    const alice = sr25519CreateDerive(mnemonicToMiniSecret(DEV_PHRASE))("//Alice");
    const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex(alice.publicKey)).toBe(
      "d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
    );
  });
});

describe("toHandoffKey", () => {
  it("narrows to the core handoff shape with the schnorrkel-form secret", () => {
    const kp = deriveKeypairWithSecret(entropyA);
    const k = toHandoffKey(kp);
    expect(k.address).toBe(kp.address);
    expect(k.signer).toBe(kp.signer);
    expect(k.secretKey).toEqual(toSchnorrkelSecret(kp.secretKey));
  });
});

describe("toSchnorrkelSecret", () => {
  it("divides the clamped scalar by the cofactor exactly (3-bit shift round-trips)", () => {
    const { secretKey } = deriveKeypairWithSecret(entropyA);
    const out = toSchnorrkelSecret(secretKey);
    // shifting back left by 3 reproduces the original scalar; the clamp zeroed its low bits
    const back = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      back[i] = ((out[i]! << 3) | (i > 0 ? out[i - 1]! >> 5 : 0)) & 0xff;
    }
    expect(back).toEqual(secretKey.slice(0, 32));
  });
  it("yields a canonical scalar (below the group order) from any clamped input", () => {
    const { secretKey } = deriveKeypairWithSecret(entropyA);
    const out = toSchnorrkelSecret(secretKey);
    // clamped scalars live in [2^254, 2^255); divided ones in [2^251, 2^252) < l
    expect(out[31]).toBeLessThan(0x20);
    expect(out[31]).toBeGreaterThanOrEqual(0x08);
  });
  it("carries the nonce half over verbatim", () => {
    const { secretKey } = deriveKeypairWithSecret(entropyA);
    expect(toSchnorrkelSecret(secretKey).slice(32)).toEqual(secretKey.slice(32));
  });
  it("rejects non-64-byte inputs", () => {
    expect(() => toSchnorrkelSecret(new Uint8Array(32))).toThrow(/64-byte/);
  });
  it("rejects a non-clamped scalar (low bits set) instead of silently losing them", () => {
    const { secretKey } = deriveKeypairWithSecret(entropyA);
    const bad = new Uint8Array(secretKey);
    bad[0] = bad[0]! | 0b1; // un-clamp
    expect(() => toSchnorrkelSecret(bad)).toThrow(/not ed25519-clamped/);
  });
});

describe("toEphemeralSigner", () => {
  it("narrows to the core port shape {address, signer}", () => {
    const kp = deriveKeypair(entropyA);
    const s = toEphemeralSigner(kp);
    expect(s).toEqual({ address: kp.address, signer: kp.signer });
  });
});

describe("createEphemeral", () => {
  // Deterministic fake port: seed = label byte repeated to 32 bytes.
  function fakePort(): EntropyPort & { calls: Uint8Array[] } {
    const calls: Uint8Array[] = [];
    return {
      deterministic: true,
      calls,
      async deriveSeed(key: Uint8Array) {
        calls.push(key);
        return new Uint8Array(32).fill(key[0] ?? 0);
      },
    };
  }

  it("derives from EntropyPort.deriveSeed output for the given label", async () => {
    const port = fakePort();
    const label = new Uint8Array([7, 7]);
    const { keypair, signer } = await createEphemeral(port, label);
    expect(port.calls).toEqual([label]);
    // Same account as deriving directly from the seed the port produced.
    expect(keypair.address).toBe(deriveKeypair(new Uint8Array(32).fill(7)).address);
    expect(signer.address).toBe(keypair.address);
  });

  it("deterministic port -> stable address across two calls", async () => {
    const label = new Uint8Array([9]);
    const first = await createEphemeral(fakePort(), label);
    const second = await createEphemeral(fakePort(), label);
    expect(second.keypair.address).toBe(first.keypair.address);
    expect(second.keypair.publicKey).toEqual(first.keypair.publicKey);
  });

  it("distinct labels -> distinct addresses", async () => {
    const port = fakePort();
    const a = await createEphemeral(port, new Uint8Array([1]));
    const b = await createEphemeral(port, new Uint8Array([2]));
    expect(a.keypair.address).not.toBe(b.keypair.address);
  });
});
