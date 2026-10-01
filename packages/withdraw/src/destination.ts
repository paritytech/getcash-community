// An account's PAS on Asset Hub at the best head (SALE_READ_AT), for the arrival check, the
// Chainflip sweep and the key's refund. At best, the arrival baseline includes what landed while
// finalized lagged; the sweep and the refund follow the arrival, so they read the same head.

import { AccountId } from "polkadot-api";
import { SALE_READ_AT, type AssetHubApi } from "./fees";

const accountId = AccountId();

/** The account's free PAS on Asset Hub at the best head, 0 for an account the chain does not know. */
export async function readDestinationPas(
  api: AssetHubApi,
  destinationHex: string,
): Promise<bigint> {
  return (await readAssetHubAccount(api, destinationHex)).free;
}

/** The account's free PAS and nonce on Asset Hub at the best head; both 0 for an account the chain
 *  does not know. The exact payment reads the nonce to tell whether it already went out. */
export async function readAssetHubAccount(
  api: AssetHubApi,
  accountHex: string,
): Promise<{ free: bigint; nonce: number }> {
  const address = accountId.dec(accountHex);
  const account = await api.query.System.Account.getValue(address, SALE_READ_AT);
  return { free: account?.data?.free ?? 0n, nonce: account?.nonce ?? 0 };
}
