// The host entropy labels a withdrawal's keys derive from, built the same way by the page and the worker.

/** The prefix of a withdrawal key's entropy label. */
export const WITHDRAW_LABEL_PREFIX = "wd:eph:";

// The prefix of the claimer key's entropy label beside a withdrawal's
const CLAIM_LABEL_PREFIX = "wd:clm:";

/** The claimer label beside a withdrawal label, at most 32 bytes so page and worker derive one key. */
export function claimEntropyLabel(label: string): string {
  if (!label.startsWith(WITHDRAW_LABEL_PREFIX) || label.length === WITHDRAW_LABEL_PREFIX.length) {
    throw new Error(`'${label}' is not a withdrawal label`);
  }
  const claim = `${CLAIM_LABEL_PREFIX}${label.slice(WITHDRAW_LABEL_PREFIX.length)}`;
  if (new TextEncoder().encode(claim).length > 32) {
    throw new Error(`'${claim}' is longer than the host's 32-byte key`);
  }
  return claim;
}
