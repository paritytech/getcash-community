import type { MeldClientLike, MeldStatusResult } from "./client";

/** How long a status read answers every other reader of the same id. Under the store's 3s poll,
 *  so the poll's own next tick always reads fresh. */
export const SHARED_STATUS_TTL_MS = 2_500;
/** How long every status read waits after a 429 whose `retry-after` the browser cannot read. */
export const RATE_LIMIT_COOLDOWN_MS = 10_000;
/** The longest a 429 holds status reads back, whatever its `retry-after` says: a far-off value
 *  would leave the funding screen unreachable with no way out. The adapter's window is 60s. */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** When status reads may go out again after a 429, and the 429 to refuse them with until then. */
export interface RateLimitCooldown {
  until: number;
  error: unknown;
}

/** The adapter's limit is one budget per caller, so a 429 holds back every wrapper on the page. */
const pageCooldown: RateLimitCooldown = { until: 0, error: null };

export interface SharedStatusOptions {
  ttlMs?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  /** The cooldown to share; defaults to the page's. Tests pass their own. */
  cooldown?: RateLimitCooldown;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * A client whose `getStatus` is shared by everything reading through it: one request in flight per
 * id, and a read younger than `ttlMs` answers the next caller without a request. Core's status poll,
 * the store's poll and a resume's pay-page lookup read the same id, and the adapter's rate limit is
 * one budget per caller across every route.
 *
 * After a 429 no status read goes out, through this wrapper or any other sharing its cooldown,
 * until the adapter's `retry-after` (or `cooldownMs`) passes, capped at `maxCooldownMs`; each read
 * in that window is refused with the 429 itself. Failures are never cached otherwise.
 */
export function shareStatusReads(
  client: MeldClientLike,
  opts: SharedStatusOptions = {},
): MeldClientLike {
  const ttlMs = opts.ttlMs ?? SHARED_STATUS_TTL_MS;
  const cooldownMs = opts.cooldownMs ?? RATE_LIMIT_COOLDOWN_MS;
  const maxCooldownMs = opts.maxCooldownMs ?? MAX_RATE_LIMIT_COOLDOWN_MS;
  const now = opts.now ?? Date.now;
  const inFlight = new Map<string, Promise<MeldStatusResult>>();
  const recent = new Map<string, { at: number; result: MeldStatusResult }>();
  const cool = opts.cooldown ?? pageCooldown;

  function getStatus(fundingRequestId: string): Promise<MeldStatusResult> {
    const t = now();
    if (t < cool.until) return Promise.reject(cool.error);
    const hit = recent.get(fundingRequestId);
    if (hit !== undefined && t - hit.at < ttlMs) return Promise.resolve(hit.result);
    const pending = inFlight.get(fundingRequestId);
    if (pending !== undefined) return pending;
    const read = client
      .getStatus(fundingRequestId)
      .then(
        (result) => {
          recent.set(fundingRequestId, { at: now(), result });
          return result;
        },
        (e: unknown) => {
          const refusal = e as { status?: number; retryAfterMs?: number } | null;
          if (refusal?.status === 429) {
            cool.until = now() + Math.min(refusal.retryAfterMs ?? cooldownMs, maxCooldownMs);
            cool.error = e;
          }
          throw e;
        },
      )
      .finally(() => inFlight.delete(fundingRequestId));
    inFlight.set(fundingRequestId, read);
    return read;
  }

  return {
    getQuote: (req) => client.getQuote(req),
    createSession: (req) => client.createSession(req),
    getStatus,
    cancel: (id) => client.cancel(id),
  };
}
