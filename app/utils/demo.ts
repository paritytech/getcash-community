// TODO(production): remove together with the faucet.
//
// A build is a demo when its network is a testnet and it runs on a local dev server or has the
// faucet configured.

import { NETWORK } from "@getsome/core";
import { isFaucetConfigured } from "~~/lib/faucet";

export function isDemoBuild(): boolean {
  return NETWORK.testnet && (import.meta.env.DEV || isFaucetConfigured());
}
