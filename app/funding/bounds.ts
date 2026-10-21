// The top-up bounds a build names, VITE_TOP_UP_MINIMUM and VITE_TOP_UP_MAXIMUM, read the one way
// at build time, where a problem is reported in the build log, and at page load, where they are
// applied.

import { formatFundingAmount, parseFundingAmount } from "./selection";

/** 0.01 CASH is the smallest unit the purse can hold. */
export const DECIMALS = 2;

/** One CASH in keypad units. */
export const ONE_CASH = 10n ** BigInt(DECIMALS);

/** The least a top up can be, whatever the build asks below it: 1 CASH. A source's own minimum,
 *  where it has one, is judged when the source is picked, since it moves with the asset. */
const FLOOR = ONE_CASH;

/** The most a top up can be unless the build says otherwise. The Add funds frame answers
 *  $1,000,000 with "Maximum 5,000 $CASH". */
const DEFAULT_MAXIMUM = 5_000n * ONE_CASH;

export interface TopUpBounds {
  /** In keypad units. */
  minimum: bigint;
  maximum: bigint;
  /** What was ignored, one line each: a value that is zero, negative or not an amount, a minimum
   *  under the floor, or a maximum under the minimum. */
  problems: string[];
}

/** The bounds from the two values. The minimum is the floor, or the value where higher. The
 *  maximum is the value, or the default raised to a minimum set above it. A problem value is
 *  ignored in favour of those. */
export function readTopUpBounds(env: { minimum?: string; maximum?: string }): TopUpBounds {
  const problems: string[] = [];
  const amount = (name: string, raw: string | undefined): bigint | null => {
    const value = raw?.trim() ?? "";
    if (value === "") return null;
    const parsed = parseFundingAmount(value, DECIMALS);
    if (parsed === null || parsed <= 0n) {
      problems.push(`${name} is "${value}", not a positive CASH amount`);
      return null;
    }
    return parsed;
  };
  const cash = (units: bigint) => `${formatFundingAmount(units, DECIMALS)} CASH`;

  let minimum = amount("VITE_TOP_UP_MINIMUM", env.minimum) ?? FLOOR;
  if (minimum < FLOOR) {
    problems.push(`VITE_TOP_UP_MINIMUM is under the ${cash(FLOOR)} floor`);
    minimum = FLOOR;
  }
  const fallback = minimum > DEFAULT_MAXIMUM ? minimum : DEFAULT_MAXIMUM;
  let maximum = amount("VITE_TOP_UP_MAXIMUM", env.maximum) ?? fallback;
  if (maximum < minimum) {
    problems.push(`VITE_TOP_UP_MAXIMUM is under the ${cash(minimum)} minimum`);
    maximum = fallback;
  }
  return { minimum, maximum, problems };
}
