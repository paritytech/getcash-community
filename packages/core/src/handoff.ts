// The handoff seam: funds land on the ephemeral, then a host-side settlement claims them with
// the ephemeral's secret. settle() blocks on the host's consent sheet and its response is not
// proof of credit; only isSettled() flips the flow to done.

import type { IdempotencyKey } from "./action";
import type { EphemeralSigner } from "./ports";

/**
 * Ephemeral key material derived per handoff flow. Adds the 64-byte schnorrkel secret (scalar
 * followed by nonce) that settle() hands to the host. Held in memory only, re-derived on resume.
 */
export interface HandoffKey extends EphemeralSigner {
  readonly secretKey: Uint8Array;
}

/** Everything settle() needs to perform the host-side claim. */
export interface HandoffContext {
  /** 64-byte schnorrkel secret of the funded ephemeral. */
  readonly secretKey: Uint8Array;
  /** The ephemeral's SS58 address (prefix 0), for balance inspection/telemetry. */
  readonly address: string;
  /** Exact settle amount in the settlement asset's base units. */
  readonly amount: bigint;
}

/**
 * The handoff injection point for host-settled flows. `settle` performs the host settlement
 * and resolves after the user confirms on the consent sheet; its resolution is not proof of
 * credit. `isSettled` is the source of truth and is probed before and after every settle.
 */
export interface HandoffAction {
  settle(ctx: HandoffContext, key: IdempotencyKey): Promise<void>;
  isSettled(key: IdempotencyKey): Promise<{ id: string } | null>;
}
