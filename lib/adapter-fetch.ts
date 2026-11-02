// The fetch every adapter call goes through. `VITE_ADAPTER_AUTH` sets how it proves the caller:
// `dev` (default) for an adapter in `insecure_dev` mode, `personhood` for one in `personhood` mode.

import { proveLitePersonhood } from "@getsome/host";
import { devAdapterFetch, personhoodAdapterFetch } from "@getsome/meld";
import { createAccountsProvider } from "@novasamatech/host-api-wrapper";

/** Must be in the adapter's `allowed_products`; in `personhood` mode, the Host's id for getcash. */
export const PRODUCT_ID =
  (import.meta.env.VITE_MELD_PRODUCT_ID as string | undefined) ?? "getcash.dev";

let built: typeof fetch | undefined;

export function adapterFetch(): typeof fetch {
  built ??= build();
  return built;
}

function build(): typeof fetch {
  const mode = (import.meta.env.VITE_ADAPTER_AUTH as string | undefined) ?? "dev";
  if (mode === "dev") return devAdapterFetch(PRODUCT_ID);
  const baseUrl = import.meta.env.VITE_MELD_BASE_URL as string | undefined;
  if (mode !== "personhood" || !baseUrl) {
    throw new Error(
      `VITE_ADAPTER_AUTH=${mode} needs "dev", or "personhood" with VITE_MELD_BASE_URL`,
    );
  }
  const accounts = createAccountsProvider();
  const ringVrf = {
    listRingVrfKeys: async (owner: string) => accounts.listRingVrfKeys(owner),
    createRingVRFProof: async (...args: Parameters<typeof accounts.createRingVRFProof>) =>
      accounts.createRingVRFProof(...args),
  };
  return personhoodAdapterFetch({
    baseUrl,
    productId: PRODUCT_ID,
    prove: (message) => proveLitePersonhood(ringVrf, PRODUCT_ID, message),
  });
}
