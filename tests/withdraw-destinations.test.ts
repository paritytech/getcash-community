// The withdrawal destinations: what the picker lists, how an address is checked, what each sells
// the CASH for, and where the funds land for a direct destination.

import { describe, expect, it } from "vitest";
import {
  assetHubAccountHex,
  isAssetHubAddress,
  landingAccountHex,
  shortAddress,
  WITHDRAW_NETWORKS,
  withdrawDestination,
  withdrawNetwork,
} from "../app/withdraw/destinations";

/** Alice, in the Polkadot prefix and in the generic one. */
const ALICE_POLKADOT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const ALICE_GENERIC = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ALICE_HEX = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";

describe("withdrawal destinations", () => {
  it("lists Asset Hub first on the direct rail, with the Polkadot tokens, then the Chainflip networks", () => {
    expect(WITHDRAW_NETWORKS[0]).toMatchObject({ chain: "AssetHub", label: "Asset Hub" });
    const assetHub = WITHDRAW_NETWORKS[0]!.destinations;
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
    // A provider names no landing: the fiat rule decides what lands on the key for it.
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

  it("accepts an Asset Hub account in any prefix and lands the PAS on its public key", () => {
    expect(isAssetHubAddress(ALICE_POLKADOT)).toBe(true);
    expect(isAssetHubAddress(` ${ALICE_GENERIC} `)).toBe(true);
    expect(isAssetHubAddress("0x4B2c02db")).toBe(false);
    expect(isAssetHubAddress("15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp6")).toBe(false);
    expect(assetHubAccountHex(ALICE_GENERIC)).toBe(ALICE_HEX);
    expect(landingAccountHex(withdrawDestination("dot-assethub")!, ALICE_POLKADOT)).toBe(ALICE_HEX);
    expect(landingAccountHex(withdrawDestination("usdc-assethub")!, ALICE_GENERIC)).toBe(ALICE_HEX);
  });

  it("checks a Chainflip destination's address with that chain's rule, and lands on the key", () => {
    const ethereum = withdrawDestination("usdc-eth")!;
    expect(ethereum.validateAddress("0x4B2c0000000000000000000000000000000C02db")).toBe(true);
    expect(ethereum.validateAddress(ALICE_POLKADOT)).toBe(false);
    // No landing of its own: the PAS lands on the withdrawal's key, which pays the provider.
    expect(landingAccountHex(ethereum, "0x4B2c0000000000000000000000000000000C02db")).toBeNull();
  });

  it("shortens an address around an ellipsis", () => {
    expect(shortAddress(ALICE_POLKADOT)).toBe("15oF4…r6Sp5");
    expect(shortAddress("short")).toBe("short");
  });
});
