// The withdrawal destinations: what the picker lists, how an address is checked, and where the
// PAS lands for a direct destination.

import { describe, expect, it } from "vitest";
import {
  assetHubAccountHex,
  isAssetHubAddress,
  landingAccountHex,
  matchesOtherNetwork,
  shortDestinationAddress,
  WITHDRAW_NETWORKS,
  withdrawDestination,
  withdrawNetwork,
} from "../app/withdraw/destinations";

/** Alice, in the Polkadot prefix and in the generic one. */
const ALICE_POLKADOT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const ALICE_GENERIC = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ALICE_HEX = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";

describe("withdrawal destinations", () => {
  it("lists Polkadot (Asset Hub) first on the direct rail, then the Chainflip networks", () => {
    expect(WITHDRAW_NETWORKS[0]).toMatchObject({ chain: "AssetHub", label: "Polkadot" });
    expect(WITHDRAW_NETWORKS[0]!.destinations.map((d) => d.rail)).toEqual(["direct"]);
    const others = WITHDRAW_NETWORKS.slice(1);
    expect(others.map((network) => network.label)).toEqual([
      "Bitcoin",
      "Ethereum",
      "Solana",
      "Tron",
    ]);
    expect(
      others.flatMap((network) => network.destinations).every((d) => d.rail === "chainflip"),
    ).toBe(true);
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
  });

  it("checks a Chainflip destination's address with that chain's rule, and lands on the key", () => {
    const ethereum = withdrawDestination("usdc-eth")!;
    expect(ethereum.validateAddress("0x4B2c0000000000000000000000000000000C02db")).toBe(true);
    expect(ethereum.validateAddress(ALICE_POLKADOT)).toBe(false);
    // No landing of its own: the PAS lands on the withdrawal's key, which pays the provider.
    expect(landingAccountHex(ethereum, "0x4B2c0000000000000000000000000000000C02db")).toBeNull();
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
