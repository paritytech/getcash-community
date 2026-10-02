// The client a fiat sale is quoted, opened and read through on the page: the adapter this build
// names, or the offline stand-in in a demo build that names none. One per page, so the stand-in
// keeps the script of the sales it opened and the poll reads the same one.
//
// Never the stand-in outside a demo: its sale is real on the chain, the purse pays the key and the
// worker pays the provider, but the provider and its deposit address are made up.

import {
  createFakeMeldClient,
  createMeldClient,
  type MeldClientLike,
  type MeldSellClientLike,
} from "@getsome/meld";
import { isDemoBuild } from "../utils/demo";

export type MeldSellClient = MeldClientLike & MeldSellClientLike;

let override: MeldSellClient | null = null;
let built: MeldSellClient | null | undefined;

/** This build's client, or null in a build that names no adapter and is not a demo. */
export function meldSellClient(): MeldSellClient | null {
  if (override !== null) return override;
  built ??= defaultClient();
  return built;
}

function defaultClient(): MeldSellClient | null {
  const baseUrl = import.meta.env.VITE_MELD_BASE_URL as string | undefined;
  if (baseUrl) {
    return createMeldClient({
      baseUrl,
      productId: (import.meta.env.VITE_MELD_PRODUCT_ID as string | undefined) ?? "getcash.dev",
      // After KYC the provider lands the widget on the adapter's frameable return page, which
      // tells a seller they are verified rather than that a payment arrived.
      redirectUrl: `${baseUrl.replace(/\/$/, "")}/meld/return?flow=sell`,
    });
  }
  return isDemoBuild() ? createFakeMeldClient() : null;
}

/** Replaces the page's client; tests pass a scripted one, and null goes back to the default,
 *  built again on its next use. */
export function setMeldSellClient(next: MeldSellClient | null): void {
  override = next;
  built = undefined;
}
