// The rail: implements core's ChainflipRail port over the pure pieces + a lazy (or injected) SDK.

import type {
  ChainflipRail,
  DepositChannel,
  OpenChannelArgs,
  Quote,
  ReverseQuoteInput,
  SourceAvailability,
  SourceDescriptor,
  SourceId,
  SwapStatusResult,
} from "@getsome/core";
import { requestDepositAddress } from "./deposit";
import { createLiquidityGate } from "./gate";
import { computeQuote, DEFAULT_EGRESS, type EgressConfig, type QuoteBackend } from "./quote";
import { createSwapSdk, type ChainflipNetworkId, type SwapSdkLike } from "./sdk";
import { getSwapStatus } from "./status";
import { SOURCE_CONFIGS, type SourceConfig } from "./sources";

export interface ChainflipRailOptions {
  /** Ignored when `sdk` is injected. Default 'mainnet'. */
  network?: ChainflipNetworkId;
  /** Inject a scripted/fake SDK (tests) or a pre-built one. */
  sdk?: SwapSdkLike;
  /** Optional restriction of the source catalog. */
  sources?: SourceId[];
  /** What the swap egresses to. Default Assethub/DOT. */
  egress?: EgressConfig;
  /** Liquidity-gate depth, in egress base units. Default 250 whole units of the egress asset. */
  liquidityGateAmount?: bigint;
}

/** Normalizes the reverse-quote target to egress base units, ceiling when scaling down. */
function toEgressUnits(
  target: { amount: bigint; decimals: number },
  egressDecimals: number,
): bigint {
  if (target.decimals === egressDecimals) return target.amount;
  if (target.decimals < egressDecimals) {
    return target.amount * 10n ** BigInt(egressDecimals - target.decimals);
  }
  const scale = 10n ** BigInt(target.decimals - egressDecimals);
  return (target.amount + scale - 1n) / scale;
}

export function createChainflipRail(opts: ChainflipRailOptions = {}): ChainflipRail {
  // Lazy: no SDK import (and no network touch) until the first call that needs it.
  let sdkPromise: Promise<SwapSdkLike> | null = opts.sdk ? Promise.resolve(opts.sdk) : null;
  const getSdk = (): Promise<SwapSdkLike> =>
    (sdkPromise ??= createSwapSdk(opts.network ?? "mainnet"));

  const enabled: readonly SourceConfig[] = opts.sources
    ? SOURCE_CONFIGS.filter((s) => opts.sources?.includes(s.sourceId))
    : SOURCE_CONFIGS;

  const descriptors: readonly SourceDescriptor[] = enabled.map(
    ({ sourceId, chain, asset, displayName, decimals }) => ({
      sourceId,
      chain,
      asset,
      displayName,
      decimals,
    }),
  );

  const configFor = (sourceId: SourceId): SourceConfig => {
    const cfg = enabled.find((s) => s.sourceId === sourceId);
    if (!cfg) throw new Error(`Unknown or disabled Chainflip source: ${sourceId}`);
    return cfg;
  };

  const backend: QuoteBackend = {
    getQuoteV2: async (args) => (await getSdk()).getQuoteV2(args),
  };
  const egress = opts.egress ?? DEFAULT_EGRESS;
  // Per-rail-instance gate (cache + in-flight dedup); see gate.ts.
  const gate = createLiquidityGate(backend, egress, opts.liquidityGateAmount);

  return {
    async getQuote(req: ReverseQuoteInput): Promise<Quote> {
      return computeQuote(
        backend,
        configFor(req.sourceId),
        toEgressUnits(req.target, egress.decimals),
        req.onChainOverheadPlancks,
        egress,
      );
    },
    async requestDepositAddress(args: OpenChannelArgs): Promise<DepositChannel> {
      return requestDepositAddress(await getSdk(), configFor(args.quote.sourceId), args);
    },
    async getStatus(depositChannelId: string): Promise<SwapStatusResult> {
      return getSwapStatus(await getSdk(), depositChannelId);
    },
    async probeLiquidity(sourceId: SourceId): Promise<SourceAvailability> {
      return gate.probe(configFor(sourceId));
    },
    sources(): readonly SourceDescriptor[] {
      return descriptors;
    },
  };
}
