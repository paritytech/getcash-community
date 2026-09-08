// The reactive state vocabulary. One discriminated union on `phase`; fields exist only where
// meaningful.

/** Wire and storage ids for the source catalog. */
export type SourceId =
  | "btc"
  | "eth"
  | "usdc-eth"
  | "usdt-eth"
  | "flip-ethereum"
  | "eth-arbitrum"
  | "usdc-arbitrum"
  | "usdt-arbitrum"
  | "sol-solana"
  | "usdc-solana"
  | "usdt-solana"
  | "trx-tron"
  | "usdt-tron"
  /** Direct native (DOT) deposit onto the ephemeral on Asset Hub; served by @getsome/funding. */
  | "dot-assethub"
  /** Fiat on-ramp via Meld (card / bank transfer); the provider delivers native to the
   *  ephemeral. Served by @getsome/meld. */
  | "meld-card"
  | "meld-bank";

/** The coarse phase the stepper switches on. Persisted status maps onto this. */
export type PaymentPhase =
  | "idle"
  | "quoting"
  | "quoted"
  | "awaiting-deposit"
  | "swapping"
  | "funded"
  | "working"
  | "done"
  | "failed";

/** Chainflip swap sub-status, mapped from the SDK. */
export type SwapProgress = "waiting" | "receiving" | "swapping" | "sending" | "complete";

/**
 * Spend/handoff sub-status. 'awaiting-consent' and 'verifying' are handoff-only: the host
 * consent sheet is up, then the post-settle credit check runs.
 */
export type MintProgress =
  | { step: "funded" }
  | { step: "minting"; attempt: number; of: number }
  | { step: "awaiting-consent" }
  | { step: "verifying" }
  | { step: "sweeping" };

export interface Receipt {
  readonly id: number | string;
  readonly sourceId: SourceId;
}

/** Everything the deposit screen renders. */
export interface DepositInfo {
  readonly address: string;
  readonly amount: bigint;
  readonly formatted: string;
  readonly assetSymbol: string;
  readonly expiresAt: number;
  /**
   * Fiat rail only: the provider's hosted capture page, shown in an in-app WebView with the
   * destination locked to `address`. Not persisted.
   */
  readonly payUrl?: string;
}

export interface Quote {
  readonly sourceId: SourceId;
  readonly source: { amount: bigint; formatted: string; assetSymbol: string; decimals: number };
  readonly expiresAt?: number;
  readonly raw: unknown;
}

export type FailureKind =
  | "quote"
  | "deposit-rejected"
  | "egress-failed"
  | "fallback-egress"
  | "mint"
  /** Handoff only: settle resolved ok but the credit did not (fully) arrive. Non-recoverable. */
  | "under-credit"
  /** The swap could not fill and Chainflip is returning the deposit to the refund address. */
  | "refunded"
  | "refund-failed"
  | "expired"
  /** The rail could not tell what happened. */
  | "unknown"
  | "stale";

export type FailureStep = "deposit" | "swap" | "mint";

export interface PaymentFailure {
  readonly kind: FailureKind;
  readonly step: FailureStep;
  /** Human, renderable as-is. */
  readonly message: string;
  /** true only for kind === 'mint', the only kind retry() re-executes. */
  readonly recoverable: boolean;
}

/** The refund Chainflip streams back after a failed swap, as far as the status poll has seen. */
export interface RefundProgress {
  readonly amount?: string;
  readonly txRef?: string;
  readonly witnessedAt?: number;
}

/** Host-idiomatic reactive subscription handle. */
export interface Subscription {
  unsubscribe(): void;
}

/** The reactive value. Discriminated on `phase`; fields exist only where meaningful. */
export type PaymentState =
  | { phase: "idle"; sourceId: SourceId | null }
  | { phase: "quoting"; sourceId: SourceId }
  | { phase: "quoted"; sourceId: SourceId; quote: Quote }
  | { phase: "awaiting-deposit"; sourceId: SourceId; quote: Quote | null; deposit: DepositInfo }
  | {
      phase: "swapping";
      sourceId: SourceId;
      quote: Quote | null;
      deposit: DepositInfo;
      swap: SwapProgress;
    }
  | { phase: "funded"; sourceId: SourceId; deposit: DepositInfo | null; mint: MintProgress }
  | { phase: "working"; sourceId: SourceId; deposit: DepositInfo | null; mint: MintProgress }
  | { phase: "done"; sourceId: SourceId; result: Receipt }
  | { phase: "failed"; sourceId: SourceId; failure: PaymentFailure; refund?: RefundProgress };
