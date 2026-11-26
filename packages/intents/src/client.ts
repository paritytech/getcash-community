// The calls to NEAR Intents that a top-up needs, over its 1Click API: the list of assets, a quote,
// a quote that opens a deposit address, and the state of a deposit.

import { IntentsNoAnswer, IntentsRefused } from "./errors";

/** NEAR's public 1Click API. */
export const INTENTS_API = "https://1click.chaindefuser.com";

/** How long a call waits for NEAR, when the caller sets no time. */
const TIMEOUT_MS = 10_000;

/** The part of fetch this client uses. */
export type FetchLike = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface IntentsToken {
  /** The asset as NEAR names it. */
  asset: string;
  /** The chain as NEAR names it, such as "eth", "base" or "sol". */
  chain: string;
  symbol: string;
  decimals: number;
  /** The price of one whole token in US dollars, when NEAR lists one. */
  priceUsd?: number;
}

export interface IntentsQuoteRequest {
  /** The side that `amount` fixes: what the user pays, or what NEAR delivers. */
  exact: "input" | "output";
  /** In the smallest unit of the origin asset for an exact input, and of the destination asset
   *  for an exact output. */
  amount: bigint;
  originAsset: string;
  destinationAsset: string;
  /** Where NEAR delivers, on the chain of the destination asset. */
  recipient: string;
  /** Where NEAR returns what it does not swap, on the chain of the origin asset. */
  refundTo: string;
  /** The most the price may move, in hundredths of a percent. */
  slippageBps: number;
  /** Until when NEAR waits for the deposit, in epoch ms. */
  deadline: number;
}

export interface IntentsQuote {
  /** What NEAR asks the user to pay. For an exact output it holds the slippage, and NEAR
   *  returns the part it does not use. */
  amountIn: bigint;
  /** The least NEAR takes for the swap. */
  minAmountIn: bigint;
  /** What NEAR expects to deliver, with its fee for the delivery already taken off. */
  amountOut: bigint;
  /** The least NEAR delivers. */
  minAmountOut: bigint;
  /** The seconds NEAR expects to take after the deposit is confirmed. */
  timeEstimate: number;
}

export interface IntentsDeposit extends IntentsQuote {
  /** Where the user pays, on the chain of the origin asset. */
  depositAddress: string;
  /** When the address stops taking deposits, in epoch ms, when NEAR states it. */
  deadline?: number;
  /** The reply as NEAR sent it, with its signature of the quote. NEAR asks to keep it in case
   *  of a dispute. */
  reply: string;
}

const STATES = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

/** Where NEAR is with a deposit address. The last three are final. */
export type IntentsState = (typeof STATES)[number];

export interface IntentsStatus {
  state: IntentsState;
  /** What NEAR delivered, when it states it. */
  amountOut?: bigint;
  /** What NEAR sent back to the refund address, when it states it. */
  refunded?: bigint;
  /** The hashes of the transactions NEAR sent on the destination chain. */
  deliveries: string[];
}

export interface IntentsClient {
  /** Every asset NEAR swaps. */
  tokens(): Promise<IntentsToken[]>;
  /** What a swap would give now. It opens no deposit address. */
  quote(request: IntentsQuoteRequest): Promise<IntentsQuote>;
  /** Opens a deposit address for the swap. Nothing moves until a deposit arrives there. */
  openDeposit(request: IntentsQuoteRequest): Promise<IntentsDeposit>;
  /** The state of the deposit address a quote opened. */
  status(depositAddress: string): Promise<IntentsStatus>;
}

export interface IntentsClientOptions {
  fetchImpl?: FetchLike;
  url?: string;
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAmount = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);

function amountOf(reply: Record<string, unknown>, field: string): bigint {
  const value = reply[field];
  if (!isAmount(value)) throw new IntentsNoAnswer(`the quote has no ${field}`);
  return BigInt(value);
}

const optionalAmount = (value: unknown): bigint | undefined =>
  isAmount(value) ? BigInt(value) : undefined;

