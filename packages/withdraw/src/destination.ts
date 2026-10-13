// The destination's balance on Asset Hub, read at the finalized head (papi's default). The one
// read the arrival needs, shared by every driver of the tick so the hex to account conversion
// lives in one place, and the key's own read for the exact payment.

import { AccountId } from "polkadot-api";
import type { AssetHubApi } from "./fees";

const accountId = AccountId();

/** The destination's balance on Asset Hub at the finalized head: its free native with no asset
 *  id, its holding of that pallet-assets token with one. 0 for an account the chain does not
 *  know. */
export async function readDestinationBalance(
  api: AssetHubApi,
  destinationHex: string,
  assetHubId?: number,
): Promise<bigint> {
  if (assetHubId === undefined) return (await readAssetHubAccount(api, destinationHex)).free;
  const holding = await api.query.Assets.Account.getValue(
    assetHubId,
    accountId.dec(destinationHex),
  );
  return holding?.balance ?? 0n;
}

/** The account's free PAS and nonce on Asset Hub at the finalized head; both 0 for an account the
 *  chain does not know. With an asset id, its holding of that pallet-assets token in place of the
 *  PAS. The exact payment reads the nonce to tell whether it already went out. */
export async function readAssetHubAccount(
  api: AssetHubApi,
  accountHex: string,
  assetHubId?: number,
): Promise<{ free: bigint; nonce: number }> {
  const address = accountId.dec(accountHex);
  const [account, holding] = await Promise.all([
    api.query.System.Account.getValue(address),
    assetHubId === undefined ? undefined : api.query.Assets.Account.getValue(assetHubId, address),
  ]);
  const free = assetHubId === undefined ? (account?.data?.free ?? 0n) : (holding?.balance ?? 0n);
  return { free, nonce: account?.nonce ?? 0 };
}
