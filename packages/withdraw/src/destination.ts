// An account's PAS on Asset Hub, read at the head the sale is sized at (SALE_READ_AT). Shared by
// every withdrawal read of an Asset Hub balance: the arrival check, the Chainflip sweep of the key
// and the key's refund read. At best, the baseline taken before a submit already includes anything
// that landed while the finalized head lagged, so that credit is not mistaken for this withdrawal's
// arrival. The sweep and the refund read follow the arrival, so they read the same head: at
// finalized they would find the key empty for a landing the arrival already counted.

import { AccountId } from "polkadot-api";
import { SALE_READ_AT, type AssetHubApi } from "./fees";

const accountId = AccountId();

/** The account's free PAS on Asset Hub at the best head, 0 for an account the chain does not know. */
export async function readDestinationPas(
  api: AssetHubApi,
  destinationHex: string,
): Promise<bigint> {
  const address = accountId.dec(destinationHex);
  const account = await api.query.System.Account.getValue(address, SALE_READ_AT);
  return account?.data?.free ?? 0n;
}
