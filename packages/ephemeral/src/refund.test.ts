import { isValidAddressForNetwork } from "@chainflip/bitcoin";
import { isValidSolanaAddress } from "@chainflip/solana";
import { isValidTronAddress } from "@chainflip/utils/tron";
import { SOURCE_CONFIGS } from "@getsome/chainflip";
import { describe, expect, it } from "vitest";
import { deriveRefundKey, isRefundChain, type RefundChain } from "./refund";

const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

/** secp256k1 private key 1: the generator point, whose addresses are widely published. */
const ONE = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
/** RFC 8032 section 7.1 test 1 secret. */
const RFC8032 = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const SECP256K1_ORDER = hexToBytes(
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

const CHAINS: RefundChain[] = ["Bitcoin", "Ethereum", "Arbitrum", "Tron", "Solana"];
const seeds = [1, 2, 3, 0x7f, 0xfe].map((n) => new Uint8Array(32).fill(n));

describe("deriveRefundKey", () => {
  it("Bitcoin: P2WPKH address and compressed WIF (BIP-173 vector for key 1)", () => {
    const key = deriveRefundKey("Bitcoin", ONE);
    expect(key.address).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    expect(key.secret).toBe("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn");
    expect(key.format).toBe("wif");
  });

  it("Bitcoin testnet: tb1 address and testnet WIF prefix", () => {
    const key = deriveRefundKey("Bitcoin", ONE, { bitcoinNetwork: "testnet" });
    expect(key.address).toBe("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
    expect(key.secret).toBe("cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA");
    expect(isValidAddressForNetwork(key.address, "testnet")).toBe(true);
  });

  it("Ethereum: EIP-55 checksummed address and 0x hex secret", () => {
    const key = deriveRefundKey("Ethereum", ONE);
    expect(key.address).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    expect(key.secret).toBe(`0x${"0".repeat(63)}1`);
    expect(key.format).toBe("hex");
  });

  it("Arbitrum shares the Ethereum address for one seed", () => {
    expect(deriveRefundKey("Arbitrum", ONE).address).toBe(deriveRefundKey("Ethereum", ONE).address);
  });

  it("Tron: base58check of 0x41 || the EVM address bytes, bare hex secret", () => {
    const key = deriveRefundKey("Tron", ONE);
    expect(key.address).toBe("TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC");
    expect(key.secret).toBe(`${"0".repeat(63)}1`);
    expect(key.format).toBe("hex");
  });

  it("Solana: base58 public key and 64-byte secret (RFC 8032 test 1)", () => {
    const key = deriveRefundKey("Solana", RFC8032);
    expect(key.address).toBe("FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z");
    expect(key.secret).toBe(
      "49W385L4rePHy6PAaQUovbD2aacgN4HsKXSMeUzRg4fmwXszN91JuMFrQRj3vMDpZuRF3ZknQBuRBoWQJEfXstMw",
    );
    expect(key.format).toBe("base58");
  });

  it("is deterministic and differs across seeds and across chains", () => {
    for (const chain of CHAINS) {
      expect(deriveRefundKey(chain, seeds[0]!)).toEqual(
        deriveRefundKey(chain, new Uint8Array(seeds[0]!)),
      );
      const addresses = new Set(seeds.map((seed) => deriveRefundKey(chain, seed).address));
      expect(addresses.size).toBe(seeds.length);
    }
    const oneSeed = new Set(
      CHAINS.filter((c) => c !== "Arbitrum").map((c) => deriveRefundKey(c, ONE).address),
    );
    expect(oneSeed.size).toBe(4);
  });

  it.each([0, 31, 33, 64])("rejects a %d-byte seed", (len) => {
    expect(() => deriveRefundKey("Ethereum", new Uint8Array(len))).toThrow(/exactly 32 bytes/);
  });

  it("rejects seeds outside the secp256k1 scalar range", () => {
    for (const chain of ["Bitcoin", "Ethereum", "Tron"] as const) {
      expect(() => deriveRefundKey(chain, new Uint8Array(32))).toThrow(/secp256k1/);
      expect(() => deriveRefundKey(chain, SECP256K1_ORDER)).toThrow(/secp256k1/);
    }
  });

  it("every derived address passes Chainflip's own validators", () => {
    for (const seed of seeds) {
      expect(isValidAddressForNetwork(deriveRefundKey("Bitcoin", seed).address, "mainnet")).toBe(
        true,
      );
      expect(isValidSolanaAddress(deriveRefundKey("Solana", seed).address)).toBe(true);
      expect(isValidTronAddress(deriveRefundKey("Tron", seed).address)).toBe(true);
      expect(deriveRefundKey("Ethereum", seed).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("every derived address passes the source catalog's validator for its chain", () => {
    for (const source of SOURCE_CONFIGS) {
      if (!isRefundChain(source.chain)) throw new Error(`no refund key for ${source.chain}`);
      for (const seed of seeds) {
        const { address } = deriveRefundKey(source.chain, seed);
        expect(source.validateRefundAddress(address), `${source.sourceId} ${address}`).toBe(true);
      }
    }
  });
});

describe("isRefundChain", () => {
  it("covers every Chainflip source chain and nothing else", () => {
    for (const chain of CHAINS) expect(isRefundChain(chain)).toBe(true);
    expect(isRefundChain("Assethub")).toBe(false);
    expect(isRefundChain("Polkadot")).toBe(false);
  });
});
