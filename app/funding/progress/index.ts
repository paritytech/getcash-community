import { isCryptoSourceId, isMeldSourceId } from "../source-ids";
import { chainflipProgressProvider } from "./chainflip";
import { directProgressProvider } from "./direct";
import { meldProgressProvider } from "./meld";
import { createFundingProgressRegistry } from "./registry";
import type { FundingProgressProvider } from "./types";

export const fundingProgressRegistry = createFundingProgressRegistry([
  chainflipProgressProvider,
  directProgressProvider,
  meldProgressProvider,
]);

/** The progress provider for a request's source id: Meld for a fiat source, the direct deposit's
 *  for a direct Asset Hub source and for a record with none, Chainflip's for a swap source. */
export function progressProviderForSource(sourceId?: string): FundingProgressProvider {
  if (isMeldSourceId(sourceId)) return fundingProgressRegistry.require("meld");
  if (isCryptoSourceId(sourceId)) return fundingProgressRegistry.require("direct");
  return fundingProgressRegistry.require("chainflip");
}

export { chainflipProgressProvider, observeChainflipProgress } from "./chainflip";
export { DIRECT_DEPOSIT_STAGE, directProgressProvider, observeDirectProgress } from "./direct";
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
