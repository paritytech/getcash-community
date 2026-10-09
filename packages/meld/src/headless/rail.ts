// The Meld rail over headless orders: the same port, quotes and status as `createMeldRail`, but
// the deposit step places an order whose payment the app renders itself instead of a hosted page.

import type {
  DepositChannel,
  OpenChannelArgs,
  Quote,
  ReverseQuoteInput,
  SourceAvailability,
  SourceDescriptor,
} from "@getsome/core";
import {
  computeMeldQuote,
  type MeldQuoter,
  type MeldQuoteContext,
  type MeldQuoteRaw,
} from "../quote";
import { meldRailRoute, type MeldRail, type MeldRailOptions } from "../rail";
import { RESUME_WINDOW_MS } from "../session";
import { getMeldStatus } from "../status";
import type { MeldHeadlessClient } from "./client";
import type { BankInstructions, HeadlessOrder } from "./types";

export interface MeldHeadlessRailOptions extends Omit<MeldRailOptions, "client"> {
  /** Places the order and reads its status. */
  client: Pick<MeldHeadlessClient, "createOrder" | "getFunding">;
  /** Prices the order through the adapter's quote route. */
  quoteClient: MeldQuoter;
  /** When the buyer accepted the provider's terms, ISO 8601. Read as the order is placed. */
  termsAcceptedAt: () => string;
}

/** How the buyer pays an opened order: the card order for the provider's SDK, or a transfer. */
export type MeldOrderPayment =
  | { readonly kind: "card"; readonly order: unknown }
  | { readonly kind: "bank"; readonly instructions: BankInstructions };

/** MeldRail plus the payment of an opened order. A headless order has no hosted pay page. */
export interface MeldHeadlessRail extends MeldRail {
  /** The payment for an opened order, keyed by depositChannelId. Undefined until
   *  requestDepositAddress ran. */
  payment(depositChannelId: string): MeldOrderPayment | undefined;
}

/** The idempotency key: the terms the buyer chose, as `createMeldClient` keys a session. A burner
 *  carries one order, so no attempt counter: a replay answers with the order already placed. */
function orderKey(context: MeldQuoteContext, walletAddress: string): string {
  return [
    "getcash",
    "order",
    walletAddress,
    context.fiat,
    context.token.meldCurrencyCode,
    context.method,
    context.country,
  ].join("-");
}

function paymentOf(order: HeadlessOrder): MeldOrderPayment {
  return order.kind === "card"
    ? { kind: "card", order: order.order }
    : { kind: "bank", instructions: order.instructions };
}

export function createMeldHeadlessRail(opts: MeldHeadlessRailOptions): MeldHeadlessRail {
  const route = meldRailRoute(opts);
  const context: MeldQuoteContext = { ...route.context, integrationMode: "headless" };
  const { descriptor } = route;

  // Order payments, keyed by depositChannelId, filled at requestDepositAddress time.
  const payments = new Map<string, MeldOrderPayment>();

  return {
    getQuote(req: ReverseQuoteInput): Promise<Quote> {
      return computeMeldQuote(opts.quoteClient, context, req);
    },
    async requestDepositAddress(args: OpenChannelArgs): Promise<DepositChannel> {
      const raw = args.quote.raw as MeldQuoteRaw | undefined;
      if (!raw?.provider || !raw.context) {
        throw new Error("Meld order needs a Meld quote (missing raw provider/context)");
      }
      const { provider, context: quoted } = raw;
      const network = provider.destinationNetworkCode;
      if (quoted.integrationMode !== "headless" || network === undefined) {
        throw new Error("Meld order needs a headless quote (missing destinationNetworkCode)");
      }

      const order = await opts.client.createOrder({
        idempotencyKey: orderKey(quoted, args.destAddress),
        country: quoted.country,
        fiat: quoted.fiat,
        destinationCurrencyCode: quoted.token.meldCurrencyCode,
        sourceAmount: provider.sourceAmount,
        walletAddress: args.destAddress,
        paymentMethodType: quoted.method,
        serviceProvider: provider.serviceProvider,
        destinationNetworkCode: network,
        termsAcceptedAt: opts.termsAcceptedAt(),
      });
      payments.set(order.fundingRequestId, paymentOf(order));

      const expiresAt = order.kind === "bank" ? order.instructions.expiresAt : undefined;
      return {
        depositChannelId: order.fundingRequestId,
        deposit: {
          address: args.destAddress,
          amount: args.quote.source.amount,
          formatted: args.quote.source.formatted,
          assetSymbol: args.quote.source.assetSymbol,
          // Falls back to the resume window so core can re-attach the channel after a reload.
          expiresAt: expiresAt ?? Date.now() + RESUME_WINDOW_MS,
        },
      };
    },
    getStatus(depositChannelId: string) {
      return getMeldStatus({ getStatus: (id) => opts.client.getFunding(id) }, depositChannelId);
    },
    async probeLiquidity(): Promise<SourceAvailability> {
      // Availability is decided by the quote; getQuote fails for an unrouted region or method.
      return { status: "available" };
    },
    sources(): readonly SourceDescriptor[] {
      return [descriptor];
    },
    payUrl(): undefined {
      return undefined;
    },
    payment(depositChannelId: string): MeldOrderPayment | undefined {
      return payments.get(depositChannelId);
    },
  };
}
