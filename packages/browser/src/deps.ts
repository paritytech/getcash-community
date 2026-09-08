// createBrowserDeps: the plain-browser dev bundle. Same session code as production; only the ports
// differ.

import type { ChainflipRail, EphemeralSigner, PaymentDeps } from "@getsome/core";
import { deriveKeypair, toEphemeralSigner } from "@getsome/ephemeral";
import { createReviveChainPort } from "@getsome/revive/papi";
import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { createBrowserEntropyPort } from "./entropy";
import { createLocalStorageAdapter, type WebStorageLike } from "./storage";

export interface BrowserDepsInput {
  /** A ready papi client, or `wsUrls` to build one. */
  client?: PolkadotClient;
  /** WS endpoint(s) for the target AH-family chain (used when `client` is not given). */
  wsUrls?: string[];
  /** e.g. createChainflipRail({ network: 'perseverance' }) from @getsome/chainflip. */
  chainflip: ChainflipRail;
  /** Storage key prefix. Default 'onramp:dev'. */
  storagePrefix?: string;
  /** Test/injection escape hatch for the storage backing. */
  storage?: WebStorageLike;
  /** Default true. */
  autoMap?: boolean;
}

export interface BrowserDeps {
  deps: PaymentDeps;
  /** Bind straight into PaymentConfig.deriveSigner. */
  deriveSigner: (seed: Uint8Array) => EphemeralSigner;
}

export function createBrowserDeps(input: BrowserDepsInput): BrowserDeps {
  const client =
    input.client ??
    (() => {
      if (!input.wsUrls || input.wsUrls.length === 0) {
        throw new Error("createBrowserDeps needs either a `client` or non-empty `wsUrls`");
      }
      return createClient(getWsProvider(input.wsUrls));
    })();

  return {
    deps: {
      chain: createReviveChainPort({
        client,
        ...(input.autoMap !== undefined ? { autoMap: input.autoMap } : {}),
      }),
      chainflip: input.chainflip,
      storage: createLocalStorageAdapter(input.storagePrefix, input.storage),
      entropy: createBrowserEntropyPort(),
    },
    deriveSigner: (seed) => toEphemeralSigner(deriveKeypair(seed)),
  };
}
