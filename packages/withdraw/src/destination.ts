// The destination's PAS on Asset Hub, read at the current head. The one read the arrival needs,
// shared by every driver of the tick so the hex to account conversion lives in one place.

import { AccountId } from "polkadot-api";
import type { AssetHubApi } from "./fees";

const accountId = AccountId();

/** The destination's free PAS on Asset Hub at the head, 0 for an account the chain does not know. */
export async function readDestinationPas(
  api: AssetHubApi,
  destinationHex: string,
): Promise<bigint> {
  const address = accountId.dec(destinationHex);
  const account = await api.query.System.Account.getValue(address);
  return account?.data?.free ?? 0n;
}
