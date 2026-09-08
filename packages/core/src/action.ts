// The domain seam. The library owns batching, signing, submission and sweep; the action
// returns an opaque priced call and never sees the signer.

export type SettlementAsset =
  | { kind: "native" } // DOT, Tier-1
  | { kind: "stable"; asset: "USDC" | "USDT" } // Tier-2: swap-landed stable, fee paid in token
  | { kind: "pooled"; assetId: number } // Tier-2: any DOT-pooled pallet asset
  /**
   * A foreign (XCM-Location-keyed) asset identified by an opaque port-defined id. The ChainPort
   * implementation maps the id to its chain's storage.
   */
  | { kind: "foreign"; id: string };

/** Budget/target denomination (config.budget); sizes the reverse-quote. */
export interface Price {
  amount: bigint;
  asset: SettlementAsset;
}

/** The contract's own charge, in EVM 18-decimal units (distinct from the budget/target). */
export type PriceEvm = bigint;

/**
 * Stable per payment attempt (e.g. hash of recipient + payload + start-nonce). Scopes idempotency.
 */
export type IdempotencyKey = string;

/**
 * Opaque priced call the library wraps into `Revive.call`, scaling value /10^8 and owning the
 * batch.
 */
export interface ActionCall {
  /** Contract H160. */
  dest: `0x${string}`;
  /** Encoded calldata. */
  data: `0x${string}`;
  /** EVM 18-dec; the library scales /10^8 at the boundary. */
  value?: bigint;
  /** Optional; the library dry-run prices the call when absent. */
  weightHint?: { refTime: bigint; proofSize: bigint };
  /**
   * Cap on the storage deposit this call may hold, in plancks. The chain holds only what the
   * call creates. Default 0.2 DOT.
   */
  storageDepositHint?: bigint;
}

export interface ActionContext {
  payer: string;
  recipient: string;
}

/**
 * The domain injection point. The on-chain action built by `buildCall` must be idempotent:
 * it reverts or no-ops when already done. `isComplete` is a best-effort probe.
 */
export interface PaymentAction<T> {
  /** Returns the priced contract call; the library composes the batch, signs, and submits. */
  buildCall(ctx: ActionContext, payload: T, price: PriceEvm): Promise<ActionCall>;
  /** Idempotency probe scoped to this attempt via `key`. Runs before every submit. */
  isComplete(key: IdempotencyKey): Promise<{ id: number | string } | null>;
}
