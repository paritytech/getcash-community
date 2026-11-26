// The withdrawal destinations: what the picker lists, how an address is checked, what each sells
// the CASH for, and where the funds land.

import { describe, expect, it } from "vitest";
import {
  assetHubAccountHex,
  isAssetHubAddress,
  landingAccountHex,
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
  it("lists Polkadot alone, with its tokens", () => {
    expect(WITHDRAW_NETWORKS).toHaveLength(1);
    expect(WITHDRAW_NETWORKS[0]).toMatchObject({ chain: "Polkadot", label: "Polkadot" });
    const assetHub = WITHDRAW_NETWORKS[0]!.destinations;
    expect(assetHub.every((d) => d.chainLabel === "Polkadot")).toBe(true);
    // Each lands its token, named the way the on-ramp names a deposit, so the quote decides the
    // sale with the on-ramp's own rule.
    expect(assetHub.map((d) => [d.id, d.asset, d.landing])).toEqual([
      ["dot-assethub", "DOT", "native"],
      ["dotusd-assethub", "dotUSD", "dotUSD"],
      ["usdt-assethub", "USDT", "USDT"],
      ["usdc-assethub", "USDC", "USDC"],
    ]);
  });

  it("finds a network and a destination by id, and none on a swap network", () => {
    expect(withdrawNetwork("Polkadot")).toBe(WITHDRAW_NETWORKS[0]);
    expect(withdrawDestination("dot-assethub")).toMatchObject({ asset: "DOT", landing: "native" });
    expect(withdrawNetwork("Ethereum")).toBeUndefined();
    expect(withdrawDestination("usdc-eth")).toBeUndefined();
  });

  it("accepts an Asset Hub account in any prefix and lands the PAS on its public key", async () => {
    expect(isAssetHubAddress(ALICE_POLKADOT)).toBe(true);
    expect(isAssetHubAddress(` ${ALICE_GENERIC} `)).toBe(true);
    expect(isAssetHubAddress("0x4B2c02db")).toBe(false);
    expect(isAssetHubAddress("15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp6")).toBe(false);
    expect(assetHubAccountHex(ALICE_GENERIC)).toBe(ALICE_HEX);
    // An SS58 account is its own landing: the chain is never asked.
    await expect(landingAccountHex(ALICE_POLKADOT, noChain)).resolves.toBe(ALICE_HEX);
    await expect(landingAccountHex(ALICE_GENERIC, noChain)).resolves.toBe(ALICE_HEX);
  });

  it("accepts an H160 on Asset Hub and lands it on the account the chain maps it to", async () => {
    expect(isAssetHubAddress(H160)).toBe(true);
    expect(isAssetHubAddress(` ${H160} `)).toBe(true);
    expect(isAssetHubAddress(H160.slice(0, -1))).toBe(false);
    // The chain is asked, with the H160 as it keys it, and its answer is the landing: here a
    // Polkadot account that claimed the H160, never the H160 padded.
    const asked: string[] = [];
    const claimedByAlice = async (h160: string) => {
      asked.push(h160);
      return ALICE_GENERIC;
    };
    await expect(landingAccountHex(` ${H160} `, claimedByAlice)).resolves.toBe(ALICE_HEX);
    expect(asked).toEqual([H160.toLowerCase()]);
    // A failed read stops the withdrawal rather than guessing.
    await expect(landingAccountHex(H160, noChain)).rejects.toThrow("asked the chain");
  });

  it("shortens an address around an ellipsis", () => {
    expect(shortDestinationAddress(ALICE_POLKADOT)).toBe("15oF4…r6Sp5");
    expect(shortDestinationAddress("short")).toBe("short");
    // Five each end, against the six the shared `shortAddress` leads with elsewhere.
    expect(shortDestinationAddress(`  ${ALICE_POLKADOT}  `)).toBe("15oF4…r6Sp5");
  });
});
