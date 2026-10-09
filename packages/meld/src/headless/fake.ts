// A MeldHeadlessClient for offline use: an approved customer with nothing outstanding, orders with
// a stand-in card order or sample transfer details, and a fixed status. Pairs with
// `createFakeMeldClient`, which quotes.

import type { MeldHeadlessClient } from "./client";
import type { BankInstructions, CustomerView, HeadlessFunding, KycState } from "./types";

export interface FakeMeldHeadlessOptions {
  /** Every check's state, the customer's and each provider's. Default 'approved'. */
  kyc?: KycState;
  /** Providers the customer is known to. Default TRANSAK, KOYWE, as `createFakeMeldClient`. */
  providers?: string[];
  /** Status every poll returns, in the adapter's vocabulary. Default 'session_opened'. */
  status?: string;
}

/** The payment method that opens a card order; every other one is a bank transfer. */
const CARD = "CREDIT_DEBIT_CARD";

/** Adapter states in which a bank order's details are still shown. */
const LIVE = new Set(["created", "session_opened", "transaction_seen"]);

/** Transfer details no bank will accept: the IBAN is the standard documented example. */
function sampleInstructions(
  rail: string,
  amount: string,
  currency: string,
  reference: string,
): BankInstructions {
  return {
    rail,
    amount,
    currency,
    accountHolderName: "Demo Payments (not a real account)",
    bankName: "Demo Bank",
    iban: "DE89370400440532013000",
    bic: "DEMODEFFXXX",
    reference,
  };
}

export function createFakeMeldHeadlessClient(
  opts: FakeMeldHeadlessOptions = {},
): MeldHeadlessClient {
  const kyc = opts.kyc ?? "approved";
  const providers = opts.providers ?? ["TRANSAK", "KOYWE"];
  const status = opts.status ?? "session_opened";
  const customer: CustomerView = {
    kyc,
    providers: providers.map((provider) => ({ provider, kyc })),
  };
  const orders = new Map<string, Omit<HeadlessFunding, "status">>();
  let orderSeq = 0;

  return {
    async getCustomer() {
      return customer;
    },
    async createCustomer() {
      return customer;
    },
    async startKyc() {
      return { url: "https://example.com/mock-kyc" };
    },
    async getRequirements() {
      return {
        agreements: [],
        verifications: [],
        missingFields: [],
        pending: false,
        blocked: false,
        ready: true,
      };
    },
    async submitDetails() {},
    async startVerification() {
      const at = new Date().toISOString();
      return { verificationId: "mock-verification", expiresAt: at, resendAvailableAt: at };
    },
    async confirmVerification() {
      return { status: "VERIFIED" };
    },
    async createOrder(req) {
      orderSeq += 1;
      const fundingRequestId = `mock-order-${orderSeq}`;
      const terms = {
        walletAddress: req.walletAddress,
        fiat: req.fiat,
        destinationCurrencyCode: req.destinationCurrencyCode,
        sourceAmount: req.sourceAmount,
      };
      if (req.paymentMethodType === CARD) {
        orders.set(fundingRequestId, { integrationMode: "headless", ...terms });
        return {
          fundingRequestId,
          kind: "card",
          order: { id: fundingRequestId, serviceProvider: req.serviceProvider, mock: true },
        };
      }
      const instructions = sampleInstructions(
        req.paymentMethodType,
        req.sourceAmount,
        req.fiat,
        `GETCASH-${orderSeq}`,
      );
      orders.set(fundingRequestId, {
        integrationMode: "headless",
        ...terms,
        paymentInstructions: instructions,
      });
      return { fundingRequestId, kind: "bank", instructions };
    },
    async getFunding(fundingRequestId) {
      const order = orders.get(fundingRequestId);
      if (order === undefined) return { status, integrationMode: "headless" };
      const { paymentInstructions, ...rest } = order;
      return LIVE.has(status) && paymentInstructions !== undefined
        ? { status, ...rest, paymentInstructions }
        : { status, ...rest };
    },
  };
}
