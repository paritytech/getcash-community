import { createMeldClient } from "@getsome/meld";

/** The error the Meld client throws when the adapter answers `status` with `{ error }`. */
export async function adapterRefusal(error: unknown, status = 400): Promise<Error> {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error }), {
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
