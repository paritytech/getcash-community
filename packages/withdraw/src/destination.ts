// The destination's balance on Asset Hub, read at the current head. The one read the arrival
// needs, shared by every driver of the tick so the hex to account conversion lives in one place.

import { AccountId } from "polkadot-api";
import type { AssetHubApi } from "./fees";

const accountId = AccountId();

/** The destination's balance on Asset Hub at the head: its free native with no asset id, its
 *  holding of that pallet-assets token with one. 0 for an account the chain does not know. */
export async function readDestinationBalance(
  api: AssetHubApi,
  destinationHex: string,
  assetHubId?: number,
): Promise<bigint> {
  const address = accountId.dec(destinationHex);
  if (assetHubId === undefined) {
    const account = await api.query.System.Account.getValue(address);
    return account?.data?.free ?? 0n;
  }
  const holding = await api.query.Assets.Account.getValue(assetHubId, address);
  return holding?.balance ?? 0n;
}
