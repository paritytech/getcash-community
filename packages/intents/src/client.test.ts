// The NEAR client over a scripted fetch: what it asks, how it reads the answers, and which
// error each bad answer becomes. The quotes, the refusals, one quote that opened an address and
// the state of that address are replies NEAR sent. No one paid into an address, so the states
// after a deposit are built from NEAR's API description.

import { describe, expect, it } from "vitest";
import {
  createIntentsClient,
  type FetchLike,
  INTENTS_API,
  type IntentsQuoteRequest,
  type IntentsState,
} from "./client";
import { IntentsNoAnswer, IntentsRefused } from "./errors";

const USDC_SOLANA = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const ETH_ETHEREUM = "nep141:eth.omft.near";
const ETH_BASE = "nep141:base.omft.near";
const KEY = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const REFUND = "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK";
const DEADLINE = "2026-11-26T12:33:55.637Z";

/** A dry quote for 0.0502 ETH on Base, paid in USDC on Solana, as NEAR sent it. */
const EXACT_OUTPUT_REPLY = {
  quote: {
    amountIn: "86358026",
    amountInFormatted: "86.358026",
    amountInUsd: "86.313983406740",
    minAmountIn: "85494445",
    amountOut: "50200000000000000",
    amountOutFormatted: "0.0502",
    amountOutUsd: "85.362590000000",
    minAmountOut: "50200000000000000",
    timeEstimate: 22,
    refundFee: "188811",
    withdrawFee: "560000000000",
  },
  quoteRequest: {
    dry: true,
    depositMode: "SIMPLE",
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: USDC_SOLANA,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ETH_BASE,
    amount: "50200000000000000",
    refundTo: REFUND,
    refundType: "ORIGIN_CHAIN",
    recipient: KEY,
    recipientType: "DESTINATION_CHAIN",
    deadline: DEADLINE,
    confidentiality: "public",
    quoteWaitingTimeMs: 3000,
    insured: false,
    appFees: [],
  },
  signature:
    "ed25519:3vhtHuBGFz7Dw7ywGwpzYyfJSVMMiqurHRs3dgNrWbduB6uGtcsE7EZyR7eTnDghUbDWXEk6PUXSGERw4xKr6Gt7",
  timestamp: "2026-11-26T10:33:59.138Z",
  correlationId: "d4e788f9-d96f-4f7f-80d4-4ce43ed0b75f",
};

/** A dry quote for 90 USDC on Solana, delivered as ETH on Ethereum, as NEAR sent it. */
const EXACT_INPUT_REPLY = {
  quote: {
    amountIn: "90000000",
    amountInFormatted: "90.0",
    amountInUsd: "89.954100000000",
    minAmountIn: "90000000",
    amountOut: "52809503253429015",
    amountOutFormatted: "0.052809503253429015",
    amountOutUsd: "89.787773621545",
    minAmountOut: "52281408220894724",
    timeEstimate: 27,
    refundFee: "188811",
    withdrawFee: "35000000000000",
  },
  quoteRequest: {
    dry: true,
    depositMode: "SIMPLE",
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: USDC_SOLANA,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ETH_ETHEREUM,
    amount: "90000000",
    refundTo: REFUND,
    refundType: "ORIGIN_CHAIN",
    recipient: KEY,
    recipientType: "DESTINATION_CHAIN",
    deadline: DEADLINE,
    confidentiality: "public",
    quoteWaitingTimeMs: 3000,
    insured: false,
    appFees: [],
  },
  signature:
    "ed25519:39a899K6ZuSF2vUgM89wukW24dhNCoVKKtJazjFLNiaXnPBMYs98EAFmQ4pJ4HAYJ9kRdyQBKivHKa3Gt7AzXK8H",
  timestamp: "2026-11-26T10:34:02.584Z",
  correlationId: "139925a1-3684-4f94-88d3-67c1b31f3c34",
};

