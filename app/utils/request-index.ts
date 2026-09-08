// The index of open requests. An entry is keyed on the source id and the per-source trade
// number; an entry with no source id resolves to the bare storage key.

/** One open request's identity: its source id, when known, and its per-source trade number. */
export interface RequestRef {
  sourceId?: string;
  tradeN: number;
}

/** Builds a ref; a missing source id is left out. */
export const requestRefOf = (sourceId: string | undefined, tradeN: number): RequestRef =>
  sourceId ? { sourceId, tradeN } : { tradeN };

/** True when two refs name the same request. */
export const sameRequestRef = (a: RequestRef, b: RequestRef): boolean =>
  a.tradeN === b.tradeN && a.sourceId === b.sourceId;

/** Stable key for a ref: `${sourceId}#${tradeN}`, the source id empty when absent. */
export function requestRefKey(ref: RequestRef): string {
  return `${ref.sourceId ?? ""}#${ref.tradeN}`;
}

/** The inverse of `requestRefKey`; null for anything that is not one. */
export function parseRequestRefKey(key: string): RequestRef | null {
  const match = /^([^#]*)#(\d+)$/.exec(key);
  if (match === null) return null;
  const tradeN = Number(match[2]);
  if (!Number.isSafeInteger(tradeN) || tradeN < 1) return null;
  return requestRefOf(match[1] || undefined, tradeN);
}

/** Serializes refs newest first by trade number, de-duplicated by key. */
export function serializeRequestIndex(refs: readonly RequestRef[]): string {
  const seen = new Set<string>();
  const unique: RequestRef[] = [];
  for (const ref of refs) {
    const k = requestRefKey(ref);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(ref.sourceId === undefined ? { tradeN: ref.tradeN } : ref);
  }
  unique.sort((a, b) => b.tradeN - a.tradeN);
  return JSON.stringify(unique);
}

/**
 * Parses a serialized index. Unrecognizable input reads as no open requests and bad entries are
 * skipped. A bare trade number reads as a ref with no source id.
 */
export function parseRequestIndex(raw: string | null): RequestRef[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const refs: RequestRef[] = [];
  for (const entry of parsed) {
    if (Number.isInteger(entry) && (entry as number) >= 1) {
      refs.push({ tradeN: entry as number }); // a bare trade number
    } else if (
      entry !== null &&
      typeof entry === "object" &&
      Number.isInteger((entry as RequestRef).tradeN) &&
      (entry as RequestRef).tradeN >= 1
    ) {
      const e = entry as RequestRef;
      refs.push(
        typeof e.sourceId === "string"
          ? { sourceId: e.sourceId, tradeN: e.tradeN }
          : { tradeN: e.tradeN },
      );
    }
  }
  const seen = new Set<string>();
  const unique = refs.filter((ref) => {
    const k = requestRefKey(ref);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => b.tradeN - a.tradeN);
  return unique;
}
