// The bridge key from a seed, with the parts of the bridge package that use it: the signer of
// Ethereum transactions and the signer of the permit on Hydration.

import { describe, expect, it } from "vitest";
import {
  evmAddressOf,
  hydrationAccountOf,
  signEvmTransaction,
  signPermit,
  type HydrationPermit,
} from "@getsome/bridge";
import { deriveBridgeSigner } from "@getsome/ephemeral";

const SEED = new Uint8Array(32).fill(0x2a);

describe("the bridge key from a seed", () => {
  const signer = deriveBridgeSigner(SEED);

  it("has the address that the bridge package gives its key", () => {
    expect(evmAddressOf(signer.privateKey)).toBe(signer.address);
  });

  it("signs an Ethereum transaction", () => {
    const signed = signEvmTransaction(
      {
        chainId: 8453n,
        nonce: 0n,
        maxPriorityFeePerGas: 1n,
        maxFeePerGas: 2n,
        gasLimit: 21_000n,
        to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        value: 1n,
        data: new Uint8Array(0),
      },
      signer.privateKey,
    );
    expect(signed.raw[0]).toBe(0x02);
    expect(signed.hash).toHaveLength(32);
  });

  it("signs a permit, and its address names the account the HOLLAR lands on", () => {
    const permit: HydrationPermit = {
      from: signer.address,
      call: Uint8Array.of(1, 2, 3),
      gasLimit: 5_000_000n,
      nonce: 0n,
      deadline: 1_800_000_000n,
    };
    const signature = signPermit(permit, signer.privateKey);
    expect([27, 28]).toContain(signature.v);
    expect(signature.r).toHaveLength(32);
    expect(signature.s).toHaveLength(32);
    expect(hydrationAccountOf(signer.address)).toBe(
      `0x45544800${signer.address.slice(2)}0000000000000000`,
    );
  });
});
