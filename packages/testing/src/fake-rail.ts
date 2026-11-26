// Scriptable FundingRail fake: canned quote + channel, programmable status sequence.
// Complements createFakeHarness (chain+action) for driving the session's dual-poll offline.

import type {
  DepositChannel,
  FundingRail,
  OpenChannelArgs,
  Quote,
  ReverseQuoteInput,
  SourceAvailability,
  SourceDescriptor,
  SwapStatusResult,
} from "@getsome/core";

export interface FakeRailOptions {
  /** Overrides for the canned quote (sourceId always mirrors the request's). */
  quote?: Partial<Pick<Quote, "source" | "expiresAt" | "raw">>;
  /** When set, getQuote rejects with this error (scripted quote failure). */
  quoteError?: Error;
  /** Absolute expiry (ms) for opened channels. Default: opened-at + 24h. */
  channelExpiresAt?: number;
  /** Deposit address handed out for opened channels. */
  depositAddress?: string;
  /**
   * Status results consumed one per getStatus call; the last one repeats. Default: waiting forever.
   */
  statusSequence?: SwapStatusResult[];
  availability?: SourceAvailability;
  /** Per-source availability overrides (fall back to `availability`). */
  availabilityById?: Partial<Record<string, SourceAvailability>>;
  sources?: SourceDescriptor[];
}

export interface FakeRail extends FundingRail {
  /** Live counters/args for assertions (same object across reads). */
  readonly stats: {
    quoteCalls: number;
    channelsOpened: number;
    statusCalls: number;
    probeCalls: number;
    lastQuoteRequest: ReverseQuoteInput | null;
    lastChannelArgs: OpenChannelArgs | null;
  };
}

const DEFAULT_SOURCES: SourceDescriptor[] = [
  { sourceId: "dot-assethub", chain: "AssetHub", asset: "DOT", displayName: "DOT", decimals: 10 },
  { sourceId: "usdt-assethub", chain: "AssetHub", asset: "USDT", displayName: "USDT", decimals: 6 },
];

export function createFakeRail(opts: FakeRailOptions = {}): FakeRail {
  const quoteError = opts.quoteError ?? null;
  const channelExpiresAt = opts.channelExpiresAt ?? null;
  const sequence: SwapStatusResult[] =
    opts.statusSequence && opts.statusSequence.length > 0
      ? [...opts.statusSequence]
      : [{ status: "waiting" }];
  let statusIndex = 0;

  const stats = {
    quoteCalls: 0,
    channelsOpened: 0,
    statusCalls: 0,
    probeCalls: 0,
    lastQuoteRequest: null as ReverseQuoteInput | null,
    lastChannelArgs: null as OpenChannelArgs | null,
  };

  return {
    stats,

    async getQuote(req: ReverseQuoteInput): Promise<Quote> {
      stats.quoteCalls += 1;
      stats.lastQuoteRequest = req;
      if (quoteError) throw quoteError;
      return {
        sourceId: req.sourceId,
        source: opts.quote?.source ?? {
          amount: 10_000_000_000n,
          formatted: "1 DOT",
          assetSymbol: "DOT",
          decimals: 10,
        },
        ...(opts.quote?.expiresAt !== undefined ? { expiresAt: opts.quote.expiresAt } : {}),
        raw: opts.quote?.raw ?? {},
      };
    },

    async requestDepositAddress(args: OpenChannelArgs): Promise<DepositChannel> {
      stats.channelsOpened += 1;
      stats.lastChannelArgs = args;
      const expiresAt = channelExpiresAt ?? Date.now() + 86_400_000;
      return {
        deposit: {
          address: opts.depositAddress ?? "fake-deposit",
          amount: 10_000_000_000n,
          formatted: "1 DOT",
          assetSymbol: "DOT",
          expiresAt,
        },
        depositChannelId: `chan-${stats.channelsOpened}`,
      };
    },

    async getStatus(): Promise<SwapStatusResult> {
      stats.statusCalls += 1;
      const i = Math.min(statusIndex, sequence.length - 1);
      statusIndex += 1;
      return sequence[i] ?? { status: "waiting" };
    },

    async probeLiquidity(sourceId): Promise<SourceAvailability> {
      stats.probeCalls += 1;
      return opts.availabilityById?.[sourceId] ?? opts.availability ?? { status: "available" };
    },

    sources(): readonly SourceDescriptor[] {
      return opts.sources ?? DEFAULT_SOURCES;
    },
  };
}
