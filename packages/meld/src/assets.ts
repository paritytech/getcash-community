// Reads the adapter's asset table once, before the first call that names a Meld code. The page and
// the worker each hold their own copy (`@getsome/core`'s `meld-assets`); this is how either fills it.

import { installMeldAssets, meldAssetsInstalled } from "@getsome/core";
import type { MeldClientLike } from "./client";

let pending: Promise<void> | undefined;

/** Installs the adapter's asset table if none is installed yet. Concurrent callers share one read;
 *  a failed read is forgotten, so the next call asks again. */
export function ensureMeldAssets(client: Pick<MeldClientLike, "getAssets">): Promise<void> {
  if (meldAssetsInstalled()) return Promise.resolve();
  pending ??= client.getAssets().then(installMeldAssets, (error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}
