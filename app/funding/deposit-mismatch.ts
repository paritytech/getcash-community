// What a direct deposit that differs from the one asked looks like to the buyer. The figures come
// in already formatted; this only chooses the sentences the sheet shows around them.

import { cashAmount } from "../utils/cash";

export interface DepositMismatch {
  /** Less than asked arrived, or a different token did. */
  kind: "short" | "token";
  /** What the top-up asked the buyer to send. */
  asked: { amount: string; symbol: string };
  /** What arrived on the request's account. */
  landed: { amount: string; symbol: string };
  /** The CASH asked for, as a human figure. */
  target: string;
  /** The CASH the deposit converts to now, as a human figure. */
  receive: string;
}

export interface MismatchText {
  title: string;
  /** What can still be done; the figures themselves are drawn, not said. */
  body: string;
  /** The primary pill's label, with the CASH sum written out. */
  accept: string;
}

/** The sheet's words for a mismatch: what happened and what can still be done with it. */
export function describeMismatch(mismatch: DepositMismatch): MismatchText {
  const accept = `Continue with ${cashAmount(mismatch.receive)}`;
  if (mismatch.kind === "token") {
    return {
      title: `${mismatch.landed.symbol} arrived instead of ${mismatch.asked.symbol}`,
      body: `We can convert ${mismatch.landed.symbol} too, at its own rate, or you can take it back.`,
      accept,
    };
  }
  return {
    title: "Less arrived than asked",
    body: "We can convert what arrived instead, or you can take it back.",
    accept,
  };
}
