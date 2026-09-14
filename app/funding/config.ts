import { DEFAULT_DEPOSIT_WINDOW_MS } from "./requests/model";
import type { FundingAmountRules, FundingRoute } from "./selection";

export interface FundingRouteOption {
  id: FundingRoute;
  label: string;
  description: string;
  estimate: string;
  icon: string;
  /** How long the buyer has to pay when the rail sets no deadline of its own. */
  depositWindowMs: number;
}

export interface FundingSelectorConfig {
  provider: string;
  asset: string;
  amount: FundingAmountRules & {
    initial: string;
    presets: readonly string[];
  };
  routes: readonly FundingRouteOption[];
}

export const fundingSelectorConfig = {
  provider: "getcash.dot",
  asset: "$CASH",
  amount: {
    // 0.01 CASH is the smallest unit the purse can hold.
    decimals: 2,
    initial: "",
    minimum: "10",
    maximum: "2000",
    presets: ["50", "100", "200"],
  },
  routes: [
    {
      id: "crypto",
      label: "Crypto",
      description: "Send from another wallet",
      estimate: "~3 min",
      icon: "/icons/crypto.svg",
      depositWindowMs: 86_400_000,
    },
    {
      id: "card",
      label: "Card",
      description: "Arrive in minutes",
      estimate: "Instant",
      icon: "/icons/card.svg",
      depositWindowMs: 86_400_000,
    },
    {
      id: "bank",
      label: "Bank",
      description: "1-2 business days",
      estimate: "1-2 days",
      icon: "/icons/bank.svg",
      depositWindowMs: 86_400_000,
    },
  ],
} as const satisfies FundingSelectorConfig;

/** The route's deposit window, or the shared default for a route the config does not list. */
export function depositWindowFor(route: FundingRoute): number {
  return (
    fundingSelectorConfig.routes.find((option) => option.id === route)?.depositWindowMs ??
    DEFAULT_DEPOSIT_WINDOW_MS
  );
}
