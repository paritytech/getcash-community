import { chainflipProgressProvider } from "./chainflip";
import { meldProgressProvider } from "./meld";
import { createFundingProgressRegistry } from "./registry";
import type { FundingProgressProvider } from "./types";

export const fundingProgressRegistry = createFundingProgressRegistry([
  chainflipProgressProvider,
  meldProgressProvider,
]);

/** The progress provider for a request's source id: Meld for a fiat source, the crypto rail's
 *  for everything else. */
export function progressProviderForSource(sourceId?: string): FundingProgressProvider {
  const own = sourceId?.startsWith("meld-") ? fundingProgressRegistry.get("meld") : undefined;
  return own ?? fundingProgressRegistry.require("chainflip");
}

export { chainflipProgressProvider, observeChainflipProgress } from "./chainflip";
export { MELD_PAYMENT_STAGE, meldProgressProvider, observeMeldProgress } from "./meld";
export { fundingProgress, fundingProgressFloors, CAP, DETECT, PRECAP } from "./model";
export { formatFundingProgressElapsed } from "./presentation";
export { fundingProgressEstimate, projectFundingProgress } from "./projection";
export {
  composeFundingProgressProfile,
  createFundingProgressProvider,
  createFundingProgressRegistry,
} from "./registry";
export {
  FUNDING_PROGRESS_SNAPSHOT_VERSION,
  createFundingProgressSnapshot,
  createLegacyFundingProgressSnapshot,
  parseFundingProgressSnapshot,
  resolveFundingProgressSnapshot,
} from "./snapshot";
export {
  fundingProgressSignalForPaymentState,
  fundingProgressSignalForSharedStep,
} from "./signals";
export { observeSharedCashProgress, sharedCashProgress } from "./shared";
export { advanceFundingProgressSnapshot } from "./transition";
export type * from "./types";
