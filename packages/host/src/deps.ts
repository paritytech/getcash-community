// createHostDeps: the one-call host deps bundle. Wires the host wrapper functions and a chain
// port into core's ports.

import type { ChainflipRail, ChainPort, EphemeralSigner, PaymentDeps } from "@getsome/core";
import { deriveKeypair, toEphemeralSigner } from "@getsome/ephemeral";
import { createHostEntropyPort, type DeriveEntropyLike } from "./entropy";
import { createHostStorageAdapter, type HostLocalStorageLike } from "./storage";

export interface HostDepsInput {
  chain: ChainPort;
  /** The real `hostLocalStorage` from @novasamatech/host-api-wrapper. */
  hostLocalStorage: HostLocalStorageLike;
  /** The real `deriveEntropy` from @novasamatech/host-api-wrapper. */
  deriveEntropy: DeriveEntropyLike;
  /** e.g. createChainflipRail({ network }) from @getsome/chainflip. */
  chainflip: ChainflipRail;
  /** Storage key prefix. Default 'onramp'. */
  storagePrefix?: string;
}

export interface HostDeps {
  deps: PaymentDeps;
  /** Bind straight into PaymentConfig.deriveSigner. */
  deriveSigner: (seed: Uint8Array) => EphemeralSigner;
}

export function createHostDeps(input: HostDepsInput): HostDeps {
  return {
    deps: {
      chain: input.chain,
      chainflip: input.chainflip,
      storage: createHostStorageAdapter(input.hostLocalStorage, input.storagePrefix),
      entropy: createHostEntropyPort(input.deriveEntropy),
    },
    deriveSigner: (seed) => toEphemeralSigner(deriveKeypair(seed)),
  };
}
