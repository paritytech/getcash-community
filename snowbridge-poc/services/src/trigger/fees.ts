import type { Address, Hex } from "viem";
import { describeError } from "../common/errors";

export type QuoteSample = { account: Hex; token: Address; amount: bigint };

export interface FeeSource {
  quote(sample: QuoteSample): Promise<bigint>;
  close(): Promise<void>;
}

export class FeeRefused extends Error {
  constructor(
    readonly reason: "too-low" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export type FeeStatus = { configured: string; quote?: string; required?: string; quotedAt?: string; quoteError?: string };

export type FeeGuardOptions = {
  marginMilli: bigint;
  // How long the last good quote may stand in for a source that fails.
  maxAgeMs: number;
  // After a failure the source is left alone this long, so a dead Asset Hub does not stall every item of a tick.
  retryAfterMs: number;
  now?: () => number;
};

export class FeeGuard {
  private good: { fee: bigint; at: number } | undefined;
  private failedAt: number | undefined;
  private failure: string | undefined;
  private readonly now: () => number;

  constructor(
    private readonly source: FeeSource,
    private readonly options: FeeGuardOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async check(sample: QuoteSample, configured: bigint): Promise<void> {
    await this.refresh(sample);
    const quote = this.usable();
    if (quote === undefined) throw new FeeRefused("unavailable", `no execution fee quote from Asset Hub within ${this.options.maxAgeMs} ms${this.failure ? `: ${this.failure}` : ""}`);
    const required = this.withMargin(quote);
    if (configured < required) {
      throw new FeeRefused("too-low", `EXECUTION_FEE_WEI ${configured} is below the Asset Hub quote ${quote} plus the margin (${required}); raise it`);
    }
  }

  async refresh(sample: QuoteSample): Promise<void> {
    if (this.failedAt !== undefined && this.now() - this.failedAt < this.options.retryAfterMs) return;
    try {
      this.good = { fee: await this.source.quote(sample), at: this.now() };
      this.failedAt = undefined;
      this.failure = undefined;
    } catch (error) {
      this.failedAt = this.now();
      this.failure = describeError(error);
    }
  }

  ageMs(): number {
    return this.good === undefined ? Number.POSITIVE_INFINITY : this.now() - this.good.at;
  }

  status(configured: bigint): FeeStatus {
    const quote = this.good?.fee;
    return {
      configured: configured.toString(),
      quote: quote?.toString(),
      required: quote === undefined ? undefined : this.withMargin(quote).toString(),
      quotedAt: this.good === undefined ? undefined : new Date(this.good.at).toISOString(),
      quoteError: this.failure,
    };
  }

  close(): Promise<void> {
    return this.source.close();
  }

  private usable(): bigint | undefined {
    return this.good !== undefined && this.now() - this.good.at <= this.options.maxAgeMs ? this.good.fee : undefined;
  }

  private withMargin(quote: bigint): bigint {
    return (quote * this.options.marginMilli + 999n) / 1000n;
  }
}
