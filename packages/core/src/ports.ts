// The narrow ports that differ between host, browser and test. Every package codes against these.

import type { ActionCall, SettlementAsset } from "./action";
import type {
  DepositInfo,
  FailureKind,
  Quote,
  SourceId,
  Subscription,
  SwapProgress,
} from "./state";

/** String-valued KV store. Methods reject on transport error. */
export interface StorageAdapter {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
  subscribe?(key: string, cb: (value: string | null) => void): () => void;
}

/**
 * Seed derivation port. Host implementations derive deterministically; browser ones persist a
 * random seed.
 */
export interface EntropyPort {
  deriveSeed(key: Uint8Array): Promise<Uint8Array>;
  /** True when the seed is deterministically re-derivable. */
  readonly deterministic: boolean;
}

/**
 * The ephemeral signer. `signer` is typed opaquely here and refined to polkadot-api's
 * `PolkadotSigner` in `@getsome/ephemeral`.
 */
export interface EphemeralSigner {
  /** SS58 prefix 0 (Asset Hub). */
  readonly address: string;
  readonly signer: unknown;
}

export interface SubmitOutcome {
  readonly ok: boolean;
  readonly txRef?: string;
  readonly actualFee?: bigint;
}

/** How the atomic spend settles back. The ChainPort implementation composes the batch from this. */
export interface SettlePlan {
  /** The user's connected account, the settle-back destination. */
  readonly dest: string;
  readonly settlement: SettlementAsset;
}

export interface ChainPort {
  freeBalance(ss58: string): Promise<bigint>;
  watchFreeBalance(ss58: string, cb: (free: bigint) => void): Subscription;
  /**
   * Balance of `ss58` in the settlement asset's base units. `{kind:'native'}` is equivalent
   * to freeBalance.
   */
  settlementBalance(ss58: string, settlement: SettlementAsset): Promise<bigint>;
  watchSettlementBalance(
    ss58: string,
    settlement: SettlementAsset,
    cb: (balance: bigint) => void,
  ): Subscription;
  /** Broadcasts the library-built atomic batch, signed with the ephemeral. */
  submit(call: ActionCall, signer: EphemeralSigner, settle: SettlePlan): Promise<SubmitOutcome>;
  /** Sweeps everything the ephemeral holds back to `dest`. */
  sweep(dest: string, signer: EphemeralSigner, settlement: SettlementAsset): Promise<SubmitOutcome>;
  readonly api: unknown;
}

export interface ReverseQuoteInput {
  sourceId: SourceId;
  /** Desired output on Asset Hub. */
  target: { amount: bigint; decimals: number };
  /**
   * On-chain cost buffer added to the target when sizing the onramp, in plancks. Defaults to
   * the rail's 0.5 DOT.
   */
  onChainOverheadPlancks?: bigint;
}

export interface OpenChannelArgs {
  quote: Quote;
  /** Ephemeral SS58 (prefix 0). */
  destAddress: string;
}

export interface DepositChannel {
  deposit: DepositInfo;
  depositChannelId: string;
}

/** A rail's failure entry, surfaced with its human-readable reason. */
export interface RailFailureInfo {
  reason?: { code?: string; message?: string };
  /**
   * The rail's classification of this failure. Set only when the rail knows better than the
   * default.
   */
  kind?: FailureKind;
}

/** The rail's delivery to the destination, once it reports one. */
export interface EgressInfo {
  /** The delivery's transaction; deliver mode's receipt. */
  txRef?: string;
}

/**
 * Normalized rail status. `depositFailure` is a failure substate that ends the flow whatever the
 * top-level status says.
 */
export interface SwapStatusResult {
  status: SwapProgress | "failed";
  /** The delivery to the destination; deliver mode's receipt source. */
  egress?: EgressInfo;
  depositFailure?: RailFailureInfo;
  raw?: unknown;
}

export interface SourceDescriptor {
  readonly sourceId: SourceId;
  /** The chain the source deposits on, and its asset there. */
  readonly chain: string;
  readonly asset: string;
  readonly displayName: string;
  readonly decimals: number;
}

/** The contract a funding source meets: the Meld rail, and the manual rail for a direct deposit. */
export interface FundingRail {
  /** Reverse-quotes a desired output to a display-ready input. */
  getQuote(req: ReverseQuoteInput): Promise<Quote>;
  requestDepositAddress(args: OpenChannelArgs): Promise<DepositChannel>;
  /** Mapped, normalized status. */
  getStatus(depositChannelId: string): Promise<SwapStatusResult>;
  sources(): readonly SourceDescriptor[];
}

export interface PaymentDeps {
  chain: ChainPort;
  rail: FundingRail;
  storage: StorageAdapter;
  entropy: EntropyPort;
}
