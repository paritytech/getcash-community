// The contract between the selector shell and whichever amount screen it mounts, so a screen
// that renames or drops a member breaks the build instead of a runtime prop warning.

import type { Component } from "vue";
import type { FundingSelectorConfig } from "./config";
import type { FundingRoute } from "./selection";

export interface AmountScreenProps {
  config: FundingSelectorConfig;
  amount: string;
  route: FundingRoute | null;
  /** Routes this build can run. Any other renders dimmed, marked "Soon", and unclickable. */
  availableRoutes?: readonly FundingRoute[];
  history: boolean;
  error?: string | null;
  loading?: boolean;
  /** Launch-load placeholder: static chrome renders inert, data-driven parts show skeletons. */
  skeleton?: boolean;
  /** The screen's title and the main action's label; each screen carries its own defaults. */
  title?: string;
  cta?: string;
  /** The purse in base units of CASH; omit to show no pill, null for the pill's skeleton. */
  available?: bigint | null;
}

export interface AmountScreenEmits {
  change: [amount: string];
  route: [route: FundingRoute];
  continue: [];
  history: [];
}

export type AmountScreenComponent = Component<AmountScreenProps>;