/** The request behind the first reply. */
const EXACT_OUTPUT: IntentsQuoteRequest = {
  exact: "output",
  amount: 50_200_000_000_000_000n,
  originAsset: USDC_SOLANA,
  destinationAsset: ETH_BASE,
  recipient: KEY,
  refundTo: REFUND,
  slippageBps: 100,
  deadline: Date.parse(DEADLINE),
};

/** The request behind the second reply. */
const EXACT_INPUT: IntentsQuoteRequest = {
  ...EXACT_OUTPUT,
  exact: "input",
  amount: 90_000_000n,
  destinationAsset: ETH_ETHEREUM,
};

/** A quote that opened an address, for 0.0502 ETH on Base paid in USDC on Solana, as NEAR sent
 *  it. No one paid into the address. */
const LIVE_REPLY = {
  quote: {
    amountIn: "86446126",
    amountInFormatted: "86.446126",
    amountInUsd: "86.404372521142",
    minAmountIn: "85581664",
    amountOut: "50200000000000000",
    amountOutFormatted: "0.0502",
    amountOutUsd: "85.357570000000",
    minAmountOut: "50200000000000000",
    timeEstimate: 22,
    refundFee: "188406",
    withdrawFee: "560000000000",
    deadline: "2026-11-29T12:49:19.601Z",
    timeWhenInactive: "2026-11-29T12:49:19.601Z",
    depositAddress: "3shs12bsyvLyBWku333RVVLkVY7anAaH8rtLuHPkcrDX",
  },
  quoteRequest: {
    dry: false,
    depositMode: "SIMPLE",
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: USDC_SOLANA,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ETH_BASE,
    amount: "50200000000000000",
    refundTo: REFUND,
    refundType: "ORIGIN_CHAIN",
    recipient: "0x435161567189f0156240087735e813eff2d8a0db",
    recipientType: "DESTINATION_CHAIN",
    deadline: "2026-11-26T12:49:19.601Z",
    confidentiality: "public",
    quoteWaitingTimeMs: 0,
    insured: false,
    appFees: [],
  },
  signature:
    "ed25519:46Afya2XhPugZAZ1unV6qo6vGPQq5i8hKZq5ngLu1XFvn12JTwijRcwegCgN1hQWVktw7qsLje2kYCdboKjyF6NT",
  timestamp: "2026-11-26T12:19:19.773Z",
  correlationId: "01c4d9b2-44e5-46dc-b76a-76b8784ca416",
};

/** The request behind that reply. */
const LIVE: IntentsQuoteRequest = {
  ...EXACT_OUTPUT,
  recipient: "0x435161567189f0156240087735e813eff2d8a0db",
  deadline: Date.parse("2026-11-26T12:49:19.601Z"),
};

const DEPOSIT_ADDRESS = LIVE_REPLY.quote.depositAddress;
const liveReply = (quote: Record<string, unknown> = {}) => ({
  ...LIVE_REPLY,
  quote: { ...LIVE_REPLY.quote, ...quote },
});

/** The state of that address a moment after the quote, as NEAR sent it. */
const PENDING_REPLY = {
  status: "PENDING_DEPOSIT",
  updatedAt: "2026-11-26T12:19:20.203Z",
  correlationId: "81a3bfce-c763-4eeb-89bf-01fdc5dc9353",
  swapDetails: {
    depositedAmount: null,
    depositedAmountUsd: null,
    depositedAmountFormatted: null,
    intentHashes: [],
    nearTxHashes: [],
    amountIn: null,
    amountInFormatted: null,
    amountInUsd: null,
    amountOut: null,
    amountOutFormatted: null,
    amountOutUsd: null,
    slippage: null,
    refundedAmount: "0",
    refundedAmountFormatted: "0",
    refundedAmountUsd: "0",
    refundReason: null,
    refundFee: "188406",
    withdrawFee: "560000000000",
    originChainTxHashes: [],
    destinationChainTxHashes: [],
  },
  quoteResponse: {
    timestamp: LIVE_REPLY.timestamp,
    signature: LIVE_REPLY.signature,
    quoteRequest: LIVE_REPLY.quoteRequest,
    quote: LIVE_REPLY.quote,
  },
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A NEAR that answers every call with `reply`, and the calls it was sent. */
function near(reply: unknown, status = 200) {
  const sent: Sent[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    sent.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: JSON.parse(init.body) }),
    });
    return {
      status,
      text: async () => (typeof reply === "string" ? reply : JSON.stringify(reply)),
    };
  };
  return { client: createIntentsClient({ fetchImpl }), sent };
}

