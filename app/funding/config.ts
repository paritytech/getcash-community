import type { FundingAmountRules, FundingRoute } from "./selection";

export interface FundingRouteOption {
  id: FundingRoute;
  label: string;
  description: string;
  estimate: string;
  icon: string;
}

export interface FundingSelectorTheme {
  background: string;
  surface: string;
  control: string;
  text: string;
  textMuted: string;
  action: string;
  actionText: string;
  border: string;
  success: string;
  error: string;
}

export interface FundingSelectorConfig {
  provider: string;
  asset: string;
  amount: FundingAmountRules & {
    initial: string;
    presets: readonly string[];
  };
  routes: readonly FundingRouteOption[];
  theme: FundingSelectorTheme;
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
  theme: {
    background: "#080808",
    surface: "#1a1b20",
    control: "#1f1f1f",
    text: "#ececec",
    textMuted: "#999999",
    action: "#e0e0e0",
    actionText: "#080808",
    border: "#525252",
    success: "#22c55e",
    error: "#ff3123",
  },
} as const satisfies FundingSelectorConfig;
