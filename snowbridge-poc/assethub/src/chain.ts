import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { ASSET_HUB_WS } from "./constants.js";

export async function connect(url: string = ASSET_HUB_WS): Promise<ApiPromise> {
  return ApiPromise.create({ provider: new WsProvider(url), noInitWarn: true });
}

export function devKeyring(uri: string) {
  return new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri(uri);
}
