// The destination's PAS on Asset Hub, read at the finalized head (papi's default). The one read the
// arrival needs, shared by every driver of the tick so the hex to account conversion lives in one
// place, and the key's own read for the exact payment.

import { AccountId } from "polkadot-api";
import type { AssetHubApi } from "./fees";

const accountId = AccountId();

/** The destination's free PAS on Asset Hub at the finalized head, 0 for an account the chain does
 *  not know. */
export async function readDestinationPas(
  api: AssetHubApi,
  destinationHex: string,
): Promise<bigint> {
  return (await readAssetHubAccount(api, destinationHex)).free;
}

/** The account's free PAS and nonce on Asset Hub at the finalized head; both 0 for an account the
 *  chain does not know. The exact payment reads the nonce to tell whether it already went out. */
export async function readAssetHubAccount(
  api: AssetHubApi,
  accountHex: string,
): Promise<{ free: bigint; nonce: number }> {
  const address = accountId.dec(accountHex);
  const account = await api.query.System.Account.getValue(address);
  return { free: account?.data?.free ?? 0n, nonce: account?.nonce ?? 0 };
}
