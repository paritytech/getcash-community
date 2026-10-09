// The headless Meld client this build talks to: the adapter VITE_MELD_BASE_URL names, signed for
// with this user's customer key, or the offline fake when it names none.

import {
  createFakeMeldHeadlessClient,
  createMeldHeadlessClient,
  type MeldHeadlessClient,
} from "@getsome/meld";
import { customerSigner } from "./meld-customer";

/** Made on first use: the customer key is derived asynchronously, and one client keeps one
 *  customer token for the page. */
function onFirstUse(make: () => Promise<MeldHeadlessClient>): MeldHeadlessClient {
  let made: Promise<MeldHeadlessClient> | null = null;
  const client = () =>
    (made ??= make().catch((err: unknown) => {
      made = null;
      throw err;
    }));
  return {
    getCustomer: async () => (await client()).getCustomer(),
    createCustomer: async (details) => (await client()).createCustomer(details),
    startKyc: async () => (await client()).startKyc(),
    getRequirements: async (query) => (await client()).getRequirements(query),
    submitDetails: async (details) => (await client()).submitDetails(details),
    startVerification: async (request) => (await client()).startVerification(request),
    confirmVerification: async (confirmation) => (await client()).confirmVerification(confirmation),
    createOrder: async (request) => (await client()).createOrder(request),
    getFunding: async (fundingRequestId) => (await client()).getFunding(fundingRequestId),
  };
}

let defaultClient: MeldHeadlessClient | undefined;

function defaultMeldHeadlessClientFactory(): MeldHeadlessClient {
  if (defaultClient === undefined) {
    const baseUrl = import.meta.env.VITE_MELD_BASE_URL as string | undefined;
    const productId = (import.meta.env.VITE_MELD_PRODUCT_ID as string | undefined) ?? "getcash.dev";
    defaultClient = baseUrl
      ? onFirstUse(async () =>
          createMeldHeadlessClient({ baseUrl, productId, signer: await customerSigner() }),
        )
      : createFakeMeldHeadlessClient();
  }
  return defaultClient;
}

let meldHeadlessClientFactory: () => MeldHeadlessClient = defaultMeldHeadlessClientFactory;

/** Makes `meldHeadlessClient` return what `factory` returns; tests inject a fake. Null restores
 *  the build's own client. */
export function setMeldHeadlessClientFactory(factory: (() => MeldHeadlessClient) | null): void {
  meldHeadlessClientFactory = factory ?? defaultMeldHeadlessClientFactory;
}

export function meldHeadlessClient(): MeldHeadlessClient {
  return meldHeadlessClientFactory();
}
