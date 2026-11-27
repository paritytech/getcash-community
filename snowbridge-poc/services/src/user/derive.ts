import { createPrivateKey, createPublicKey } from "node:crypto";
import { encodeAddress } from "@polkadot/util-crypto";
import { hexToBytes, keccak256, toBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

// Owner EVM key = keccak256("getcash-poc/owner/" + seed); Asset Hub account = ed25519 public key of keccak256("getcash-poc/assethub/" + seed).
const OWNER_DOMAIN = "getcash-poc/owner/";
const ASSETHUB_DOMAIN = "getcash-poc/assethub/";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const WESTEND_SS58_PREFIX = 42;

export type User = {
  owner: PrivateKeyAccount;
  assetHubAccount: Hex;
  assetHubAddress: string;
};

export function deriveUser(seed: string): User {
  const owner = privateKeyToAccount(keccak256(toBytes(OWNER_DOMAIN + seed)));
  const assetHubAccount = ed25519PublicKey(deriveAssetHubSeed(seed));
  return { owner, assetHubAccount, assetHubAddress: encodeAddress(hexToBytes(assetHubAccount), WESTEND_SS58_PREFIX) };
}

// The 32-byte ed25519 seed behind `assetHubAccount`, for whoever has to sign on Asset Hub.
export function deriveAssetHubSeed(seed: string): Hex {
  return keccak256(toBytes(ASSETHUB_DOMAIN + seed));
}

function ed25519PublicKey(seed: Hex): Hex {
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, hexToBytes(seed)]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return toHex(spki.subarray(spki.length - 32));
}
