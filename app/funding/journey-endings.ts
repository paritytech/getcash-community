// How a top-up's ending is named on the journey.

import type { FailureKind } from "@getsome/core";
import { DEPOSIT_EXPIRED_REASON } from "./requests/model";

/** Whether the top-up ended because nothing arrived in time. An expired top-up was never paid, so
 *  it keeps no quote rows. */
export function isExpiredEnding(
  kind: FailureKind | undefined,
  fundingError: string | null,
): boolean {
  return kind === "expired" || kind === "stale" || fundingError === DEPOSIT_EXPIRED_REASON;
}
