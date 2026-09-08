import type { FundingAmountRules, FundingRoute } from "./selection";

export interface FundingRouteOption {
  id: FundingRoute;
  label: string;
  description: string;
  estimate: string;
  icon: string;
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
  asset: "CASH",
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
      id: "card",
      label: "Card",
      description: "Arrive in minutes",
      estimate: "Instant",
      icon: "/icons/card.svg",
    },
    {
      id: "bank",
      label: "Bank",
      description: "1-2 business days",
      estimate: "1-2 days",
      icon: "/icons/bank.svg",
    },
    {
      id: "crypto",
      label: "Crypto",
      description: "Send from another wallet",
      estimate: "~3 min",
      icon: "/icons/crypto.svg",
    },
  ],
} as const satisfies FundingSelectorConfig;
