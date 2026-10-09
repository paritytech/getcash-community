// The adapter's headless wire contract: the customer, its KYC, the provider requirements and the
// order. Each `read*` checks one adapter response at runtime and throws on anything else.

import { toStatusResult, type MeldStatusResult } from "../client";

/** Meld Unified KYC state, or one provider's own. */
export type KycState = "none" | "pending" | "approved" | "rejected" | "expired";

export interface ProviderKyc {
  readonly provider: string;
  readonly kyc: KycState;
  /** The provider's own hosted questionnaire, when it asks for one. */
  readonly actionUrl?: string;
}

export interface CustomerView {
  readonly kyc: KycState;
  readonly providers: readonly ProviderKyc[];
}

export interface CustomerAddress {
  readonly lineOne: string;
  readonly lineTwo?: string;
  readonly city: string;
  readonly region?: string;
  readonly postalCode: string;
  /** ISO country, e.g. 'DE'. */
  readonly countryCode: string;
}

/** What `POST /customer` registers. It reaches Meld and the provider, never the adapter's log. */
export interface CustomerRegistration {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  /** ISO date, e.g. '1990-03-15'. */
  readonly dateOfBirth: string;
  readonly address?: CustomerAddress;
}

export type VerificationChannel = "EMAIL" | "PHONE";

export interface RequiredVerification {
  readonly channel: VerificationChannel;
  readonly reason: "MISSING" | "STALE" | "VOIP";
}

export interface ProviderAgreement {
  readonly type: string;
  readonly url: string;
}

/** What a provider still needs before an order. Without a customer token only `agreements` is
 *  meaningful, and `ready` is false. */
export interface RequirementsView {
  readonly agreements: readonly ProviderAgreement[];
  /** Required and not yet satisfied. */
  readonly verifications: readonly RequiredVerification[];
  readonly missingFields: readonly string[];
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly ready: boolean;
}

/** The order a set of requirements is asked for. */
export interface RequirementsQuery {
  readonly provider: string;
  readonly paymentMethodType: string;
  readonly country: string;
  readonly fiat: string;
  /** Fiat, whole-currency decimal string. */
  readonly sourceAmount: string;
  readonly destinationCurrencyCode: string;
}

/** Extra fields a provider asked for, sent to it as given. */
export interface ProviderDetails {
  readonly provider: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface VerificationRequest {
  readonly channel: VerificationChannel;
  /** An email address, or an E.164 phone number. */
  readonly target: string;
}

export interface VerificationStarted {
  readonly verificationId: string;
  /** As the adapter states them, e.g. '2026-08-25T02:57:26Z'. */
  readonly expiresAt: string;
  readonly resendAvailableAt: string;
}

export interface VerificationConfirmation {
  readonly verificationId: string;
  /** Sent exactly as the user typed it. */
  readonly code: string;
}

export type VerificationResult =
  | { readonly status: "VERIFIED" }
  | { readonly status: "FAILED"; readonly attemptsRemaining?: number };

export interface HeadlessOrderRequest {
  /** Names this order on the adapter. A replay answers with the order it opened. */
  readonly idempotencyKey: string;
  readonly country: string;
  readonly fiat: string;
  readonly destinationCurrencyCode: string;
  /** Fiat, whole-currency decimal string. */
  readonly sourceAmount: string;
  /** The burner's SS58 address, where the provider delivers. */
  readonly walletAddress: string;
  readonly paymentMethodType: string;
  readonly serviceProvider: string;
  readonly destinationNetworkCode: string;
  /** ISO timestamp of the buyer's acceptance of the provider's terms. */
  readonly termsAcceptedAt: string;
}

/** Where and how to pay a bank order. `reference`, when present, is mandatory on the transfer. */
export interface BankInstructions {
  /** The payment method, e.g. 'SEPA', 'ACH', 'PIX'. */
  readonly rail: string;
  /** Fiat, decimal string. */
  readonly amount: string;
  readonly currency: string;
  readonly accountHolderName?: string;
  readonly bankName?: string;
  readonly iban?: string;
  readonly bic?: string;
  readonly accountNumber?: string;
  readonly routingNumber?: string;
  readonly pixKey?: string;
  readonly reference?: string;
  /** Epoch ms. */
  readonly expiresAt?: number;
}

/** A card order carries Meld's order verbatim, for the SDK to mount; the adapter never stores it. */
export type HeadlessOrder =
  | { readonly fundingRequestId: string; readonly kind: "card"; readonly order: unknown }
  | {
      readonly fundingRequestId: string;
      readonly kind: "bank";
      readonly instructions: BankInstructions;
    };

export type IntegrationMode = "widget" | "headless";

/** `GET /funding/:id` with the headless additions. */
export interface HeadlessFunding extends MeldStatusResult {
  readonly integrationMode: IntegrationMode;
  /** Present only while a bank order is still payable. */
  readonly paymentInstructions?: BankInstructions;
}

export interface CustomerToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

type Json = Record<string, unknown>;

const KYC_STATES: readonly KycState[] = ["none", "pending", "approved", "rejected", "expired"];
const CHANNELS: readonly VerificationChannel[] = ["EMAIL", "PHONE"];
const REASONS: readonly RequiredVerification["reason"][] = ["MISSING", "STALE", "VOIP"];
const MODES: readonly IntegrationMode[] = ["widget", "headless"];

function unreadable(what: string): never {
  throw new Error(`[meld] the adapter returned an unreadable ${what}`);
}

const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function objectOf(v: unknown, what: string): Json {
  return isJson(v) ? v : unreadable(what);
}

function textOf(v: unknown, what: string): string {
  return typeof v === "string" && v.trim() !== "" ? v : unreadable(what);
}

/** Absent and null read the same; anything else must be non-empty text. */
function optionalText(v: unknown, what: string): string | undefined {
  return v == null ? undefined : textOf(v, what);
}

function oneOf<T extends string>(allowed: readonly T[], v: unknown, what: string): T {
  const found = allowed.find((a) => a === v);
  return found ?? unreadable(what);
}

function listOf<T>(v: unknown, what: string, item: (entry: unknown) => T): T[] {
  return Array.isArray(v) ? v.map(item) : unreadable(what);
}

function flagOf(v: unknown, what: string): boolean {
  return typeof v === "boolean" ? v : unreadable(what);
}

function epochOf(v: unknown, what: string): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : unreadable(what);
}

