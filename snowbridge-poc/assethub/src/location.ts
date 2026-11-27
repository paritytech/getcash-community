import { blake2AsU8a } from "@polkadot/util-crypto";
import { bnToU8a, hexToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { FOREIGN_ASSETS_PRECOMPILE_SUFFIX } from "./constants.js";

const text = new TextEncoder();

/** Mirrors `ExternalConsensusLocationsConverterFor` for `(2, [GlobalConsensus(Ethereum), AccountKey20])`. */
export function ethereumSenderAccount(chainId: bigint, sender: Address): Hex {
  const preimage = u8aConcat(
    text.encode("ethereum-chain"),
    bnToU8a(chainId, { bitLength: 64, isLe: true }),
    hexToU8a(sender),
  );
  return u8aToHex(blake2AsU8a(preimage, 256));
}

/** Mirrors `AccountId32Mapper::to_address`: eth-derived accounts drop the 0xEE suffix, others are hashed. */
export function reviveAddress(account: Hex): Address {
  const bytes = hexToU8a(account);
  if (bytes.subarray(20).every((b) => b === 0xee)) return getAddress(u8aToHex(bytes.subarray(0, 20)));
  return getAddress(`0x${keccak256(account).slice(26)}`);
}

/** Mirrors `AccountId32Mapper::to_fallback_account_id`: the account of a contract or of an unmapped address. */
export function fallbackAccount(address: Address): Hex {
  return `${address.toLowerCase()}${"ee".repeat(12)}` as Hex;
}

export function ethereumJunction(chainId: bigint) {
  return { GlobalConsensus: { Ethereum: { chainId } } };
}

/** A contract or account on Ethereum, which is also how a bridged ERC-20 is named on Asset Hub. */
export function ethereumAccountLocation(chainId: bigint, address: Address) {
  return {
    parents: 2,
    interior: { X2: [ethereumJunction(chainId), { AccountKey20: { network: null, key: address } }] },
  };
}

export function etherLocation(chainId: bigint) {
  return { parents: 2, interior: { X1: [ethereumJunction(chainId)] } };
}

/** A network as XCM names it; `null` leaves it out. */
export type NetworkId = { ByGenesis: Hex } | { Polkadot: null } | { Kusama: null };

export function accountLocation(account: Hex, network: NetworkId | null = null) {
  return { parents: 0, interior: { X1: [{ AccountId32: { network, id: account } }] } };
}

/** ERC-20 precompile of a foreign asset: the asset index in the first four bytes, then the fixed suffix. */
export function foreignAssetPrecompile(assetIndex: number): Address {
  const index = assetIndex.toString(16).padStart(8, "0");
  return getAddress(`0x${index}${"00".repeat(12)}${FOREIGN_ASSETS_PRECOMPILE_SUFFIX}`);
}
