// The withdrawal destinations: what the picker lists, how an address is checked, what each sells
// the CASH for, and where the funds land for a direct destination.

import { describe, expect, it } from "vitest";
import {
  assetHubAccountHex,
  isAssetHubAddress,
  landingAccountHex,
  matchesOtherNetwork,
  type H160AccountReader,
  shortDestinationAddress,
  WITHDRAW_NETWORKS,
  withdrawDestination,
  withdrawNetwork,
} from "../app/withdraw/destinations";

/** Alice, in the Polkadot prefix and in the generic one. */
const ALICE_POLKADOT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const ALICE_GENERIC = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ALICE_HEX = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
/** An Ethereum style account, mixed case as wallets show it. */
const H160 = "0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db";

/** A reader for paths that must not touch the chain. */
const noChain: H160AccountReader = () => Promise.reject(new Error("asked the chain"));

describe("withdrawal destinations", () => {
  it("lists Polkadot first on the direct rail, with its tokens, then the Chainflip networks", () => {
    expect(WITHDRAW_NETWORKS[0]).toMatchObject({ chain: "Polkadot", label: "Polkadot" });
    const assetHub = WITHDRAW_NETWORKS[0]!.destinations;
    expect(assetHub.every((d) => d.chainLabel === "Polkadot")).toBe(true);
    expect(assetHub.map((d) => [d.id, d.asset, d.rail])).toEqual([
      ["dot-assethub", "DOT", "direct"],
      ["dotusd-assethub", "dotUSD", "direct"],
      ["usdt-assethub", "USDT", "direct"],
      ["usdc-assethub", "USDC", "direct"],
    ]);
    // Each lands its token, named the way the on-ramp names a deposit, so the quote decides the
    // sale with the on-ramp's own rule.
    expect(assetHub.map((d) => d.landing)).toEqual(["native", "dotUSD", "USDT", "USDC"]);
    const others = WITHDRAW_NETWORKS.slice(1);
    expect(others.map((network) => network.label)).toEqual([
      "Bitcoin",
      "Ethereum",
      "Solana",
      "Tron",
    ]);
    const provided = others.flatMap((network) => network.destinations);
    expect(provided.every((d) => d.rail === "chainflip")).toBe(true);
    // A provider names no landing: the sale its quote picks decides what lands on the key.
    expect(provided.every((d) => d.landing === undefined)).toBe(true);
  });

  it("finds a network and a destination by id", () => {
    expect(withdrawNetwork("Ethereum")?.destinations.map((d) => d.asset)).toEqual([
      "ETH",
      "USDC",
      "USDT",
    ]);
    expect(withdrawDestination("dot-assethub")).toMatchObject({ asset: "DOT", rail: "direct" });
    expect(withdrawDestination("usdc-eth")).toMatchObject({ chain: "Ethereum", asset: "USDC" });
    expect(withdrawDestination("nope")).toBeUndefined();
  });

  it("accepts an Asset Hub account in any prefix and lands the PAS on its public key", async () => {
    expect(isAssetHubAddress(ALICE_POLKADOT)).toBe(true);
    expect(isAssetHubAddress(` ${ALICE_GENERIC} `)).toBe(true);
    expect(isAssetHubAddress("0x4B2c02db")).toBe(false);
    expect(isAssetHubAddress("15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp6")).toBe(false);
    expect(assetHubAccountHex(ALICE_GENERIC)).toBe(ALICE_HEX);
    // An SS58 account is its own landing: the chain is never asked.
    await expect(
      landingAccountHex(withdrawDestination("dot-assethub")!, ALICE_POLKADOT, noChain),
    ).resolves.toBe(ALICE_HEX);
    await expect(
      landingAccountHex(withdrawDestination("usdc-assethub")!, ALICE_GENERIC, noChain),
    ).resolves.toBe(ALICE_HEX);
  });

  it("accepts an H160 on Asset Hub and lands it on the account the chain maps it to", async () => {
    expect(isAssetHubAddress(H160)).toBe(true);
    expect(isAssetHubAddress(` ${H160} `)).toBe(true);
    expect(isAssetHubAddress(H160.slice(0, -1))).toBe(false);
    const dot = withdrawDestination("dot-assethub")!;
    // The chain is asked, with the H160 as it keys it, and its answer is the landing: here a
    // Polkadot account that claimed the H160, never the H160 padded.
    const asked: string[] = [];
    const claimedByAlice = async (h160: string) => {
      asked.push(h160);
      return ALICE_GENERIC;
    };
    await expect(landingAccountHex(dot, ` ${H160} `, claimedByAlice)).resolves.toBe(ALICE_HEX);
    expect(asked).toEqual([H160.toLowerCase()]);
    // A failed read stops the withdrawal rather than guessing.
    await expect(landingAccountHex(dot, H160, noChain)).rejects.toThrow("asked the chain");
  });

  it("checks a Chainflip destination's address with that chain's rule, and lands on the key", async () => {
    const ethereum = withdrawDestination("usdc-eth")!;
    expect(ethereum.validateAddress("0x4B2c0000000000000000000000000000000C02db")).toBe(true);
    expect(ethereum.validateAddress(ALICE_POLKADOT)).toBe(false);
    // No landing of its own: the PAS lands on the withdrawal's key, which pays the provider.
    await expect(
      landingAccountHex(ethereum, "0x4B2c0000000000000000000000000000000C02db", noChain),
    ).resolves.toBeNull();
  });

  it("tells a wrong-network address from a malformed one", () => {
    const ethereum = withdrawNetwork("Ethereum")!;
    // The design's example: a Bitcoin address on the Ethereum step.
    expect(matchesOtherNetwork(ethereum, "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toBe(true);
    expect(matchesOtherNetwork(ethereum, ` ${ALICE_POLKADOT} `)).toBe(true);
    expect(matchesOtherNetwork(ethereum, "1BvBMSEYstWetq")).toBe(false);
    // An Ethereum address on the Bitcoin step is the wrong network, not malformed.
    const bitcoin = withdrawNetwork("Bitcoin")!;
    expect(matchesOtherNetwork(bitcoin, "0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db")).toBe(true);
  });

  it("shortens an address around an ellipsis", () => {
    expect(shortDestinationAddress(ALICE_POLKADOT)).toBe("15oF4…r6Sp5");
    expect(shortDestinationAddress("short")).toBe("short");
    // Five each end, against the six the shared `shortAddress` leads with elsewhere.
    expect(shortDestinationAddress(`  ${ALICE_POLKADOT}  `)).toBe("15oF4…r6Sp5");
  });
});
