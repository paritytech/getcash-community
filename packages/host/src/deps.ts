// createHostDeps: the one-call host deps bundle. Wires the host wrapper functions and a papi
// client into core's ports.

import type { ChainflipRail, ChainPort, EphemeralSigner, PaymentDeps } from "@getsome/core";
import { deriveKeypair, toEphemeralSigner } from "@getsome/ephemeral";
import { createReviveChainPort } from "@getsome/revive/papi";
import type { PolkadotClient } from "polkadot-api";
import { createHostEntropyPort, type DeriveEntropyLike } from "./entropy";
import { createHostStorageAdapter, type HostLocalStorageLike } from "./storage";

export interface HostDepsInput {
  /** papi client for the target AH-family chain (host provider or WS fallback). */
  client: PolkadotClient;
  /** The real `hostLocalStorage` from @novasamatech/host-api-wrapper. */
  hostLocalStorage: HostLocalStorageLike;
  /** The real `deriveEntropy` from @novasamatech/host-api-wrapper. */
  deriveEntropy: DeriveEntropyLike;
  /** e.g. createChainflipRail({ network }) from @getsome/chainflip. */
  chainflip: ChainflipRail;
  /** Storage key prefix. Default 'onramp'. */
  storagePrefix?: string;
  /** Default true. */
  autoMap?: boolean;
  /**
   * Override the chain port. Default: the Asset Hub Revive port over `client`.
   */
  chain?: ChainPort;
}

export interface HostDeps {
  deps: PaymentDeps;
  /** Bind straight into PaymentConfig.deriveSigner. */
  deriveSigner: (seed: Uint8Array) => EphemeralSigner;
}

export function createHostDeps(input: HostDepsInput): HostDeps {
  return {
    deps: {
      chain:
        input.chain ??
        createReviveChainPort({
          client: input.client,
          ...(input.autoMap !== undefined ? { autoMap: input.autoMap } : {}),
        }),
      chainflip: input.chainflip,
      storage: createHostStorageAdapter(input.hostLocalStorage, input.storagePrefix),
      entropy: createHostEntropyPort(input.deriveEntropy),
    },
    deriveSigner: (seed) => toEphemeralSigner(deriveKeypair(seed)),
  };
}
