export const FUNDING_ROUTES = ["bank", "card", "crypto"] as const;

export type FundingRoute = (typeof FUNDING_ROUTES)[number];

export type FundingSelection = Readonly<{
  amount: string;
  route: FundingRoute;
}>;

export interface FundingAmountRules {
  decimals: number;
  minimum: string;
  maximum: string;
}

export type FundingAmountStatus =
  | { kind: "invalid" }
  | { kind: "below-minimum" }
  | { kind: "above-maximum" }
  | { kind: "valid"; amount: string; baseUnits: bigint };

export type FundingKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "delete";

/** Whether this build can run the route; an absent list offers every route. */
export function isFundingRouteAvailable(
  route: FundingRoute,
  available: readonly FundingRoute[] | null | undefined,
): boolean {
  return available === null || available === undefined || available.includes(route);
}

export function isFundingRoute(value: string): value is FundingRoute {
  return FUNDING_ROUTES.some((route) => route === value);
}

export function parseFundingAmount(value: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0) return null;

  const match = /^(0|[1-9]\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return null;

  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;

  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export function formatFundingAmount(baseUnits: bigint, decimals: number): string {
  if (baseUnits < 0n || !Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError("Funding amounts must be non-negative with integer precision");
  }
  if (decimals === 0) return baseUnits.toString();

  const padded = baseUnits.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

export function canonicalizeFundingAmount(value: string, decimals: number): string | null {
  const parsed = parseFundingAmount(value, decimals);
  return parsed === null ? null : formatFundingAmount(parsed, decimals);
}

export function fundingAmountStatus(value: string, rules: FundingAmountRules): FundingAmountStatus {
  const amount = parseFundingAmount(value, rules.decimals);
  const minimum = parseFundingAmount(rules.minimum, rules.decimals);
  const maximum = parseFundingAmount(rules.maximum, rules.decimals);
  if (amount === null || minimum === null || maximum === null || minimum > maximum) {
    return { kind: "invalid" };
  }
  if (amount < minimum) return { kind: "below-minimum" };
  if (amount > maximum) return { kind: "above-maximum" };
  return {
    kind: "valid",
    amount: formatFundingAmount(amount, rules.decimals),
    baseUnits: amount,
  };
}

/** Keypad ceiling on whole digits. Far above any configured maximum, so it never gates a real
 *  amount; it only keeps a runaway entry from outgrowing the row the display can shrink. */
const MAX_WHOLE_DIGITS = 9;

export type FundingAmountEntry = Readonly<{
  amount: string;
  /** The key was a digit the configured maximum turned away; the caller announces the bound. */
  hitMaximum: boolean;
}>;

export function reduceFundingAmount(
  current: string,
  key: FundingKey,
  rules: FundingAmountRules,
): FundingAmountEntry {
  const editable = /^(?:(?:0|[1-9]\d*)(?:\.\d*)?)?$/.test(current) ? current : "";
  const kept = (amount: string): FundingAmountEntry => ({ amount, hitMaximum: false });

  if (key === "delete") {
    return kept(editable.slice(0, -1));
  }
  if (key === ".") {
    if (rules.decimals === 0 || editable.includes(".")) return kept(editable);
    return kept(editable === "" ? "0." : `${editable}.`);
  }

  const [whole = "", fraction] = editable.split(".");
  if (fraction !== undefined && fraction.length >= rules.decimals) return kept(editable);

  const next =
    (editable === "" || editable === "0") && fraction === undefined ? key : `${editable}${key}`;
  // The maximum rejects like the decimal cap does, but reported, so the dead tap can be announced.
  // Only a digit can raise the amount, so delete always backs out of a breach.
  const value = parseFundingAmount(next, rules.decimals);
  const maximum = parseFundingAmount(rules.maximum, rules.decimals);
  if (value !== null && maximum !== null && value > maximum) {
    return { amount: editable, hitMaximum: true };
  }
  if (fraction === undefined && whole.length >= MAX_WHOLE_DIGITS) return kept(editable);
  return kept(next);
}

export function createFundingSelection(
  amount: string,
  route: FundingRoute | null,
  rules: FundingAmountRules,
): FundingSelection | null {
  if (route === null) return null;
  const status = fundingAmountStatus(amount, rules);
  if (status.kind !== "valid") return null;
  return Object.freeze({ amount: status.amount, route });
}
