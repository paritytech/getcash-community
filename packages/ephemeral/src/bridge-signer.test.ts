import { describe, expect, it } from "vitest";
import { deriveBridgeSigner } from "./bridge-signer";
import { deriveRefundKey } from "./refund";

const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

/** secp256k1 private key 1, whose address is widely published. */
const ONE = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
/** The first key of the test mnemonic that local Ethereum nodes fund. */
const LOCAL_NODE = hexToBytes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const SECP256K1_ORDER = hexToBytes(
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

describe("deriveBridgeSigner", () => {
  it.each<[string, Uint8Array, string]>([
    ["key 1", ONE, "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"],
    ["the key of local nodes", LOCAL_NODE, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"],
  ])("gives the address of %s in lower case", (_name, seed, address) => {
    expect(deriveBridgeSigner(seed).address).toBe(address);
  });

  it("uses the seed itself as the secret, in a copy", () => {
    const seed = Uint8Array.from(LOCAL_NODE);
    const signer = deriveBridgeSigner(seed);
    expect(signer.privateKey).toEqual(LOCAL_NODE);
    seed.fill(0);
    expect(signer.privateKey).toEqual(LOCAL_NODE);
  });

  it("gives the address of the Ethereum refund key for the same seed, so the seeds must differ", () => {
    const seed = new Uint8Array(32).fill(7);
    expect(deriveBridgeSigner(seed).address).toBe(
      deriveRefundKey("Ethereum", seed).address.toLowerCase(),
    );
    const other = new Uint8Array(32).fill(8);
    expect(deriveBridgeSigner(other).address).not.toBe(deriveBridgeSigner(seed).address);
  });

  it.each<[string, Uint8Array, string]>([
    ["a short seed", new Uint8Array(31).fill(1), "seed must be exactly 32 bytes, got 31"],
    ["a long seed", new Uint8Array(33).fill(1), "seed must be exactly 32 bytes, got 33"],
    ["a seed of zeros", new Uint8Array(32), "not a valid secp256k1 secret key"],
    ["the order of the curve", SECP256K1_ORDER, "not a valid secp256k1 secret key"],
  ])("refuses %s", (_name, seed, reason) => {
    expect(() => deriveBridgeSigner(seed)).toThrow(reason);
  });
});