/** The client for NEAR's 1Click API. */
export function createIntentsClient(options: IntentsClientOptions = {}): IntentsClient {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((target, init) => fetch(target, init));
  const base = (options.url ?? INTENTS_API).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  /** The text of NEAR's reply to one call. A refusal and a silence are thrown. */
  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
    let status: number;
    let text: string;
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (cause) {
      throw new IntentsNoAnswer(cause instanceof Error ? cause.message : String(cause));
    }
    if (status >= 200 && status < 300) return text;
    // NEAR refuses with a 4xx status and a line of text. A timeout (408) and a rate limit (429)
    // are not refusals: the same request can get an answer later.
    const refuses = status >= 400 && status < 500 && status !== 408 && status !== 429;
    const refusal = refuses ? parse(text) : undefined;
    if (isRecord(refusal) && typeof refusal.message === "string") {
      throw new IntentsRefused(refusal.message);
    }
    throw new IntentsNoAnswer(`HTTP ${status}`);
  }

  async function quoteReply(
    asked: IntentsQuoteRequest,
    dry: boolean,
  ): Promise<{ quote: Record<string, unknown>; text: string }> {
    const sent: Record<string, string | number | boolean> = {
      dry,
      swapType: asked.exact === "input" ? "EXACT_INPUT" : "EXACT_OUTPUT",
      slippageTolerance: asked.slippageBps,
      originAsset: asked.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: asked.destinationAsset,
      amount: asked.amount.toString(),
      refundTo: asked.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: asked.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(asked.deadline).toISOString(),
    };
    const text = await request("POST", "/v0/quote", sent);
    const reply = parse(text);
    if (!isRecord(reply) || !isRecord(reply.quote) || !isRecord(reply.quoteRequest)) {
      throw new IntentsNoAnswer("the reply is not a quote");
    }
    // NEAR repeats the request it quoted. A quote for another request must not be used.
    for (const [field, value] of Object.entries(sent)) {
      const repeated = reply.quoteRequest[field];
      const same =
        field === "deadline"
          ? typeof repeated === "string" && Date.parse(repeated) === asked.deadline
          : repeated === value;
      if (!same) throw new IntentsNoAnswer(`the quote is for another ${field}`);
    }
    return { quote: reply.quote, text };
  }

  const figuresOf = (quote: Record<string, unknown>): IntentsQuote => {
    const { timeEstimate } = quote;
    if (typeof timeEstimate !== "number" || !Number.isFinite(timeEstimate)) {
      throw new IntentsNoAnswer("the quote has no timeEstimate");
    }
    return {
      amountIn: amountOf(quote, "amountIn"),
      minAmountIn: amountOf(quote, "minAmountIn"),
      amountOut: amountOf(quote, "amountOut"),
      minAmountOut: amountOf(quote, "minAmountOut"),
      timeEstimate,
    };
  };

  return {
    async tokens() {
      const reply = parse(await request("GET", "/v0/tokens"));
      if (!Array.isArray(reply)) throw new IntentsNoAnswer("the reply is not a list of tokens");
      const tokens: IntentsToken[] = [];
      for (const token of reply) {
        // An entry this code cannot read counts as an asset NEAR does not list.
        if (
          isRecord(token) &&
          typeof token.assetId === "string" &&
          typeof token.blockchain === "string" &&
          typeof token.symbol === "string" &&
          typeof token.decimals === "number"
        ) {
          tokens.push({
            asset: token.assetId,
            chain: token.blockchain,
            symbol: token.symbol,
            decimals: token.decimals,
            ...(typeof token.price === "number" && token.price > 0
              ? { priceUsd: token.price }
              : {}),
          });
        }
      }
      return tokens;
    },

    async quote(asked) {
      return figuresOf((await quoteReply(asked, true)).quote);
    },

    async openDeposit(asked) {
      const { quote, text } = await quoteReply(asked, false);
      const { depositAddress, depositMemo, deadline } = quote;
      if (typeof depositAddress !== "string" || depositAddress === "") {
        throw new IntentsNoAnswer("the quote has no depositAddress");
      }
      // A deposit that needs a memo and is sent with none is lost, and this code shows none.
      if (depositMemo !== undefined && depositMemo !== null && depositMemo !== "") {
        throw new IntentsNoAnswer("the deposit needs a memo");
      }
      const until = typeof deadline === "string" ? Date.parse(deadline) : Number.NaN;
      return {
        ...figuresOf(quote),
        depositAddress,
        ...(Number.isNaN(until) ? {} : { deadline: until }),
        reply: text,
      };
    },

    async status(depositAddress) {
      const reply = parse(
        await request("GET", `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`),
      );
      if (!isRecord(reply)) throw new IntentsNoAnswer("the reply is not a status");
      const state = STATES.find((known) => known === reply.status);
      if (state === undefined) {
        throw new IntentsNoAnswer(`the status is not a known one: ${String(reply.status)}`);
      }
      const details = isRecord(reply.swapDetails) ? reply.swapDetails : {};
      const amountOut = optionalAmount(details.amountOut);
      const refunded = optionalAmount(details.refundedAmount);
      const sent = Array.isArray(details.destinationChainTxHashes)
        ? details.destinationChainTxHashes
        : [];
      return {
        state,
        ...(amountOut === undefined ? {} : { amountOut }),
        ...(refunded === undefined ? {} : { refunded }),
        deliveries: sent.flatMap((entry: unknown) =>
          isRecord(entry) && typeof entry.hash === "string" ? [entry.hash] : [],
        ),
      };
    },
  };
}

/** `text` as JSON, or undefined when it is not JSON. */
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
