// Failures that are the host's, not the purchase's. Kept apart from host-chain so the stores can
// tell one from a price failure without loading the chain stack.

/** The host container did not give a working chain connection: the probe went unanswered, the
 *  host refused the chain, or its routed connection never came live. A different amount, country
 *  or rail cannot help; only the host can. */
export class HostUnreachableError extends Error {
  override name = "HostUnreachableError";
}

/** Whether `e`, or any error in its `cause` chain, is a HostUnreachableError. */
export function isHostUnreachable(e: unknown): boolean {
  for (let cur = e, depth = 0; cur instanceof Error && depth < 8; cur = cur.cause, depth++) {
    if (cur instanceof HostUnreachableError) return true;
  }
  return false;
}
