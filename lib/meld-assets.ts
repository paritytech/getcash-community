// The page's copy of the adapter's asset table: what Meld currently calls each asset this app buys
// or sells. Read once per page, before the first call that names a Meld code, from the adapter this
// build names; a build that names none quotes against the offline stand-in, which names each asset
// by its own id. See `@getsome/core`'s `meld-assets`.

import { createFakeMeldClient, createMeldClient, ensureMeldAssets } from "@getsome/meld";

/** Installs the page's asset table if none is yet. Rejects when the adapter cannot be read; the
 *  next call asks again. */
export function pageMeldAssets(): Promise<void> {
  const baseUrl =
    import.meta.env.MODE === "test"
      ? (import.meta.env.VITE_MELD_BASE_URL as string | undefined)
      : "https://florist-find-purpose-adrian.trycloudflare.com";
  return ensureMeldAssets(
    baseUrl
      ? createMeldClient({
          baseUrl,
          productId:
            import.meta.env.MODE === "test"
              ? ((import.meta.env.VITE_MELD_PRODUCT_ID as string | undefined) ?? "getcash.dev")
              : "getcash.dev",
        })
      : createFakeMeldClient(),
  );
}
