// TODO(production): remove together with the faucet.
//
// A build is a demo when it runs on a local dev server or has the faucet configured.

import { isFaucetConfigured } from "~~/lib/faucet";

export function isDemoBuild(): boolean {
  return import.meta.env.DEV || isFaucetConfigured();
}