export function readChallenge(data: Json): string {
  return textOf(data.challenge, "customer challenge");
}

export function readCustomerToken(data: Json): CustomerToken {
  return {
    token: textOf(data.token, "customer token"),
    expiresAtMs: epochOf(data.expiresAtMs, "customer token expiry"),
  };
}

function readProviderKyc(raw: unknown): ProviderKyc {
  const entry = objectOf(raw, "provider KYC");
  const actionUrl = optionalText(entry.actionUrl, "provider KYC action URL");
  return {
    provider: textOf(entry.provider, "provider KYC provider"),
    kyc: oneOf(KYC_STATES, entry.kyc, "provider KYC state"),
    ...(actionUrl === undefined ? {} : { actionUrl }),
  };
}

function readCustomerView(raw: unknown): CustomerView {
  const customer = objectOf(raw, "customer");
  return {
    kyc: oneOf(KYC_STATES, customer.kyc, "customer KYC state"),
    providers: listOf(customer.providers, "customer providers", readProviderKyc),
  };
}

/** `GET /customer`: null until this key has registered. */
export function readCustomerLookup(data: Json): CustomerView | null {
  return data.customer === null ? null : readCustomerView(data.customer);
}

export function readCustomer(data: Json): CustomerView {
  return readCustomerView(data.customer);
}

export function readKycUrl(data: Json): string {
  return textOf(data.url, "KYC URL");
}

export function readRequirements(data: Json): RequirementsView {
  return {
    agreements: listOf(data.agreements, "agreements", (raw) => {
      const entry = objectOf(raw, "agreement");
      return {
        type: textOf(entry.type, "agreement type"),
        url: textOf(entry.url, "agreement URL"),
      };
    }),
    verifications: listOf(data.verifications, "verifications", (raw) => {
      const entry = objectOf(raw, "verification");
      return {
        channel: oneOf(CHANNELS, entry.channel, "verification channel"),
        reason: oneOf(REASONS, entry.reason, "verification reason"),
      };
    }),
    missingFields: listOf(data.missingFields, "missing fields", (raw) =>
      textOf(raw, "missing field"),
    ),
    pending: flagOf(data.pending, "requirements pending flag"),
    blocked: flagOf(data.blocked, "requirements blocked flag"),
    ready: flagOf(data.ready, "requirements ready flag"),
  };
}

export function readVerificationStarted(data: Json): VerificationStarted {
  return {
    verificationId: textOf(data.verificationId, "verification id"),
    expiresAt: textOf(data.expiresAt, "verification expiry"),
    resendAvailableAt: textOf(data.resendAvailableAt, "verification resend time"),
  };
}

export function readVerificationResult(data: Json): VerificationResult {
  const status = oneOf(["VERIFIED", "FAILED"] as const, data.status, "verification status");
  if (status === "VERIFIED") return { status };
  const left = data.attemptsRemaining;
  if (left == null) return { status };
  return typeof left === "number" && Number.isSafeInteger(left) && left >= 0
    ? { status, attemptsRemaining: left }
    : unreadable("verification attempts");
}

const BANK_DETAILS = [
  "accountHolderName",
  "bankName",
  "iban",
  "bic",
  "accountNumber",
  "routingNumber",
  "pixKey",
  "reference",
] as const;

function readBankInstructions(raw: unknown): BankInstructions {
  const at = objectOf(raw, "bank instructions");
  const details: { -readonly [K in (typeof BANK_DETAILS)[number]]?: string } = {};
  for (const key of BANK_DETAILS) {
    const value = optionalText(at[key], `bank ${key}`);
    if (value !== undefined) details[key] = value;
  }
  // Instructions with nowhere to send the money are no instructions at all.
  if (!details.iban && !details.accountNumber && !details.pixKey) {
    unreadable("bank instructions without an account");
  }
  return {
    rail: textOf(at.rail, "bank rail"),
    amount: textOf(at.amount, "bank amount"),
    currency: textOf(at.currency, "bank currency"),
    ...details,
    ...(at.expiresAt == null ? {} : { expiresAt: epochOf(at.expiresAt, "bank expiry") }),
  };
}

export function readOrder(data: Json): HeadlessOrder {
  const fundingRequestId = textOf(data.fundingRequestId, "order funding request id");
  const kind = oneOf(["card", "bank"] as const, data.kind, "order kind");
  return kind === "card"
    ? { fundingRequestId, kind, order: objectOf(data.order, "card order") }
    : { fundingRequestId, kind, instructions: readBankInstructions(data.instructions) };
}

export function readFunding(data: Json): HeadlessFunding {
  const funding = objectOf(data.funding, "funding request");
  return {
    ...toStatusResult(funding),
    status: textOf(funding.status, "funding status"),
    integrationMode: oneOf(MODES, funding.integrationMode, "integration mode"),
    ...(funding.paymentInstructions == null
      ? {}
      : { paymentInstructions: readBankInstructions(funding.paymentInstructions) }),
  };
}
