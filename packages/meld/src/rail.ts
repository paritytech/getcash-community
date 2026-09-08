// The Meld rail: core's ChainflipRail port over the Meld quote, session and status pieces.
// Meld delivers the native token to the burner on Asset Hub; the rest of the pipeline is unchanged.
// SourceId is 'meld-card' or 'meld-bank'.

import type {
  ChainflipRail,
  DepositChannel,
  OpenChannelArgs,
  Quote,
  ReverseQuoteInput,
  SourceAvailability,
  SourceDescriptor,
  SourceId,
} from "@getsome/core";
import type { MeldClientLike } from "./client";
import { NATIVE_ASSET, NATIVE_DECIMALS } from "./native";
import { computeMeldQuote, type MeldQuoteContext } from "./quote";
import { requestMeldDeposit } from "./session";
import { getMeldStatus } from "./status";

export type MeldMethod = "CARD" | "BANK_TRANSFER";

export interface MeldRailOptions {
  /** The Meld client (backend-proxy-backed in production, faked in tests). */
  client: MeldClientLike;
  /** ISO country of the buyer, e.g. 'US'. */
  country: string;
  /** Fiat the user pays in. Default 'USD'. */
  fiat?: string;
  /** Card or bank transfer. Drives the sourceId and label. Default 'CARD'. */
  method?: MeldMethod;
  /**
   * Meld payment-method code sent on the wire, e.g. 'CREDIT_DEBIT_CARD', 'ACH', 'SEPA'. Defaults
   * from `method`.
   */
  paymentMethodType?: string;
  /** Meld destination currency code. Default 'DOT_ASSETHUB'. */
  token?: string;
}

/** Default Meld payment-method code per UI category. Bank codes are region-specific. */
const DEFAULT_PAYMENT_METHOD: Record<MeldMethod, string> = {
  CARD: "CREDIT_DEBIT_CARD",
  BANK_TRANSFER: "ACH",
};

/** ChainflipRail plus the hosted pay URL for an opened session. */
export interface MeldRail extends ChainflipRail {
  /**
   * The hosted pay page for an opened session, keyed by depositChannelId. Undefined until
   * requestDepositAddress ran.
   */
  payUrl(depositChannelId: string): string | undefined;
}

const METHOD_LABEL: Record<MeldMethod, string> = {
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
};

const METHOD_SOURCE_ID: Record<MeldMethod, SourceId> = {
  CARD: "meld-card",
  BANK_TRANSFER: "meld-bank",
};

export function createMeldRail(opts: MeldRailOptions): MeldRail {
  const fiat = opts.fiat ?? "USD";
  const method: MeldMethod = opts.method ?? "CARD";
  const token = opts.token ?? "DOT_ASSETHUB";
  const paymentMethodType = opts.paymentMethodType ?? DEFAULT_PAYMENT_METHOD[method];
  const context: MeldQuoteContext = {
    country: opts.country,
    fiat,
    token,
    method: paymentMethodType,
  };

  // Session pay URLs, keyed by depositChannelId, filled at requestDepositAddress time.
  const payUrls = new Map<string, string>();

  const descriptor: SourceDescriptor = Object.freeze({
    sourceId: METHOD_SOURCE_ID[method],
    chain: "AssetHub",
    asset: NATIVE_ASSET,
    displayName: `${METHOD_LABEL[method]} · Meld`,
    decimals: NATIVE_DECIMALS,
  });

  return {
    getQuote(req: ReverseQuoteInput): Promise<Quote> {
      return computeMeldQuote(opts.client, context, req);
    },
    async requestDepositAddress(args: OpenChannelArgs): Promise<DepositChannel> {
      // Capture happens on the provider's hosted page, shown in an in-app WebView.
      const { channel, widgetUrl } = await requestMeldDeposit(opts.client, args);
      payUrls.set(channel.depositChannelId, widgetUrl);
      return channel;
    },
    getStatus(depositChannelId: string) {
      return getMeldStatus(opts.client, depositChannelId);
    },
    async probeLiquidity(): Promise<SourceAvailability> {
      // Availability is decided by the quote; getQuote fails for an unrouted region or method.
      return { status: "available" };
    },
    sources(): readonly SourceDescriptor[] {
      return [descriptor];
    },
    payUrl(depositChannelId: string): string | undefined {
      return payUrls.get(depositChannelId);
    },
  };
}
