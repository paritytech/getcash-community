// The contract between the selector shell and whichever amount screen it mounts. The top-up and
// withdrawal screens both declare their props and emits from here, and the shell types its
// amountScreen prop against it, so a screen that renames or drops a member breaks the build
// instead of failing as a runtime prop warning.

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
  /** Launch-load placeholder: static chrome (amount, keypad) renders inert while the data-driven
   *  parts (title, route pills, the notice line, CTA label) show skeleton shapes. */
  skeleton?: boolean;
  /** The screen's title and the main action's label; each screen carries its own defaults. */
  title?: string;
  cta?: string;
  /** The balance the amount may be drawn from, in base units of CASH. Shown as a pill that fills
   *  the amount when tapped. Omit to show no pill; null shows the pill's skeleton while the
   *  balance loads. */
  available?: bigint | null;
}

export interface AmountScreenEmits {
  change: [amount: string];
  route: [route: FundingRoute];
  continue: [];
  history: [];
}

export type AmountScreenComponent = Component<AmountScreenProps>;
