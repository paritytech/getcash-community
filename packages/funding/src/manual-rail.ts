// A ChainflipRail stand-in for networks Chainflip cannot reach: the user sends the rail's token
// directly to the ephemeral's Asset Hub address. The quote is identity and the status poll stays
// 'waiting'; the funding pipeline and the session's funded-gate own progress.

import {
  TOKENS,
  type ChainflipRail,
  type DepositChannel,
  type OpenChannelArgs,
  type Quote,
  type ReverseQuoteInput,
  type SourceAvailability,
  type SourceDescriptor,
  type SourceId,
  type SwapStatusResult,
  type TokenSpec,
} from "@getsome/core";
import type { Stable } from "./stable";

/** The sources a direct deposit runs under, one per token: the token each takes and what the
 *  route decision calls it. The source keys the token's trade counter and burner labels. */
export const MANUAL_SOURCES = {
  "dot-assethub": { token: TOKENS.PAS, deposit: "native" },
  "usdt-assethub": { token: TOKENS.USDT, deposit: "USDT" },
  "usdc-assethub": { token: TOKENS.USDC, deposit: "USDC" },
} as const satisfies Partial<Record<SourceId, { token: TokenSpec; deposit: "native" | Stable }>>;

export type ManualSourceId = keyof typeof MANUAL_SOURCES;

export const MANUAL_SOURCE_IDS = Object.keys(MANUAL_SOURCES) as readonly ManualSourceId[];

export const isManualSourceId = (sourceId: string | undefined): sourceId is ManualSourceId =>
  sourceId !== undefined && Object.prototype.hasOwnProperty.call(MANUAL_SOURCES, sourceId);

/** The source a direct deposit of `token` runs under. */
export function manualSourceIdOf(token: TokenSpec): ManualSourceId {
  const sourceId = MANUAL_SOURCE_IDS.find((id) => MANUAL_SOURCES[id].token.symbol === token.symbol);
  if (sourceId === undefined) throw new Error(`no direct source takes ${token.symbol}`);
  return sourceId;
}

/** What the buyer deposits under a direct source, as the route decision takes it. */
export const manualDepositOf = (sourceId: ManualSourceId): "native" | Stable =>
  MANUAL_SOURCES[sourceId].deposit;

/** Exact base-units -> decimal string (trailing zeros trimmed). */
function formatUnits(base: bigint, decimals: number): string {
  const s = base.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "") || "0";
}

/** Ceil-normalizes the target to the token's base units. */
function toBaseUnits(target: { amount: bigint; decimals: number }, decimals: number): bigint {
  if (target.decimals === decimals) return target.amount;
  if (target.decimals < decimals) {
    return target.amount * 10n ** BigInt(decimals - target.decimals);
  }
  const scale = 10n ** BigInt(target.decimals - decimals);
  return (target.amount + scale - 1n) / scale;
}

export interface ManualRailOptions {
  /** The token the user is asked to send: what the request's tier converts from. Default
   *  `TOKENS.PAS`, the pool tier's. */
  token?: TokenSpec;
  /** The source the deposit runs under. Default the token's own. A request from before the
   *  per-token sources runs a stable under dot-assethub, so a given source stands as it is. */
  sourceId?: ManualSourceId;
  /** Deposit "channel" validity window, ms. Default 24h. */
  depositExpiryMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export function createManualRail(opts: ManualRailOptions = {}): ChainflipRail {
  const expiry = opts.depositExpiryMs ?? 86_400_000;
  const now = opts.now ?? Date.now;
  const token = opts.token ?? TOKENS.PAS;
  const sourceId = opts.sourceId ?? manualSourceIdOf(token);
  const descriptor: SourceDescriptor = Object.freeze({
    sourceId,
    chain: "AssetHub",
    // The rails' name for the token; the native's is its Polkadot counterpart's.
    asset: token.chainflipAsset ?? token.symbol,
    displayName: "Direct deposit",
    decimals: token.decimals,
  });

  return {
    async getQuote(req: ReverseQuoteInput): Promise<Quote> {
      const amount = toBaseUnits(req.target, token.decimals);
      return {
        sourceId: req.sourceId,
        source: {
          amount,
          formatted: formatUnits(amount, token.decimals),
          assetSymbol: descriptor.asset,
          decimals: token.decimals,
        },
        raw: null,
      };
    },
    async requestDepositAddress(args: OpenChannelArgs): Promise<DepositChannel> {
      return {
        deposit: {
          address: args.destAddress, // the ephemeral itself: send the token straight to it
          amount: args.quote.source.amount,
          formatted: args.quote.source.formatted,
          assetSymbol: descriptor.asset,
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
      return [descriptor];
    },
  };
}
