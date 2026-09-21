// The providers this worker can hand a withdrawal to, and the hand that pays them. None yet:
// the pickers keep every provider route greyed until a client lands here, and a job that reaches
// the rail leg without one fails plainly rather than waiting on nothing.

/**
 * The provider client for a job, bound to that job, or null when this build has none. A client
 * has two calls: `open()`, the channel and the Asset Hub account the key pays, and `status(id)`,
 * the provider's word on the swap.
 */
export function railFor(_provider, _record) {
  return null;
}

/** Moves everything the key holds on Asset Hub to the channel. */
export async function payRail(_record, _handoff) {
  throw new Error("paying a provider is not in this build");
}
