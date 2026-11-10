/**
 * THE METRICS DOORWAY: Sentry's trace metrics (the `tracemetrics` dataset),
 * for numbers a query aggregates: p50, p95, avg or sum of `value`, by
 * `metric.name`. Span attributes cannot do that (they arrive string-typed);
 * a metric's VALUE is a real number. Its attributes are text, for filtering
 * and grouping.
 *
 * Every point carries the scope's tags (product, host.kind, device.*,
 * session.id, request.key, ...): the SDK adds only the user to a metric, so they
 * are copied here. A tag nobody set is left out.
 *
 * Points are buffered by the SDK and sent as one envelope every few
 * seconds, on flush, and when the page turns hidden, through the same
 * retrying queue as events (init.ts); under pressure the queue drops metrics
 * before events. Never throws; a no-op until Sentry has started (boot.ts),
 * so a point never starts it: metrics sit below the boot, not beside it.
 *
 * ONE UNIT PER NAME: Sentry's unit-typed aggregates filter by unit, so a
 * name never changes unit. The names, by module:
 *
 *   ui.action (counter)                 actions.ts: one per user action, by `action`
 *   ui.screen_ms        millisecond     screens.ts: visible time on a screen, by `screen`
 */
import * as Sentry from "@sentry/vue";
import { APP_TAGS } from "./catalogue";
import { telemetryStarted } from "./init";
import { TAG_KEYS } from "./tags";

type MetricAttrs = Record<string, string>;
/** the only unit a name here uses; a new one is added with the name that needs it */
type MetricUnit = "millisecond";

const SCOPE_TAGS: readonly string[] = [...TAG_KEYS, ...APP_TAGS];

/** The scope's tags that are set, as text. */
function scopeTags(): MetricAttrs {
  const tags = {
    ...Sentry.getIsolationScope().getScopeData().tags,
    ...Sentry.getCurrentScope().getScopeData().tags,
  };
  const out: MetricAttrs = {};
  for (const key of SCOPE_TAGS) {
    const value = tags[key];
    if (value !== undefined && value !== null && value !== "") out[key] = String(value);
  }
  return out;
}

function emit(value: number, send: (attributes: MetricAttrs) => void, attrs: MetricAttrs): void {
  try {
    if (!Number.isFinite(value) || !telemetryStarted()) return;
    send({ ...scopeTags(), ...attrs });
  } catch {
    /* never throws */
  }
}

/** One sample of a distribution (p50/p95/avg over its points). */
export function recordDistribution(
  name: string,
  value: number,
  unit: MetricUnit,
  attrs: MetricAttrs = {},
): void {
  emit(
    value,
    (attributes) => Sentry.metrics.distribution(name, value, { unit, attributes }),
    attrs,
  );
}

/** `n` more of something. */
export function recordCount(name: string, n = 1, attrs: MetricAttrs = {}): void {
  emit(n, (attributes) => Sentry.metrics.count(name, n, { attributes }), attrs);
}
