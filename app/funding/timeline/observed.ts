import type { ObservedFact, TopUpRecord } from "../requests/model";
import type { Fact } from "./types";

export const factAt = (at: number | undefined): Fact | undefined =>
  at === undefined ? undefined : { at };

/** When the record first observed `status` or a status after it in `order`, which implies it. */
export function observedFrom<S extends ObservedFact>(
  record: TopUpRecord,
  order: readonly S[],
  status: S,
): number | undefined {
  const times = order.slice(order.indexOf(status)).flatMap((later) => {
    const at = record.observedAt?.[later];
    return at === undefined ? [] : [at];
  });
  return times.length === 0 ? undefined : Math.min(...times);
}

/** The earlier of two facts. A fact with a known time comes before one without. */
export function earlierFact(a: Fact | undefined, b: Fact | undefined): Fact | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  return (b.at ?? Infinity) < (a.at ?? Infinity) ? b : a;
}
