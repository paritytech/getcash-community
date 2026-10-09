// Customer token handling, request shapes and response checks of `createMeldHeadlessClient`.

import { describe, expect, it } from "vitest";
import { AdapterRefusal } from "../client";
import { createMeldHeadlessClient, type MeldCustomerSigner } from "./client";

type Scripted = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fetch stub answering a scripted sequence, one response per call, the last repeating. A
 *  response without a body is sent empty, as a 204 is. */
function stubSequence(responses: readonly Scripted[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(next?.body === undefined ? null : JSON.stringify(next.body), {
      status: next?.status ?? 200,
      headers: { "content-type": "application/json", ...next?.headers },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const header = (call: { init: RequestInit | undefined } | undefined, name: string) =>
  new Headers(call?.init?.headers).get(name);
const bodyOf = (call: { init: RequestInit | undefined } | undefined): unknown =>
  JSON.parse(String(call?.init?.body));

/** 56 bytes whose base64url differs from base64, so a decoder that skips the alphabet swap fails. */
const CHALLENGE_BYTES = Uint8Array.from({ length: 56 }, (_, i) => (251 + i * 37) % 256);
const CHALLENGE = Buffer.from(CHALLENGE_BYTES).toString("base64url");
const SIGNATURE = new Uint8Array(64).fill(0xab);
const NOW = 1_800_000_000_000;

function fakeSigner() {
  const signed: Uint8Array[] = [];
  const signer: MeldCustomerSigner = {
    publicKeyHex: `0x${"11".repeat(32)}`,
    signRaw: (message) => {
      signed.push(message);
      return SIGNATURE;
    },
  };
  return { signer, signed };
}

const challenge: Scripted = { status: 200, body: { challenge: CHALLENGE } };
const issued = (token: string, expiresAtMs = NOW + 600_000): Scripted => ({
  status: 200,
  body: { token, expiresAtMs },
});
const refusal = (status: number, code: string, extra: Record<string, unknown> = {}): Scripted => ({
  status,
  body: {
    error: { tag: "Other", value: { code, message: "Refused.", ...extra } },
    request_id: "r",
  },
});
const tokenInvalid = refusal(401, "CUSTOMER_TOKEN_INVALID");

const approved = { kyc: "approved", providers: [{ provider: "BANXA", kyc: "approved" }] };
const noCustomer: Scripted = { status: 200, body: { customer: null } };

function clientFor(responses: readonly Scripted[], now: () => number = () => NOW) {
  const stub = stubSequence(responses);
  const { signer, signed } = fakeSigner();
  const client = createMeldHeadlessClient({
    baseUrl: "https://adapter.test/",
    productId: "getcash-dev",
    fetchImpl: stub.impl,
    signer,
    now,
  });
  return { client, calls: stub.calls, signed };
}

const BANK = {
  rail: "SEPA",
  amount: "101.20",
  currency: "EUR",
  accountHolderName: "Banxa Holdings",
  iban: "DE89370400440532013000",
  bic: "COBADEFFXXX",
  reference: "MELD-123",
  expiresAt: NOW + 3_600_000,
};

const ORDER_REQ = {
  idempotencyKey: "order-1",
  country: "DE",
  fiat: "EUR",
  destinationCurrencyCode: "DOT_ASSETHUB",
  sourceAmount: "101.20",
  walletAddress: "13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9",
  paymentMethodType: "CREDIT_DEBIT_CARD",
  serviceProvider: "BANXA",
  destinationNetworkCode: "ASSETHUB",
  termsAcceptedAt: "2026-10-08T10:00:00Z",
};

const REQUIREMENTS_QUERY = {
  provider: "BANXA",
  paymentMethodType: "CREDIT_DEBIT_CARD",
  country: "DE",
  fiat: "EUR",
  sourceAmount: "101.20",
  destinationCurrencyCode: "DOT_ASSETHUB",
};

describe("createMeldHeadlessClient customer token", () => {
  it("signs the decoded challenge bytes and sends the token on the customer route", async () => {
    const { client, calls, signed } = clientFor([challenge, issued("t1"), noCustomer]);

    expect(await client.getCustomer()).toBeNull();

    expect(calls.map((c) => [c.init?.method, c.url])).toEqual([
      ["POST", "https://adapter.test/customer/challenge"],
      ["POST", "https://adapter.test/customer/token"],
      ["GET", "https://adapter.test/customer"],
    ]);
    expect(signed).toEqual([CHALLENGE_BYTES]);
    expect(bodyOf(calls[1])).toEqual({
      publicKey: `0x${"11".repeat(32)}`,
      challenge: CHALLENGE,
      signature: `0x${"ab".repeat(64)}`,
    });
    expect(header(calls[2], "x-customer-token")).toBe("t1");
    for (const call of calls) expect(header(call, "x-dev-product-id")).toBe("getcash-dev");
    // The token routes prove the key; they do not carry a token of their own.
    expect(header(calls[0], "x-customer-token")).toBeNull();
    expect(header(calls[1], "x-customer-token")).toBeNull();
  });

  it("reuses the token until 30 s before it expires", async () => {
    let now = NOW;
    const { client, calls } = clientFor(
      [
        challenge,
        issued("t1", NOW + 60_000),
        noCustomer,
        noCustomer,
        challenge,
        issued("t2"),
        noCustomer,
      ],
      () => now,
    );

    await client.getCustomer();
    now = NOW + 29_999;
    await client.getCustomer();
    expect(calls).toHaveLength(4);
    expect(header(calls[3], "x-customer-token")).toBe("t1");

    now = NOW + 30_000;
    await client.getCustomer();
    expect(calls).toHaveLength(7);
    expect(calls[4]?.url).toBe("https://adapter.test/customer/challenge");
    expect(header(calls[6], "x-customer-token")).toBe("t2");
  });

  it("issues one token for concurrent callers", async () => {
    const { client, calls } = clientFor([challenge, issued("t1"), noCustomer]);

    await Promise.all([client.getCustomer(), client.getCustomer()]);

    expect(calls.filter((c) => c.url.endsWith("/customer/challenge"))).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it("replaces a token the adapter no longer accepts and retries once", async () => {
    const { client, calls } = clientFor([
      challenge,
      issued("stale"),
      tokenInvalid,
      challenge,
      issued("fresh"),
      { status: 200, body: { customer: approved } },
    ]);

    expect(await client.getCustomer()).toEqual(approved);
    expect(calls).toHaveLength(6);
    expect(header(calls[5], "x-customer-token")).toBe("fresh");
  });

  it("gives up when the replacement token is refused too", async () => {
    const { client, calls } = clientFor([
      challenge,
      issued("t1"),
      tokenInvalid,
      challenge,
      issued("t2"),
      tokenInvalid,
      noCustomer,
    ]);

    await expect(client.getCustomer()).rejects.toMatchObject({
      status: 401,
      code: "CUSTOMER_TOKEN_INVALID",
    });
    expect(calls).toHaveLength(6);
  });

  it("does not retry any other 401", async () => {
    const { client, calls } = clientFor([challenge, issued("t1"), refusal(401, "UNAUTHORIZED")]);

    await expect(client.getCustomer()).rejects.toBeInstanceOf(AdapterRefusal);
    expect(calls).toHaveLength(3);
  });

  it("stops when the adapter refuses the proof", async () => {
    const { client, calls } = clientFor([challenge, refusal(401, "CUSTOMER_PROOF_INVALID")]);

    await expect(client.getCustomer()).rejects.toMatchObject({ code: "CUSTOMER_PROOF_INVALID" });
    expect(calls).toHaveLength(2);
  });

  it("refuses a token without an expiry", async () => {
    const { client } = clientFor([challenge, { status: 200, body: { token: "t1" } }]);

    await expect(client.getCustomer()).rejects.toThrow(/unreadable customer token expiry/);
  });
});

describe("createMeldHeadlessClient routes", () => {
  const withToken = (response: Scripted) => clientFor([challenge, issued("t1"), response]);

  it("registers a customer with the details as given", async () => {
    const details = {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      dateOfBirth: "1990-03-15",
      address: {
        lineOne: "1 Main St",
        city: "Berlin",
        region: "BE",
        postalCode: "10115",
        countryCode: "DE",
      },
    };
    const { client, calls } = withToken({ status: 201, body: { customer: approved } });

    expect(await client.createCustomer(details)).toEqual(approved);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(calls[2]?.url).toBe("https://adapter.test/customer");
    expect(header(calls[2], "content-type")).toBe("application/json");
    expect(bodyOf(calls[2])).toEqual(details);
  });

  it("keeps a provider's questionnaire URL", async () => {
    const pending = {
      kyc: "approved",
      providers: [{ provider: "BANXA", kyc: "pending", actionUrl: "https://banxa.test/q" }],
    };
    const { client } = withToken({ status: 200, body: { customer: pending } });

    expect(await client.getCustomer()).toEqual(pending);
  });

  it("starts the identity check", async () => {
    const { client, calls } = withToken({ status: 200, body: { url: "https://sumsub.test/x" } });

    expect(await client.startKyc()).toEqual({ url: "https://sumsub.test/x" });
    expect(calls[2]?.init?.method).toBe("POST");
    expect(calls[2]?.url).toBe("https://adapter.test/customer/kyc");
  });

  it("asks for requirements with the order's terms and the customer token", async () => {
    const view = {
      agreements: [{ type: "TERMS_OF_USE", url: "https://banxa.test/terms" }],
      verifications: [{ channel: "PHONE", reason: "MISSING" }],
      missingFields: ["occupation"],
      pending: false,
      blocked: false,
      ready: false,
    };
    const { client, calls } = withToken({ status: 200, body: view });

    expect(await client.getRequirements(REQUIREMENTS_QUERY)).toEqual(view);
    const url = new URL(String(calls[2]?.url));
    expect(url.pathname).toBe("/requirements");
    expect(Object.fromEntries(url.searchParams)).toEqual(REQUIREMENTS_QUERY);
    expect(calls[2]?.init?.method).toBe("GET");
    expect(calls[2]?.init?.body).toBeUndefined();
    expect(header(calls[2], "x-customer-token")).toBe("t1");
  });

  it("asks for requirements without a token when none can be issued", async () => {
    const agreementsOnly = {
      agreements: [{ type: "TERMS_OF_USE", url: "https://banxa.test/terms" }],
      verifications: [],
      missingFields: [],
      pending: false,
      blocked: false,
      ready: false,
    };
    const { client, calls } = clientFor([
      challenge,
      refusal(401, "CUSTOMER_PROOF_INVALID"),
      { status: 200, body: agreementsOnly },
    ]);

    expect(await client.getRequirements(REQUIREMENTS_QUERY)).toEqual(agreementsOnly);
    expect(header(calls[2], "x-customer-token")).toBeNull();
  });

  it("sends a provider's extra fields and accepts an empty 204", async () => {
    const details = { provider: "BANXA", fields: { occupation: "Engineer" } };
    const { client, calls } = withToken({ status: 204 });

    await expect(client.submitDetails(details)).resolves.toBeUndefined();
    expect(calls[2]?.url).toBe("https://adapter.test/customer/details");
    expect(bodyOf(calls[2])).toEqual(details);
  });

  it("starts and confirms a contact verification", async () => {
    const started = {
      verificationId: "v1",
      expiresAt: "2026-08-25T02:57:26Z",
      resendAvailableAt: "2026-08-25T02:47:56Z",
    };
    const { client, calls } = clientFor([
      challenge,
      issued("t1"),
      { status: 200, body: started },
      { status: 200, body: { status: "FAILED", attemptsRemaining: 2 } },
    ]);

    expect(await client.startVerification({ channel: "EMAIL", target: "ada@example.com" })).toEqual(
      started,
    );
    expect(await client.confirmVerification({ verificationId: "v1", code: "316856" })).toEqual({
      status: "FAILED",
      attemptsRemaining: 2,
    });
    expect(calls[2]?.url).toBe("https://adapter.test/customer/verifications");
    expect(bodyOf(calls[2])).toEqual({ channel: "EMAIL", target: "ada@example.com" });
    expect(calls[3]?.url).toBe("https://adapter.test/customer/verifications/confirm");
    expect(bodyOf(calls[3])).toEqual({ verificationId: "v1", code: "316856" });
  });

  it("carries the resend time of a verification cooldown", async () => {
    const { client } = withToken({
      ...refusal(429, "VERIFICATION_COOLDOWN", { resendAvailableAt: "2026-08-25T02:47:56Z" }),
      headers: { "retry-after": "30" },
    });

    await expect(
      client.startVerification({ channel: "PHONE", target: "+14155550123" }),
    ).rejects.toMatchObject({
      status: 429,
      code: "VERIFICATION_COOLDOWN",
      retryAfterMs: 30_000,
      resendAvailableAt: "2026-08-25T02:47:56Z",
    });
  });

  it("opens a card order and hands back Meld's order verbatim", async () => {
    const order = { id: "meld-order-1", paymentDetails: { nested: [1, 2] } };
    const { client, calls } = withToken({
      status: 201,
      body: { fundingRequestId: "funding-1", kind: "card", order },
    });

    expect(await client.createOrder(ORDER_REQ)).toEqual({
      fundingRequestId: "funding-1",
      kind: "card",
      order,
    });
    expect(calls[2]?.init?.method).toBe("POST");
    expect(calls[2]?.url).toBe("https://adapter.test/order");
    expect(bodyOf(calls[2])).toEqual(ORDER_REQ);
    expect(header(calls[2], "x-customer-token")).toBe("t1");
  });

  it("opens a bank order with its transfer instructions", async () => {
    const { client } = withToken({
      status: 201,
      body: { fundingRequestId: "funding-2", kind: "bank", instructions: BANK },
    });

    expect(await client.createOrder({ ...ORDER_REQ, paymentMethodType: "SEPA" })).toEqual({
      fundingRequestId: "funding-2",
      kind: "bank",
      instructions: BANK,
    });
  });

  it("maps an order refusal to its code", async () => {
    const { client } = withToken(refusal(403, "CUSTOMER_NOT_READY"));

    const err = await client.createOrder(ORDER_REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterRefusal);
    expect(err).toMatchObject({ status: 403, code: "CUSTOMER_NOT_READY" });
    expect((err as Error).message).toContain("CUSTOMER_NOT_READY");
  });

  it("reads the funding request with its mode and live instructions, without a token", async () => {
    const { client, calls } = clientFor([
      {
        status: 200,
        body: {
          funding: {
            status: "session_opened",
            integrationMode: "headless",
            fiat: "EUR",
            sourceAmount: "101.20",
            paymentInstructions: BANK,
          },
        },
      },
    ]);

    const funding = await client.getFunding("funding 2");

    expect(funding).toEqual({
      status: "session_opened",
      integrationMode: "headless",
      fiat: "EUR",
      sourceAmount: "101.20",
      paymentInstructions: BANK,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://adapter.test/funding/funding%202");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(header(calls[0], "x-customer-token")).toBeNull();
  });
});

describe("createMeldHeadlessClient response checks", () => {
  const read = (
    body: unknown,
    run: (c: ReturnType<typeof createMeldHeadlessClient>) => Promise<unknown>,
  ) => run(clientFor([challenge, issued("t1"), { status: 200, body }]).client);

  it.each([
    ["an unknown KYC state", { customer: { kyc: "maybe", providers: [] } }, /KYC state/],
    ["a missing customer", {}, /unreadable customer/],
    ["providers that are not a list", { customer: { kyc: "none", providers: {} } }, /providers/],
  ])("refuses a customer with %s", async (_, body, message) => {
    await expect(read(body, (c) => c.getCustomer())).rejects.toThrow(message);
  });

  it("refuses requirements missing a flag", async () => {
    const body = { agreements: [], verifications: [], missingFields: [], pending: false };
    await expect(read(body, (c) => c.getRequirements(REQUIREMENTS_QUERY))).rejects.toThrow(
      /blocked flag/,
    );
  });

  it("refuses an unknown verification status", async () => {
    await expect(
      read({ status: "PENDING" }, (c) => c.confirmVerification({ verificationId: "v", code: "1" })),
    ).rejects.toThrow(/verification status/);
  });

  it.each([
    ["an unknown kind", { fundingRequestId: "f", kind: "wire" }, /order kind/],
    ["no funding request id", { kind: "card", order: {} }, /funding request id/],
    ["a card order that is not an object", { fundingRequestId: "f", kind: "card" }, /card order/],
    [
      "bank instructions with no account",
      {
        fundingRequestId: "f",
        kind: "bank",
        instructions: { rail: "SEPA", amount: "1", currency: "EUR" },
      },
      /without an account/,
    ],
    [
      "bank instructions with a non-text field",
      { fundingRequestId: "f", kind: "bank", instructions: { ...BANK, reference: 42 } },
      /bank reference/,
    ],
  ])("refuses an order with %s", async (_, body, message) => {
    await expect(read(body, (c) => c.createOrder(ORDER_REQ))).rejects.toThrow(message);
  });

  it("refuses a funding request with an unknown mode", async () => {
    const { client } = clientFor([
      { status: 200, body: { funding: { status: "created", integrationMode: "iframe" } } },
    ]);
    await expect(client.getFunding("f")).rejects.toThrow(/integration mode/);
  });
});
