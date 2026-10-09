// The adapter's headless routes: the customer behind a customer key, its KYC and provider
// requirements, and the order. Customer routes carry a short-lived token the adapter issues
// against a signature of its challenge, so the key itself never leaves the device.

import { AdapterRefusal, readAdapterBody, STATUS_TIMEOUT_MS } from "../client";
import {
  readChallenge,
  readCustomer,
  readCustomerLookup,
  readCustomerToken,
  readFunding,
  readKycUrl,
  readOrder,
  readRequirements,
  readVerificationResult,
  readVerificationStarted,
  type CustomerRegistration,
  type CustomerToken,
  type CustomerView,
  type HeadlessFunding,
  type HeadlessOrder,
  type HeadlessOrderRequest,
  type ProviderDetails,
  type RequirementsQuery,
  type RequirementsView,
  type VerificationConfirmation,
  type VerificationRequest,
  type VerificationResult,
  type VerificationStarted,
} from "./types";

/** Signs the adapter's challenge bytes as they are, with no `<Bytes>` wrapper. */
export interface MeldCustomerSigner {
  /** The sr25519 public key, lowercase and 0x-prefixed. */
  readonly publicKeyHex: string;
  signRaw(message: Uint8Array): Uint8Array;
}

export interface MeldHeadlessConfig {
  /** Base URL of the onramp adapter service. */
  baseUrl: string;
  /** Sent as `x-dev-product-id` for the adapter's dev auth. */
  productId?: string;
  /** Injectable fetch (tests / non-browser). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  signer: MeldCustomerSigner;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface MeldHeadlessClient {
  /** Null until this key has registered. */
  getCustomer(): Promise<CustomerView | null>;
  createCustomer(details: CustomerRegistration): Promise<CustomerView>;
  /** The hosted identity check to show; a fresh one on every call. */
  startKyc(): Promise<{ readonly url: string }>;
  /** Without a customer token only the agreements are meaningful, so one is sent when it can be
   *  obtained. */
  getRequirements(query: RequirementsQuery): Promise<RequirementsView>;
  submitDetails(details: ProviderDetails): Promise<void>;
  startVerification(request: VerificationRequest): Promise<VerificationStarted>;
  confirmVerification(confirmation: VerificationConfirmation): Promise<VerificationResult>;
  createOrder(request: HeadlessOrderRequest): Promise<HeadlessOrder>;
  getFunding(fundingRequestId: string): Promise<HeadlessFunding>;
}

/** A token this close to its expiry is replaced rather than sent. */
const TOKEN_REFRESH_MARGIN_MS = 30_000;

type Method = "GET" | "POST";

function base64UrlBytes(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  } catch {
    throw new Error("[meld] the adapter returned an unreadable customer challenge");
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const hexOf = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

const tokenRejected = (err: unknown): boolean =>
  err instanceof AdapterRefusal && err.status === 401 && err.code === "CUSTOMER_TOKEN_INVALID";

export function createMeldHeadlessClient(config: MeldHeadlessConfig): MeldHeadlessClient {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.baseUrl.replace(/\/$/, "");
  const now = config.now ?? Date.now;
  let cached: CustomerToken | null = null;
  let issuing: Promise<string> | null = null;

  async function call(
    method: Method,
    path: string,
    what: string,
    options: { body?: unknown; token?: string; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(config.productId ? { "x-dev-product-id": config.productId } : {}),
        ...(options.token === undefined ? {} : { "x-customer-token": options.token }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.timeoutMs === undefined
        ? {}
        : { signal: AbortSignal.timeout(options.timeoutMs) }),
    });
    return readAdapterBody(res, what);
  }

  async function issueToken(): Promise<string> {
    const what = "Confirming your account";
    const challenge = readChallenge(await call("POST", "/customer/challenge", what, { body: {} }));
    const signature = config.signer.signRaw(base64UrlBytes(challenge));
    const issued = readCustomerToken(
      await call("POST", "/customer/token", what, {
        body: { publicKey: config.signer.publicKeyHex, challenge, signature: hexOf(signature) },
      }),
    );
    cached = issued;
    return issued.token;
  }

  /** The cached token while it has time left, else a new one. Concurrent callers share one issue. */
  function customerToken(): Promise<string> {
    if (cached !== null && now() < cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS) {
      return Promise.resolve(cached.token);
    }
    issuing ??= issueToken().finally(() => {
      issuing = null;
    });
    return issuing;
  }

  /** Sends with `token`. A token the adapter no longer accepts is replaced and the call retried
   *  once; a second refusal is final. */
  async function withToken(
    token: string,
    method: Method,
    path: string,
    what: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      return await call(method, path, what, { body, token });
    } catch (err) {
      if (!tokenRejected(err)) throw err;
      if (cached?.token === token) cached = null;
      return call(method, path, what, { body, token: await customerToken() });
    }
  }

  const asCustomer = async (method: Method, path: string, what: string, body?: unknown) =>
    withToken(await customerToken(), method, path, what, body);

  return {
    async getCustomer() {
      return readCustomerLookup(await asCustomer("GET", "/customer", "Checking your identity"));
    },

    async createCustomer(details) {
      return readCustomer(await asCustomer("POST", "/customer", "Saving your details", details));
    },

    async startKyc() {
      const data = await asCustomer("POST", "/customer/kyc", "Starting the identity check", {});
      return { url: readKycUrl(data) };
    },

    async getRequirements(query) {
      const what = "Loading the provider's requirements";
      const path = `/requirements?${new URLSearchParams({
        provider: query.provider,
        paymentMethodType: query.paymentMethodType,
        country: query.country,
        fiat: query.fiat,
        sourceAmount: query.sourceAmount,
        destinationCurrencyCode: query.destinationCurrencyCode,
      })}`;
      const token = await customerToken().catch((err: unknown) => {
        if (err instanceof AdapterRefusal) return undefined;
        throw err;
      });
      return readRequirements(
        token === undefined
          ? await call("GET", path, what)
          : await withToken(token, "GET", path, what),
      );
    },

    async submitDetails(details) {
      await asCustomer("POST", "/customer/details", "Saving your details", details);
    },

    async startVerification(request) {
      return readVerificationStarted(
        await asCustomer("POST", "/customer/verifications", "Sending the code", request),
      );
    },

    async confirmVerification(confirmation) {
      return readVerificationResult(
        await asCustomer(
          "POST",
          "/customer/verifications/confirm",
          "Checking the code",
          confirmation,
        ),
      );
    },

    async createOrder(request) {
      return readOrder(await asCustomer("POST", "/order", "Starting the payment", request));
    },

    async getFunding(fundingRequestId) {
      const data = await call(
        "GET",
        `/funding/${encodeURIComponent(fundingRequestId)}`,
        "the payment status",
        { timeoutMs: STATUS_TIMEOUT_MS },
      );
      return readFunding(data);
    },
  };
}
