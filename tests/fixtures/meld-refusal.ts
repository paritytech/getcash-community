import { createMeldClient } from "@getsome/meld";

export const ADAPTER_REQUEST_ID = "3f2b8c1e-9d4a-4c6b-8a1f-2e7d5b9c0a11";

/** The error the Meld client throws when the adapter answers `status` with `{ error }`. */
export async function adapterRefusal(error: unknown, status = 400): Promise<Error> {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error, request_id: ADAPTER_REQUEST_ID }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
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
