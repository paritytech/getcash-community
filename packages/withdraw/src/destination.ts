// An account's balance on Asset Hub at the best head (SALE_READ_AT), for the arrival check, the
// Chainflip sweep and the key's refund. At best, the arrival baseline includes what landed while
// finalized lagged; the sweep and the refund follow the arrival, so they read the same head. The
// key's own read for the exact payment stays at the finalized head, which its nonce reasoning
// holds to.

import { AccountId } from "polkadot-api";
import { SALE_READ_AT, type AssetHubApi } from "./fees";

const accountId = AccountId();

/** The destination's balance on Asset Hub at the best head: its free native with no asset id, its
 *  holding of that pallet-assets token with one. 0 for an account the chain does not know. */
export async function readDestinationBalance(
  api: AssetHubApi,
  destinationHex: string,
  assetHubId?: number,
): Promise<bigint> {
  const address = accountId.dec(destinationHex);
  if (assetHubId === undefined) {
    const account = await api.query.System.Account.getValue(address, SALE_READ_AT);
    return account?.data?.free ?? 0n;
  }
  const holding = await api.query.Assets.Account.getValue(assetHubId, address, SALE_READ_AT);
  return holding?.balance ?? 0n;
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
