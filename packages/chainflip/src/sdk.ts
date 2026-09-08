// The SDK boundary. SwapSdkLike is the structural interface the rest of the package codes against.

export type ChainflipNetworkId = "mainnet" | "perseverance";

export interface GetQuoteV2Args {
  srcChain: string;
  srcAsset: string;
  destChain: string;
  destAsset: string;
  amount: string;
}

/** Chainflip field names verbatim; this object goes on the wire as-is. */
export interface FillOrKillParams {
  refundAddress: string;
  slippageTolerancePercent: string;
  retryDurationMinutes: number;
}

export interface RequestDepositAddressV2Args {
  quote: unknown;
  destAddress: string;
  fillOrKillParams: FillOrKillParams;
}

export interface SwapSdkLike {
  getQuoteV2(args: GetQuoteV2Args): Promise<{ quotes: unknown[] }>;
  requestDepositAddressV2(args: RequestDepositAddressV2Args): Promise<unknown>;
  getStatusV2(args: { id: string }): Promise<unknown>;
  /** Chainflip's per-asset minimum swap amounts, keyed chain -> asset symbol, in base units. */
  getSwapLimits(): Promise<{
    minimumSwapAmounts: Readonly<Record<string, Readonly<Record<string, bigint>>>>;
  }>;
}

/** A quote request was below Chainflip's live per-asset floor; carries that floor. */
export class BelowMinimumSwapAmountError extends Error {
  constructor(
    readonly minimumBaseUnits: bigint,
    options?: { cause?: unknown },
  ) {
    super(`Chainflip minimum swap amount is ${minimumBaseUnits}`, options);
    this.name = "BelowMinimumSwapAmountError";
  }
}

/**
 * A quote request Chainflip refused or could not serve. `status` is the HTTP status when there
 * was a response, undefined when there was none (offline, DNS, a timeout in the transport).
 */
export class ChainflipRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ChainflipRequestError";
  }

  /** True for a 5xx or no response at all: a network failure, not an asset one. */
  get outage(): boolean {
    return this.status === undefined || this.status >= 500;
  }
}

type HttpErrorLike = {
  response?: {
    status?: unknown;
    data?: unknown;
  };
};

function responseMessage(data: unknown): string | null {
  if (typeof data === "string" && data.trim()) return data.trim();
  if (typeof data === "object" && data !== null && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return null;
}

/** Preserve useful Chainflip response details across the SDK/Axios boundary. */
export function normalizeQuoteRequestError(error: unknown): Error {
  const response =
    typeof error === "object" && error !== null ? (error as HttpErrorLike).response : undefined;
  const message = responseMessage(response?.data);
  const minimum = message?.match(/below minimum swap amount \((\d+)\)/i)?.[1];
  if (minimum !== undefined) {
    return new BelowMinimumSwapAmountError(BigInt(minimum), { cause: error });
  }

  const status = typeof response?.status === "number" ? response.status : undefined;
  const statusText = status === undefined ? "" : ` (HTTP ${status})`;
  const detail = message ?? (error instanceof Error ? error.message : String(error));
  return new ChainflipRequestError(
    `Chainflip quote request failed${statusText}: ${detail}`,
    status,
    {
      cause: error,
    },
  );
}

/**
 * Builds a SwapSdkLike over the real @chainflip/sdk, imported dynamically here.
 */
export async function createSwapSdk(network: ChainflipNetworkId): Promise<SwapSdkLike> {
  const { SwapSDK } = await import("@chainflip/sdk/swap");
  const sdk = new SwapSDK({ network });
  return {
    // The SDK's request types are zod-refined asset/chain unions; the plain-string args are
    // valid at runtime.
    getQuoteV2: async (args) => {
      try {
        return (await sdk.getQuoteV2(args as never)) as { quotes: unknown[] };
      } catch (error) {
        throw normalizeQuoteRequestError(error);
      }
    },
    requestDepositAddressV2: (args) => sdk.requestDepositAddressV2(args as never),
    getStatusV2: (args) => sdk.getStatusV2(args as never),
    getSwapLimits: async () => {
      // The SDK types this as a ChainAssetMap over its own chain/asset unions; structurally it
      // is the plain nested record the interface promises.
      const { minimumSwapAmounts } = await sdk.getSwapLimits();
      return { minimumSwapAmounts: minimumSwapAmounts as Record<string, Record<string, bigint>> };
    },
  };
}
