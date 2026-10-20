import { DEFAULT_DEPOSIT_WINDOW_MS } from "./requests/model";
import {
  formatFundingAmount,
  parseFundingAmount,
  type FundingAmountRules,
  type FundingRoute,
} from "./selection";

const symbol = "$";
const ticker = "CASH";

/** The currency as every sum and every prose mention writes it: the symbol on the figure, the
 *  ticker after it as a logo, the word a sentence uses instead ("Adding $50 Cash"), and the token's
 *  name where prose names it rather than counts it ("Converting to $CASH"). The one place any of
 *  them changes with the branding. */
export const currencyConfig = {
  symbol,
  ticker,
  word: "Cash",
  name: `${symbol}${ticker}`,
} as const;

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
  amount: FundingAmountRules & {
    initial: string;
    presets: readonly string[];
  };
  routes: readonly FundingRouteOption[];
  /** The route picked for a buyer who has not chosen one. Ignored when the build cannot run it,
   *  which leaves the pills unpicked as before. */
  defaultRoute: FundingRoute;
}

// 0.01 CASH is the smallest unit the purse can hold.
const DECIMALS = 2;
/** One CASH in keypad units. */
const ONE_CASH = 10n ** BigInt(DECIMALS);
/** The suggested amounts: 10, 50 and 100 CASH. */
const PRESETS = [10n, 50n, 100n].map((cash) => cash * ONE_CASH);

/** The least a top up can be, whatever the build asks below it: 1 CASH. A source's own minimum,
 *  where it has one, is judged when the source is picked, since it moves with the asset. */
const TOP_UP_FLOOR = ONE_CASH;

/** The most a top up can be unless the build says otherwise. The Add funds frame answers
 *  $1,000,000 with "Maximum 5,000 $CASH". */
const DEFAULT_MAXIMUM = 5_000n * ONE_CASH;

/** A CASH amount the build's environment names, in keypad units. Null when it is unset, and when
 *  it is zero, negative or not an amount, which is warned about. */
function amountFromEnv(name: string, raw: string | undefined): bigint | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  const parsed = parseFundingAmount(value, DECIMALS);
  if (parsed === null || parsed <= 0n) {
    console.warn(`[config] ${name} is "${value}", not a positive CASH amount; ignored`);
    return null;
  }
  return parsed;
}

/** The floor, or VITE_TOP_UP_MINIMUM where it is higher; one under the floor is warned about. */
const topUpMinimum: bigint = (() => {
  const asked = amountFromEnv(
    "VITE_TOP_UP_MINIMUM",
    import.meta.env.VITE_TOP_UP_MINIMUM as string | undefined,
  );
  if (asked === null) return TOP_UP_FLOOR;
  if (asked < TOP_UP_FLOOR) {
    console.warn(
      `[config] VITE_TOP_UP_MINIMUM is under the ${formatFundingAmount(TOP_UP_FLOOR, DECIMALS)} CASH floor; ignored`,
    );
    return TOP_UP_FLOOR;
  }
  return asked;
})();

/** VITE_TOP_UP_MAXIMUM, or the default where it names none. The maximum never sits under the
 *  minimum, which would turn every amount away: one that does is warned about and ignored, and the
 *  default itself rises to a minimum set above it. */
const topUpMaximum: bigint = (() => {
  const fallback = topUpMinimum > DEFAULT_MAXIMUM ? topUpMinimum : DEFAULT_MAXIMUM;
  const asked = amountFromEnv(
    "VITE_TOP_UP_MAXIMUM",
    import.meta.env.VITE_TOP_UP_MAXIMUM as string | undefined,
  );
  if (asked === null) return fallback;
  if (asked < topUpMinimum) {
    console.warn(
      `[config] VITE_TOP_UP_MAXIMUM is under the ${formatFundingAmount(topUpMinimum, DECIMALS)} CASH minimum; ignored`,
    );
    return fallback;
  }
  return asked;
})();

/** The presets inside the bounds, since one outside would be a dead tap: the configured three
 *  where they all fit; otherwise the minimum, then 5 and 10 times it; and where that passes the
 *  maximum, the minimum, the midpoint and the maximum. Bounds too tight for three distinct
 *  amounts leave fewer. */
function presetsWithin(minimum: bigint, maximum: bigint): readonly bigint[] {
  const fits = (units: bigint) => units >= minimum && units <= maximum;
  if (PRESETS.every(fits)) return PRESETS;
  const ladder = [minimum, minimum * 5n, minimum * 10n];
  if (ladder.every(fits)) return ladder;
  return [...new Set([minimum, (minimum + maximum) / 2n, maximum])];
}

const asAmounts = (units: readonly bigint[]): readonly string[] =>
  units.map((amount) => formatFundingAmount(amount, DECIMALS));

export const fundingSelectorConfig = {
  provider: "getcash.dot",
  amount: {
    decimals: DECIMALS,
    initial: "",
    minimum: formatFundingAmount(topUpMinimum, DECIMALS),
    maximum: formatFundingAmount(topUpMaximum, DECIMALS),
    presets: asAmounts(presetsWithin(topUpMinimum, topUpMaximum)),
  },
  defaultRoute: "crypto",
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

export const withdrawalSelectorConfig = {
  ...fundingSelectorConfig,
  amount: {
    ...fundingSelectorConfig.amount,
    minimum: "10",
    maximum: "2000",
    presets: asAmounts(PRESETS),
  },
} as const satisfies FundingSelectorConfig;

/** The route's deposit window, or the shared default for a route the config does not list. */
export function depositWindowFor(route: FundingRoute): number {
  return (
    fundingSelectorConfig.routes.find((option) => option.id === route)?.depositWindowMs ??
    DEFAULT_DEPOSIT_WINDOW_MS
  );
}
