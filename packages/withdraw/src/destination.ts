// The destination's balance on Asset Hub, read at the finalized head (papi's default). The one
// read the arrival needs, shared by every driver of the tick so the hex to account conversion
// lives in one place, and the key's own read for the exact payment.

import { AccountId } from "polkadot-api";
import type { TokenSpec } from "@getsome/core";
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
  const address = accountId.dec(destinationHex);
  if (assetHubId === undefined) {
    return (await api.query.System.Account.getValue(address))?.data?.free ?? 0n;
  }
  const holding = await api.query.Assets.Account.getValue(assetHubId, address);
  return holding?.balance ?? 0n;
}

/** The account's balance in `token` and its nonce on Asset Hub at the finalized head; both 0 for
 *  an account the chain does not know. The exact payment reads the nonce to tell whether it
 *  already went out. */
export async function readAssetHubAccount(
  api: AssetHubApi,
  accountHex: string,
  token: TokenSpec,
): Promise<{ free: bigint; nonce: number }> {
  const account = await api.query.System.Account.getValue(accountId.dec(accountHex));
  const nonce = account?.nonce ?? 0;
  if (token.assetHubId === undefined) return { free: account?.data?.free ?? 0n, nonce };
  return { free: await readDestinationBalance(api, accountHex, token.assetHubId), nonce };
}
