// The key the Meld adapter knows this user's customer by. Hosted, its seed comes from the host's
// entropy root under a label of its own, so the same user is the same customer after a reload.

import { deriveEntropy } from "@parity/product-sdk-host";
import { deriveCustomerKey } from "@getsome/ephemeral";
import { createHostEntropyPort } from "@getsome/host";
import type { MeldCustomerSigner } from "@getsome/meld";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { hostSafeEntropy } from "./coinage";
import { isHosted } from "./host-account";

/** Identity 1's entropy label. Not a burner label, so the customer key never equals a trade key. */
export const CUSTOMER_ENTROPY_LABEL = "onramp:meld:customer:1";

/** Where the off-host seed is kept, as 64 lowercase hex characters. */
export const DEV_CUSTOMER_SEED_KEY = "getsome:meld:customer:dev";

let signer: Promise<MeldCustomerSigner> | null = null;

/** This user's customer signer, derived once per page. A failed derivation is tried again on the
 *  next call. */
export function customerSigner(): Promise<MeldCustomerSigner> {
  signer ??= deriveSigner().catch((err: unknown) => {
    signer = null;
    throw err;
  });
  return signer;
}

async function deriveSigner(): Promise<MeldCustomerSigner> {
  return deriveCustomerKey(isHosted() ? await hostSeed() : devSeed());
}

function hostSeed(): Promise<Uint8Array> {
  return createHostEntropyPort(hostSafeEntropy(deriveEntropy)).deriveSeed(
    new TextEncoder().encode(CUSTOMER_ENTROPY_LABEL),
  );
}

// Development only: off-host there is no entropy root, so a seed kept in this browser stands in.
function devSeed(): Uint8Array {
  try {
    const stored = localStorage.getItem(DEV_CUSTOMER_SEED_KEY);
    if (stored !== null && /^[0-9a-f]{64}$/.test(stored)) return hexToBytes(stored);
  } catch {
    // Storage that throws on access holds nothing; a fresh seed serves this page.
  }
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  try {
    localStorage.setItem(DEV_CUSTOMER_SEED_KEY, bytesToHex(seed));
  } catch {
    // Not kept: the next page load registers as a new customer.
  }
  return seed;
}
