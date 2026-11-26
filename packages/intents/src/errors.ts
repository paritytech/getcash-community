// The two ways a request to NEAR Intents ends with no result: NEAR refuses it, or NEAR gives no
// answer this code can use. NEAR explains a refusal with one line of text and no code, so the
// kind of a refusal is read from the texts it is known to send.

/** Why NEAR refused a request. */
export type IntentsRefusal =
  /** The amount is under what NEAR takes. NEAR states the minimum in the units of the amount
   *  that was asked, or in US dollars. */
  | { kind: "too-small"; minimum?: bigint; minimumUsd?: number }
  /** No one offers the swap at this amount. NEAR says so for an amount that is too large. */
  | { kind: "no-liquidity" }
  /** The request itself is wrong: an asset, an address or a value NEAR does not take. */
  | { kind: "invalid" }
  /** NEAR has no quote behind the deposit address that was asked about. */
  | { kind: "not-found" }
  /** A text this code does not know. */
  | { kind: "other" };

/** The kind of the refusal that `message` states. */
export function classifyRefusal(message: string): IntentsRefusal {
  const atLeast = /^Amount is too low for bridge, try at least (\d+)$/.exec(message);
  if (atLeast !== null) return { kind: "too-small", minimum: BigInt(atLeast[1]!) };
  const dollars = /minimum swap amount is \$(\d+(?:\.\d+)?)$/.exec(message);
  if (dollars !== null) return { kind: "too-small", minimumUsd: Number(dollars[1]) };
  if (message === "No liquidity available") return { kind: "no-liquidity" };
  if (/^Deposit address \S+ not found$/.test(message)) return { kind: "not-found" };
  // "recipient is not valid", "slippageTolerance must not be greater than 10000".
  if (/^\w+ (is not valid$|must )/.test(message)) return { kind: "invalid" };
  return { kind: "other" };
}

/** NEAR answered and refused the request. To ask again with the same request does not help. */
export class IntentsRefused extends Error {
  readonly refusal: IntentsRefusal;

  constructor(message: string) {
    super(message);
    this.name = "IntentsRefused";
    this.refusal = classifyRefusal(message);
  }
}

/** NEAR did not answer, or its answer is not one this code can use. To ask again later can
 *  help. */
export class IntentsNoAnswer extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "IntentsNoAnswer";
  }
}