const refusal = (message: string, path = "/v0/quote") => ({
  message,
  correlationId: "2c4e7fb8-5d22-4dd3-b290-01f5a7a902b1",
  timestamp: "2026-11-26T10:34:11.945Z",
  path,
});

describe("createIntentsClient, the requests", () => {
  it("asks for a dry quote of an exact output", async () => {
    const { client, sent } = near(EXACT_OUTPUT_REPLY);
    await client.quote(EXACT_OUTPUT);
    expect(sent).toEqual([
      {
        url: `${INTENTS_API}/v0/quote`,
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: {
          dry: true,
          swapType: "EXACT_OUTPUT",
          slippageTolerance: 100,
          originAsset: USDC_SOLANA,
          depositType: "ORIGIN_CHAIN",
          destinationAsset: ETH_BASE,
          amount: "50200000000000000",
          refundTo: REFUND,
          refundType: "ORIGIN_CHAIN",
          recipient: KEY,
          recipientType: "DESTINATION_CHAIN",
          deadline: DEADLINE,
        },
      },
    ]);
  });

  it("asks for an exact input by its own name", async () => {
    const { client, sent } = near(EXACT_INPUT_REPLY);
    await client.quote(EXACT_INPUT);
    expect(sent[0]?.body).toMatchObject({
      dry: true,
      swapType: "EXACT_INPUT",
      amount: "90000000",
      destinationAsset: ETH_ETHEREUM,
    });
  });

  it("asks for a quote that opens an address with the same request, not dry", async () => {
    const { client, sent } = near(liveReply());
    await client.openDeposit(LIVE);
    const dry = near({ ...LIVE_REPLY, quoteRequest: { ...LIVE_REPLY.quoteRequest, dry: true } });
    await dry.client.quote(LIVE);
    expect(sent[0]).toEqual({
      ...dry.sent[0],
      body: { ...(dry.sent[0]?.body as object), dry: false },
    });
  });

  it("asks for the tokens with no body", async () => {
    const { client, sent } = near([]);
    await client.tokens();
    expect(sent).toEqual([
      { url: `${INTENTS_API}/v0/tokens`, method: "GET", headers: { accept: "application/json" } },
    ]);
  });

  it("asks for the status of an address, written safely into the query", async () => {
    const { client, sent } = near({ status: "PENDING_DEPOSIT" });
    await client.status("a b&c=d");
    expect(sent).toEqual([
      {
        url: `${INTENTS_API}/v0/status?depositAddress=a%20b%26c%3Dd`,
        method: "GET",
        headers: { accept: "application/json" },
      },
    ]);
  });

  it("asks another address when it is given one, with or without a last slash", async () => {
    for (const url of ["https://near.example/api", "https://near.example/api/"]) {
      const seen: string[] = [];
      const client = createIntentsClient({
        url,
        fetchImpl: async (target) => {
          seen.push(target);
          return { status: 200, text: async () => "[]" };
        },
      });
      await client.tokens();
      expect(seen).toEqual(["https://near.example/api/v0/tokens"]);
    }
  });

  it("stops waiting after its time and counts that as no answer", async () => {
    const client = createIntentsClient({
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    });
    const error = await client.tokens().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
  });
});

