import { createMeldClient } from "@getsome/meld";

export const ADAPTER_REQUEST_ID = "3f2b8c1e-9d4a-4c6b-8a1f-2e7d5b9c0a11";

/** The error the Meld client throws on a quote, over `fetchImpl`. */
async function quoteError(fetchImpl: typeof fetch): Promise<Error> {
  const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl });
  return client
    .getQuote({
      country: "DE",
      sourceCurrencyCode: "EUR",
      destinationCurrencyCode: "DOT",
      sourceAmount: "50.00",
      paymentMethodType: "CREDIT_DEBIT_CARD",
    })
    .then(
      () => new Error("expected a refusal"),
      (e: unknown) => e as Error,
    );
}

/** The error the Meld client throws when the adapter answers `status` with `{ error }`. */
export function adapterRefusal(error: unknown, status = 400): Promise<Error> {
  return quoteError(async () =>
    Response.json({ error, request_id: ADAPTER_REQUEST_ID }, { status }),
  );
}

/** The error the Meld client throws when the adapter never answers. */
export function adapterUnreachable(): Promise<Error> {
  return quoteError(async () => {
    throw new TypeError("Failed to fetch");
  });
}
