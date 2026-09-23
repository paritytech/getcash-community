// The Asset Hub account reads the tick needs, at the current head. The hex-to-account conversion
// lives here so every driver of the tick shares one, and so does the distinction between the two
// accounts the tick reads: the destination, which is not ours and can only be measured as a gain
// against a baseline, and the burner, which is ours and can be read for what it actually holds
// and what it has already signed.

import { AccountId } from "polkadot-api";
import type { AssetHubApi } from "./fees";

const accountId = AccountId();

/** An Asset Hub address for a 32-byte public key. The SS58 prefix is only how an address prints;
 *  every chain decodes it back to the same public key, so one encoding serves both chains. */
export const assetHubAddressFor = (publicKeyHex: string): string => accountId.dec(publicKeyHex);

/** The destination's free PAS on Asset Hub at the head, 0 for an account the chain does not know. */
export async function readDestinationPas(
  api: AssetHubApi,
  destinationHex: string,
): Promise<bigint> {
  const account = await api.query.System.Account.getValue(assetHubAddressFor(destinationHex));
  return account?.data?.free ?? 0n;
}

/** The burner's own Asset Hub account: its free PAS and its nonce. The nonce is what tells a
 *  reloaded tick whether it has already signed something from this account; see tick.ts. */
export async function readBurnerOnAssetHub(
  api: AssetHubApi,
  burnerHex: string,
): Promise<{ free: bigint; nonce: number }> {
  const account = await api.query.System.Account.getValue(assetHubAddressFor(burnerHex));
  return { free: account?.data?.free ?? 0n, nonce: account?.nonce ?? 0 };
}