describe("createIntentsClient, a quote", () => {
  it("reads the figures of an exact output", async () => {
    const { client } = near(EXACT_OUTPUT_REPLY);
    expect(await client.quote(EXACT_OUTPUT)).toEqual({
      amountIn: 86_358_026n,
      minAmountIn: 85_494_445n,
      amountOut: 50_200_000_000_000_000n,
      minAmountOut: 50_200_000_000_000_000n,
      timeEstimate: 22,
    });
  });

  it("reads the figures of an exact input", async () => {
    const { client } = near(EXACT_INPUT_REPLY);
    expect(await client.quote(EXACT_INPUT)).toEqual({
      amountIn: 90_000_000n,
      minAmountIn: 90_000_000n,
      amountOut: 52_809_503_253_429_015n,
      minAmountOut: 52_281_408_220_894_724n,
      timeEstimate: 27,
    });
  });

  it.each<[string, Partial<IntentsQuoteRequest>, string]>([
    ["recipient", { recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }, "recipient"],
    ["recipient in another case", { recipient: KEY.toLowerCase() }, "recipient"],
    ["refund address", { refundTo: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" }, "refundTo"],
    ["asset to pay with", { originAsset: "nep141:sol.omft.near" }, "originAsset"],
    ["asset to deliver", { destinationAsset: ETH_ETHEREUM }, "destinationAsset"],
    ["amount", { amount: 50_200_000_000_000_001n }, "amount"],
    ["side of the amount", { exact: "input" }, "swapType"],
    ["slippage", { slippageBps: 50 }, "slippageTolerance"],
    ["deadline", { deadline: Date.parse(DEADLINE) + 1 }, "deadline"],
  ])("does not use a quote for another %s", async (_name, change, field) => {
    const { client } = near(EXACT_OUTPUT_REPLY);
    const error = await client.quote({ ...EXACT_OUTPUT, ...change }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
    expect((error as Error).message).toBe(`the quote is for another ${field}`);
  });

  it("does not use a dry quote for a request to open an address", async () => {
    const { client } = near(EXACT_OUTPUT_REPLY);
    const error = await client.openDeposit(EXACT_OUTPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
    expect((error as Error).message).toBe("the quote is for another dry");
  });

  it("takes the deadline as the same time in another form", async () => {
    const { client } = near({
      ...EXACT_OUTPUT_REPLY,
      quoteRequest: {
        ...EXACT_OUTPUT_REPLY.quoteRequest,
        deadline: "2026-11-26T13:33:55.637+01:00",
      },
    });
    expect((await client.quote(EXACT_OUTPUT)).timeEstimate).toBe(22);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["no amountIn", { amountIn: undefined }, "amountIn"],
    ["an amountIn that is a number", { amountIn: 86358026 }, "amountIn"],
    ["a minAmountIn with a fraction", { minAmountIn: "85494445.5" }, "minAmountIn"],
    ["a negative amountOut", { amountOut: "-1" }, "amountOut"],
    ["an empty minAmountOut", { minAmountOut: "" }, "minAmountOut"],
    ["an amountOut in hex", { amountOut: "0xb2566e7c5a8000" }, "amountOut"],
    ["no timeEstimate", { timeEstimate: undefined }, "timeEstimate"],
    ["a timeEstimate that is text", { timeEstimate: "22" }, "timeEstimate"],
  ])("does not trust a quote with %s", async (_name, change, field) => {
    const { client } = near({
      ...EXACT_OUTPUT_REPLY,
      quote: { ...EXACT_OUTPUT_REPLY.quote, ...change },
    });
    const error = await client.quote(EXACT_OUTPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
    expect((error as Error).message).toBe(`the quote has no ${field}`);
  });

  it.each<[string, unknown]>([
    ["text that is not JSON", "<html>"],
    ["a list", []],
    ["null", null],
    ["a reply with no quote", { quoteRequest: EXACT_OUTPUT_REPLY.quoteRequest }],
    ["a reply with no request", { quote: EXACT_OUTPUT_REPLY.quote }],
    ["a quote that is a list", { ...EXACT_OUTPUT_REPLY, quote: [] }],
  ])("counts %s as no answer", async (_name, reply) => {
    const { client } = near(reply);
    const error = await client.quote(EXACT_OUTPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
    expect((error as Error).message).toBe("the reply is not a quote");
  });
});

describe("createIntentsClient, a quote that opens an address", () => {
  it("reads the address, its deadline and the figures, and keeps NEAR's reply as sent", async () => {
    const { client } = near(LIVE_REPLY);
    expect(await client.openDeposit(LIVE)).toEqual({
      amountIn: 86_446_126n,
      minAmountIn: 85_581_664n,
      amountOut: 50_200_000_000_000_000n,
      minAmountOut: 50_200_000_000_000_000n,
      timeEstimate: 22,
      depositAddress: "3shs12bsyvLyBWku333RVVLkVY7anAaH8rtLuHPkcrDX",
      // NEAR keeps the address three days after the deadline of the request.
      deadline: Date.parse(LIVE_REPLY.quoteRequest.deadline) + 3 * 86_400_000,
      reply: JSON.stringify(LIVE_REPLY),
    });
  });

  it.each<[string, unknown]>([
    ["no deadline", undefined],
    ["a deadline it cannot read", "tomorrow"],
    ["a deadline that is a number", 1795775639000],
  ])("gives no deadline for %s", async (_name, deadline) => {
    const { client } = near(liveReply({ deadline }));
    const deposit = await client.openDeposit(LIVE);
    expect(deposit.depositAddress).toBe(DEPOSIT_ADDRESS);
    expect("deadline" in deposit).toBe(false);
  });

  it.each<[string, unknown]>([
    ["no address", undefined],
    ["an empty address", ""],
    ["an address that is not text", 12],
  ])("does not trust a quote with %s", async (_name, depositAddress) => {
    const { client } = near(liveReply({ depositAddress }));
    const error = await client.openDeposit(LIVE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
    expect((error as Error).message).toBe("the quote has no depositAddress");
  });

  it("does not take an address that needs a memo", async () => {
    const { client } = near(liveReply({ depositMemo: "1111111" }));
    const error = await client.openDeposit(LIVE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
    expect((error as Error).message).toBe("the deposit needs a memo");
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["empty", ""],
  ])("takes an address whose memo is %s", async (_name, depositMemo) => {
    const { client } = near(liveReply({ depositMemo }));
    expect((await client.openDeposit(LIVE)).depositAddress).toBe(DEPOSIT_ADDRESS);
  });

  it("does not trust figures it cannot read", async () => {
    const { client } = near(liveReply({ amountIn: "86.358026" }));
    await expect(client.openDeposit(LIVE)).rejects.toBeInstanceOf(IntentsNoAnswer);
  });
});

describe("createIntentsClient, the refusals", () => {
  it.each<[string, string, unknown]>([
    [
      "an amount under the minimum",
      "Amount is too low for bridge, try at least 110886749795838",
      { kind: "too-small", minimum: 110_886_749_795_838n },
    ],
    [
      "a chain's dollar limit",
      "Temporary swap limits: minimum swap amount is $100",
      { kind: "too-small", minimumUsd: 100 },
    ],
    ["an asset NEAR does not know", "tokenIn is not valid", { kind: "invalid" }],
    ["a text this code does not know", "Solver capacity reached", { kind: "other" }],
  ])("throws NEAR's refusal for %s", async (_name, message, kind) => {
    const { client } = near(refusal(message), 400);
    const error = await client.quote(EXACT_OUTPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsRefused);
    expect((error as IntentsRefused).message).toBe(message);
    expect((error as IntentsRefused).refusal).toEqual(kind);
  });

  it("throws NEAR's refusal for an address with no quote behind it", async () => {
    const message = `Deposit address ${KEY} not found`;
    const { client } = near(
      {
        message,
        error: "Not Found",
        statusCode: 404,
        timestamp: "2026-11-26T10:34:18.684Z",
        path: `/v0/status?depositAddress=${KEY}`,
      },
      404,
    );
    const error = await client.status(KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsRefused);
    expect((error as IntentsRefused).refusal).toEqual({ kind: "not-found" });
  });

  it.each<[string, unknown, number, string]>([
    ["a server error, even with a text", refusal("Internal server error"), 500, "HTTP 500"],
    ["a gateway that is down", "<html>Bad Gateway</html>", 502, "HTTP 502"],
    ["a rate limit", refusal("ThrottlerException: Too Many Requests"), 429, "HTTP 429"],
    ["a request timeout", refusal("Request Timeout"), 408, "HTTP 408"],
    ["a 4xx page that is not NEAR's", "<html>Forbidden</html>", 403, "HTTP 403"],
    ["a 4xx with no text", { statusCode: 400 }, 400, "HTTP 400"],
    ["a 4xx whose text is a list", { message: ["amount must be a string"] }, 400, "HTTP 400"],
    ["a redirect", "", 302, "HTTP 302"],
  ])("counts %s as no answer", async (_name, reply, status, reason) => {
    const { client } = near(reply, status);
    const error = await client.quote(EXACT_OUTPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
    expect((error as Error).message).toBe(reason);
  });

  it("counts a fetch that throws as no answer, with its reason", async () => {
    const client = createIntentsClient({
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    const error = await client.quote(EXACT_OUTPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
    expect((error as Error).message).toBe("network down");
  });

  it("counts a body that fails to arrive as no answer", async () => {
    const client = createIntentsClient({
      fetchImpl: async () => ({
        status: 200,
        text: async () => {
          throw new Error("connection reset");
        },
      }),
    });
    const error = await client.status(KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
    expect((error as Error).message).toBe("connection reset");
  });
});

describe("createIntentsClient, the tokens", () => {
  const ETH = {
    assetId: "nep141:eth.omft.near",
    decimals: 18,
    blockchain: "eth",
    symbol: "ETH",
    price: 1769.88,
    priceUpdatedAt: "2026-11-23T16:03:30.966Z",
    coingeckoId: "ethereum",
  };
  const USDT_BSC = {
    assetId: "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near",
    decimals: 18,
    blockchain: "bsc",
    symbol: "USDT",
    price: 0.999192,
    priceUpdatedAt: "2026-11-23T16:03:30.966Z",
    contractAddress: "0x55d398326f99059ff775485246999027b3197955",
    coingeckoId: "tether",
  };

  it("reads each token as NEAR lists it", async () => {
    const { client } = near([ETH, USDT_BSC]);
    expect(await client.tokens()).toEqual([
      {
        asset: "nep141:eth.omft.near",
        chain: "eth",
        symbol: "ETH",
        decimals: 18,
        priceUsd: 1769.88,
      },
      {
        asset: "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near",
        chain: "bsc",
        symbol: "USDT",
        decimals: 18,
        priceUsd: 0.999192,
      },
    ]);
  });

  it.each<[string, unknown]>([
    ["no price", undefined],
    ["a price of zero", 0],
    ["a price that is text", "1769.88"],
    ["a negative price", -1],
  ])("lists a token with %s and gives it no price", async (_name, price) => {
    const { client } = near([{ ...ETH, price }]);
    expect(await client.tokens()).toEqual([
      { asset: "nep141:eth.omft.near", chain: "eth", symbol: "ETH", decimals: 18 },
    ]);
  });

  it.each<[string, unknown]>([
    ["no asset id", { ...ETH, assetId: undefined }],
    ["decimals as text", { ...ETH, decimals: "18" }],
    ["no chain", { ...ETH, blockchain: null }],
    ["no symbol", { ...ETH, symbol: undefined }],
    ["no fields at all", "nep141:eth.omft.near"],
  ])("leaves out an entry with %s", async (_name, bad) => {
    const { client } = near([bad, USDT_BSC]);
    expect((await client.tokens()).map((token) => token.asset)).toEqual([USDT_BSC.assetId]);
  });

  it.each<[string, unknown]>([
    ["an object", { tokens: [ETH] }],
    ["text that is not JSON", "<html>"],
  ])("counts %s as no answer", async (_name, reply) => {
    const { client } = near(reply);
    const error = await client.tokens().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
    expect((error as Error).message).toBe("the reply is not a list of tokens");
  });
});

describe("createIntentsClient, the status", () => {
  it.each<IntentsState>([
    "PENDING_DEPOSIT",
    "KNOWN_DEPOSIT_TX",
    "INCOMPLETE_DEPOSIT",
    "PROCESSING",
    "SUCCESS",
    "REFUNDED",
    "FAILED",
  ])("reads the state %s", async (state) => {
    const { client } = near({ status: state });
    expect(await client.status(DEPOSIT_ADDRESS)).toEqual({ state, deliveries: [] });
  });

  it("reads an address that no one paid yet, as NEAR sent it", async () => {
    const { client } = near(PENDING_REPLY);
    expect(await client.status(DEPOSIT_ADDRESS)).toEqual({
      state: "PENDING_DEPOSIT",
      refunded: 0n,
      deliveries: [],
    });
  });

  it("reads what NEAR delivered and the transactions that carried it", async () => {
    const { client } = near({
      status: "SUCCESS",
      updatedAt: "2026-11-26T10:40:00.000Z",
      swapDetails: {
        intentHashes: ["8q1ApmqF8vrYgXbBhDAtZQKjq7jg1ueKEvGPsAfWnKzP"],
        nearTxHashes: [],
        amountIn: "85900000",
        amountOut: "50200000000000000",
        originChainTxHashes: [{ hash: "5Vx1", explorerUrl: "https://solscan.io/tx/5Vx1" }],
        destinationChainTxHashes: [
          { hash: "0xaa11", explorerUrl: "https://basescan.org/tx/0xaa11" },
          { hash: "0xbb22", explorerUrl: "https://basescan.org/tx/0xbb22" },
        ],
        refundedAmount: "458026",
      },
    });
    expect(await client.status(DEPOSIT_ADDRESS)).toEqual({
      state: "SUCCESS",
      amountOut: 50_200_000_000_000_000n,
      refunded: 458_026n,
      deliveries: ["0xaa11", "0xbb22"],
    });
  });

  it("leaves out the figures and the transactions it cannot read", async () => {
    const { client } = near({
      status: "REFUNDED",
      swapDetails: {
        amountOut: null,
        refundedAmount: "0.5",
        destinationChainTxHashes: [{ explorerUrl: "https://basescan.org" }, "0xcc33", null],
      },
    });
    expect(await client.status(DEPOSIT_ADDRESS)).toEqual({ state: "REFUNDED", deliveries: [] });
  });

  it("keeps a refund of nothing as zero", async () => {
    const { client } = near({ status: "PROCESSING", swapDetails: { refundedAmount: "0" } });
    expect(await client.status(DEPOSIT_ADDRESS)).toEqual({
      state: "PROCESSING",
      refunded: 0n,
      deliveries: [],
    });
  });

  it.each<[string, unknown, string]>([
    ["a state it does not know", { status: "EXPIRED" }, "the status is not a known one: EXPIRED"],
    ["no state", { swapDetails: {} }, "the status is not a known one: undefined"],
    ["a list", [], "the reply is not a status"],
    ["text that is not JSON", "<html>", "the reply is not a status"],
  ])("counts %s as no answer", async (_name, reply, reason) => {
    const { client } = near(reply);
    const error = await client.status(DEPOSIT_ADDRESS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsNoAnswer);
    expect((error as Error).message).toBe(reason);
  });
});
