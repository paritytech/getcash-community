// A ChainflipRail stand-in for networks Chainflip cannot reach: the user sends the native
// token directly to the ephemeral's Asset Hub address. The quote is identity and the status
// poll stays 'waiting'; the funding pipeline and the session's funded-gate own progress.

import type {
  ChainflipRail,
  DepositChannel,
  OpenChannelArgs,
  Quote,
  ReverseQuoteInput,
  SourceAvailability,
  SourceDescriptor,
  SwapStatusResult,
} from "@getsome/core";

const NATIVE_DECIMALS = 10;

const DESCRIPTOR: SourceDescriptor = Object.freeze({
  sourceId: "dot-assethub",
  chain: "AssetHub",
  asset: "DOT", // the generic native-token label
  displayName: "Direct deposit",
  decimals: NATIVE_DECIMALS,
});

/** Exact base-units -> decimal string (trailing zeros trimmed). */
function formatNative(base: bigint): string {
  const s = base.toString().padStart(NATIVE_DECIMALS + 1, "0");
  return (
    `${s.slice(0, -NATIVE_DECIMALS)}.${s.slice(-NATIVE_DECIMALS)}`.replace(/\.?0+$/, "") || "0"
  );
}

/** Ceil-normalizes the target to native base units. */
function toNativeUnits(target: { amount: bigint; decimals: number }): bigint {
  if (target.decimals === NATIVE_DECIMALS) return target.amount;
  if (target.decimals < NATIVE_DECIMALS) {
    return target.amount * 10n ** BigInt(NATIVE_DECIMALS - target.decimals);
  }
  const scale = 10n ** BigInt(target.decimals - NATIVE_DECIMALS);
  return (target.amount + scale - 1n) / scale;
}

export interface ManualRailOptions {
  /** Deposit "channel" validity window, ms. Default 24h. */
  depositExpiryMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export function createManualRail(opts: ManualRailOptions = {}): ChainflipRail {
  const expiry = opts.depositExpiryMs ?? 86_400_000;
  const now = opts.now ?? Date.now;

  return {
    async getQuote(req: ReverseQuoteInput): Promise<Quote> {
      const amount = toNativeUnits(req.target);
      return {
        sourceId: req.sourceId,
        source: {
          amount,
          formatted: formatNative(amount),
          assetSymbol: DESCRIPTOR.asset,
          decimals: NATIVE_DECIMALS,
        },
        raw: null,
      };
    },
    async requestDepositAddress(args: OpenChannelArgs): Promise<DepositChannel> {
      return {
        deposit: {
          address: args.destAddress, // the ephemeral itself: send native straight to it
          amount: args.quote.source.amount,
          formatted: args.quote.source.formatted,
          assetSymbol: DESCRIPTOR.asset,
          expiresAt: now() + expiry,
        },
        depositChannelId: "manual",
      };
    },
    async getStatus(): Promise<SwapStatusResult> {
      // No swap to track; arrival is detected by the funding pipeline / funded-gate.
      return { status: "waiting" };
    },
    async probeLiquidity(): Promise<SourceAvailability> {
      return { status: "available" };
    },
    sources(): readonly SourceDescriptor[] {
      return [DESCRIPTOR];
    },
  };
}
