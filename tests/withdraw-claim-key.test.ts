// A sale's claimer key: derived the same on the page and in the worker, revealed only on record.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { saleVaultProxyUsdcDomain } from "@getsome/chainflip";
import { deriveRefundKey, signTransferAuthorization } from "@getsome/ephemeral";

// The host's root as a hash of the raw label, so each label derives its own seed
const host = vi.hoisted(() => {
  const labels: string[] = [];
  const deriveEntropy = async (key: Uint8Array) => {
    labels.push(new TextDecoder().decode(key));
    const { sha256: hash } = await import("@noble/hashes/sha2.js");
    return { ok: true, value: hash(key) };
  };
  return { labels, deriveEntropy };
});

vi.mock("@parity/product-sdk-host", () => ({
  deriveEntropy: host.deriveEntropy,
  getHostLocalStorage: vi.fn(),
  getPaymentManager: vi.fn(),
  requestPermission: vi.fn(),
}));
vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: host.deriveEntropy,
  getHostLocalStorage: vi.fn(),
  getHostProvider: vi.fn(),
}));

import { claimEntropyLabel } from "@getsome/withdraw";
import {
  claimerKeyFor,
  revealClaimKey,
  signClaimRelay,
  withdrawEntropyLabel,
} from "../lib/withdraw-live";
import { claimerFor } from "../worker/src/shared.js";

const claimerOf = (label: string) =>
  deriveRefundKey("Arbitrum", sha256(new TextEncoder().encode(label))).address;

beforeEach(() => {
  host.labels.length = 0;
});

describe("claimEntropyLabel", () => {
  it("sits beside the withdrawal's own label, under its own prefix", () => {
    expect(claimEntropyLabel("wd:eph:meld-card:3")).toBe("wd:clm:meld-card:3");
    expect(claimEntropyLabel(withdrawEntropyLabel("wd:meld-bank", 12))).toBe("wd:clm:meld-bank:12");
  });

  it("fits the host's 32-byte key for the longest sale source and an 8-digit counter", () => {
    const label = claimEntropyLabel(withdrawEntropyLabel("wd:meld-card", 99_999_999));
    expect(new TextEncoder().encode(label).length).toBeLessThanOrEqual(32);
  });

  it("refuses a label over 32 bytes, which the worker could not derive raw", () => {
    expect(() => claimEntropyLabel(`wd:eph:${"x".repeat(24)}:1`)).toThrow(/32-byte/);
  });

  it("refuses a label that is not a withdrawal's", () => {
    for (const label of ["onramp:eph:btc:1", "wd:clm:meld-card:1", ""]) {
      expect(() => claimEntropyLabel(label)).toThrow(/not a withdrawal label/);
    }
  });
});

describe("withdrawEntropyLabel", () => {
  it("refuses a label over 32 bytes, which the worker could not derive raw", () => {
    expect(() => withdrawEntropyLabel(`wd:${"x".repeat(24)}`, 1)).toThrow(/32-byte/);
  });

  it("refuses a source that is not a withdrawal's", () => {
    expect(() => withdrawEntropyLabel("btc", 1)).toThrow(/not a withdrawal source/);
  });
});

describe("claimerKeyFor", () => {
  it("derives a secp256k1 address from the claim label's own entropy, the same each time", async () => {
    const claimer = await claimerKeyFor("wd:meld-card", 3);
    expect(claimer).toBe(claimerOf("wd:clm:meld-card:3"));
    expect(await claimerKeyFor("wd:meld-card", 3)).toBe(claimer);
    // The raw label reaches the host, never the withdrawal's own
    expect(host.labels).toEqual(["wd:clm:meld-card:3", "wd:clm:meld-card:3"]);
  });

  it("gives each withdrawal its own claimer", async () => {
    expect(await claimerKeyFor("wd:meld-card", 3)).not.toBe(await claimerKeyFor("wd:meld-card", 4));
    expect(await claimerKeyFor("wd:meld-card", 3)).not.toBe(await claimerKeyFor("wd:meld-bank", 3));
  });

  it("is the claimer the worker derives from the same label", async () => {
    const claimer = await claimerKeyFor("wd:meld-bank", 7);
    expect(await claimerFor("wd:clm:meld-bank:7")).toBe(claimer);
  });
});

