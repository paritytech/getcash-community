// A top-up or a sale that could not be priced, as one `quote-failed` failure. A failed quote
// comes before any request exists, so nothing on a record would ever report it: a tester who
// bounces off the amount screen leaves only this. The reason is `<rail>:<why>`, so each rail and
// cause groups as its own issue; a device that was offline says so instead of the cause, and is
// the person's own situation (catalogue.ts), as is a region no provider serves.

import { refusalOf } from "@getsome/meld";
import { reasonOf, reportFailure } from "~~/lib/telemetry";

export type QuoteRail = "card" | "bank" | "crypto" | "sale-card" | "sale-bank";

const BUILT_IN_ERRORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AggregateError",
]);

/** Why a quote threw: the adapter's own code, or its status, when it refused; the error's own
 *  name when it has one (MeldAssetsUnavailable reads as meld-assets-unavailable); else the
 *  thrown value's kind. */
export function quoteCauseOf(error: unknown): string {
  const refusal = refusalOf(error);
  if (refusal !== undefined)
    return refusal.code !== undefined ? refusal.code.toLowerCase() : `http-${refusal.status}`;
  if (error instanceof Error && !BUILT_IN_ERRORS.has(error.name))
    return error.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return reasonOf(error);
}

export function reportQuoteFailure(
  rail: QuoteRail,
  why: string,
  details: { error?: unknown; context?: Record<string, string> } = {},
): void {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  reportFailure("quote-failed", { reason: `${rail}:${offline ? "offline" : why}`, ...details });
}
