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
      : "https://adapter-production-bf4b.up.railway.app";
  // TEST ONLY: trace which adapter this build talks to, so a stale bundle or a missing host
  // network grant is told apart from a real adapter failure.
  console.log(
    "[dbg-build] pr113 build 2026-10-19-A | pageMeldAssets MODE=",
    import.meta.env.MODE,
    "baseUrl=",
    baseUrl,
  );
  return ensureMeldAssets(
    baseUrl
      ? createMeldClient({
          baseUrl,
          productId: (import.meta.env.VITE_MELD_PRODUCT_ID as string | undefined) ?? "getcash.dev",
        })
      : createFakeMeldClient(),
  )
    .then(() => console.log("[dbg] pageMeldAssets: OK, assets read from", baseUrl))
    .catch((e: unknown) => {
      console.warn("[dbg] pageMeldAssets: FAILED reading", baseUrl, "->", e);
      throw e;
    });
}