describe("revealClaimKey", () => {
  it("reveals the wallet-importable secret of the claimer on record, in any casing", async () => {
    const claimer = await claimerKeyFor("wd:meld-card", 3);
    const key = await revealClaimKey("wd:eph:meld-card:3", claimer.toLowerCase());
    expect(key.address).toBe(claimer);
    expect(key.secret).toMatch(/^0x[0-9a-f]{64}$/);
    expect(deriveRefundKey("Arbitrum", Buffer.from(key.secret.slice(2), "hex")).address).toBe(
      claimer,
    );
  });

  it("refuses a key that is not the claimer on record", async () => {
    const other = await claimerKeyFor("wd:meld-card", 4);
    await expect(revealClaimKey("wd:eph:meld-card:3", other)).rejects.toThrow(/does not match/);
  });
});

describe("signClaimRelay", () => {
  const TO = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const NOW = 1_800_000_000_500;

  // The signature the claimer's own revealed key gives the relay's fields, the signer checked against ethers
  async function expectedSignature(
    relay: Awaited<ReturnType<typeof signClaimRelay>>,
    label: string,
    chainId: number,
  ): Promise<string> {
    const { secret } = await revealClaimKey(label, relay.from);
    return signTransferAuthorization(
      Buffer.from(secret.slice(2), "hex"),
      saleVaultProxyUsdcDomain(chainId)!,
      {
        from: relay.from,
        to: relay.to,
        value: BigInt(relay.value),
        validAfter: BigInt(relay.validAfter),
        validBefore: BigInt(relay.validBefore),
        nonce: relay.nonce,
      },
    );
  }

  it("signs the claimer's transfer to the chosen address for the adapter's relay", async () => {
    const claimer = await claimerKeyFor("wd:meld-card", 3);
    const relay = await signClaimRelay({
      label: "wd:eph:meld-card:3",
      claimerAddress: claimer.toLowerCase(),
      chainId: 421614,
      to: TO,
      value: 1_500_000n,
      nowMs: NOW,
    });
    expect(relay).toMatchObject({
      from: claimer,
      to: TO,
      value: "1500000",
      validAfter: "0",
      validBefore: "1800003600",
    });
    expect(relay.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(relay.signature).toMatch(/^0x[0-9a-f]{128}(1b|1c)$/);
    expect(relay.signature).toBe(await expectedSignature(relay, "wd:eph:meld-card:3", 421614));
  });

  it("draws a fresh nonce for every signature", async () => {
    const claimer = await claimerKeyFor("wd:meld-bank", 2);
    const args = {
      label: "wd:eph:meld-bank:2",
      claimerAddress: claimer,
      chainId: 42161,
      to: TO,
      value: 1n,
    };
    const [a, b] = [await signClaimRelay(args), await signClaimRelay(args)];
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.signature).toBe(await expectedSignature(a, "wd:eph:meld-bank:2", 42161));
  });

  it("refuses a key that is not the claimer on record, and signs nothing", async () => {
    const other = await claimerKeyFor("wd:meld-card", 4);
    await expect(
      signClaimRelay({
        label: "wd:eph:meld-card:3",
        claimerAddress: other,
        chainId: 421614,
        to: TO,
        value: 1n,
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("refuses a destination that is not an address or is the claimer, and an empty amount", async () => {
    const claimer = await claimerKeyFor("wd:meld-card", 3);
    const base = { label: "wd:eph:meld-card:3", claimerAddress: claimer, chainId: 421614 };
    await expect(signClaimRelay({ ...base, to: "5Grw", value: 1n })).rejects.toThrow(
      /not an Arbitrum address/,
    );
    await expect(signClaimRelay({ ...base, to: claimer.toLowerCase(), value: 1n })).rejects.toThrow(
      /already on/,
    );
    await expect(signClaimRelay({ ...base, to: TO, value: 0n })).rejects.toThrow(/nothing/);
    await expect(signClaimRelay({ ...base, chainId: 1, to: TO, value: 1n })).rejects.toThrow(
      /no USDC domain/,
    );
  });
});
