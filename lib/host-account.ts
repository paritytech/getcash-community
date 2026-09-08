// Host container detection. Inside a host container, chain access, storage and the claim all
// route through the host. This module does not resolve the user's account: the burner comes
// from the host's entropy root and the claim credits whoever the host has authenticated.

import { isInsideContainerSync } from "@parity/product-sdk-host";

/** True when running inside a host container. */
export function isHosted(): boolean {
  return isInsideContainerSync();
}
