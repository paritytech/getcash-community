import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { saleVaultProxyUsdcDomain } from "@getsome/chainflip/sale-vault-proxy";
import { deriveRefundKey } from "./refund";
import {
  eip712DomainSeparator,
  signTransferAuthorization,
  transferAuthorizationDigest,
  type TransferAuthorization,
} from "./transfer-authorization";

// Expected EIP-712 digest and signature per chain
const SECRET = hexToBytes("42".repeat(32));
const SIGNER = "0x17c5185167401eD00cF5F5b2fc97D9BBfDb7D025";
const AUTH: TransferAuthorization = {
  from: SIGNER,
  to: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  value: 1_500_000n,
  validAfter: 0n,
  validBefore: 1_900_000_000n,
  nonce: `0x${"cd".repeat(32)}`,
};
const ETHERS = {
  421614: {
    digest: "26d346938ff9c3117b72329ecc58c0c29846aefc6d6f04cbef6a156a39791aaf",
    signature:
      "0x4e0ef5e276929d85cde3946f65f1a89035492f0da1b29784c85263bb688456f1088ac25c7940e4657da94207124fbc529d5efbab87e51227b1405f7a616c8c821c",
  },
  42161: {
    digest: "f4b203c97ae8517e985bf562e803e362495f98ed922d7e4aea1c8cfc1067afb6",
    signature:
      "0x4f7b72bec12b1788465b8fd3d30dff334db5ed5d396edbd4b8026368dd2758f8378d107c1a777aefdbe65985e3ad55f7c9b2b2dfd4fe0f93a0bfc2da65e0f06d1b",
  },
} as const;
// Each USDC token's EIP-712 domain separator
const USDC_DOMAIN_SEPARATOR = {
  421614: "85944e1292d007732838d6eadfa67589b78ffcededbd4df60488d0af251308bb",
  42161: "08d11903f8419e68b1b8721bcbe2e9fc68569122a77ef18c216f10b3b5112c78",
} as const;

const HALF_ORDER = secp256k1.Point.CURVE().n >> 1n;

describe("transfer authorization", () => {
  it("derives the signer the vector names from its seed", () => {
    expect(deriveRefundKey("Arbitrum", SECRET).address).toBe(SIGNER);
  });

  for (const chainId of [421614, 42161] as const) {
    const domain = saleVaultProxyUsdcDomain(chainId)!;

    it(`builds the token's own domain separator on ${chainId}`, () => {
      expect(bytesToHex(eip712DomainSeparator(domain))).toBe(USDC_DOMAIN_SEPARATOR[chainId]);
    });

    it(`hashes and signs exactly as ethers does on ${chainId}`, () => {
      expect(bytesToHex(transferAuthorizationDigest(domain, AUTH))).toBe(ETHERS[chainId].digest);
      expect(signTransferAuthorization(SECRET, domain, AUTH)).toBe(ETHERS[chainId].signature);
    });
  }

  it("signs with low s and v 27 or 28 for many nonces", () => {
    const domain = saleVaultProxyUsdcDomain(421614)!;
    for (let i = 0; i < 32; i++) {
      const nonce = `0x${i.toString(16).padStart(64, "0")}`;
      const sig = hexToBytes(
        signTransferAuthorization(SECRET, domain, { ...AUTH, nonce }).slice(2),
      );
      expect(sig.length).toBe(65);
      expect([27, 28]).toContain(sig[64]);
      expect(BigInt(`0x${bytesToHex(sig.subarray(32, 64))}`) <= HALF_ORDER).toBe(true);
    }
  });

  it("refuses a malformed address, nonce or amount", () => {
    const domain = saleVaultProxyUsdcDomain(421614)!;
    expect(() => transferAuthorizationDigest(domain, { ...AUTH, to: "0x12" })).toThrow(/to must/);
    expect(() => transferAuthorizationDigest(domain, { ...AUTH, nonce: "0x12" })).toThrow(/nonce/);
    expect(() => transferAuthorizationDigest(domain, { ...AUTH, value: -1n })).toThrow(/uint256/);
    expect(() => eip712DomainSeparator({ ...domain, verifyingContract: "usdc" })).toThrow(
      /verifyingContract/,
    );
  });

  it("names no domain on a chain without vectors", () => {
    expect(saleVaultProxyUsdcDomain(1)).toBeNull();
  });
});
