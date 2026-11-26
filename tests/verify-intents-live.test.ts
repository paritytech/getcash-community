// The NEAR client against NEAR itself. Every quote is dry: it opens no deposit address and moves
// nothing. The token list must name each asset of the table with the decimals of the catalog,
// both quote types must answer for both routes, and each source must get a quote or a refusal
// that names a minimum.
//   VERIFY_INTENTS=1 pnpm vitest run tests/verify-intents-live.test.ts

import { describe, expect, it } from "vitest";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import type { SourceId } from "@getsome/core";
import {
  type BridgeStart,
  createIntentsClient,
  INTENTS_ETH,
  INTENTS_SOURCES,
  IntentsRefused,
  type IntentsQuoteRequest,
  type IntentsSource,
  sourceReach,
} from "@getsome/intents";

const ON = process.env.VERIFY_INTENTS === "1";

/** The public test address of local nodes, in lower case as the bridge key's address is. */
const KEY = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

/** A well-formed address on each chain of the catalog, to name as the place of a refund. */
const REFUND_TO: Record<string, string> = {
  Bitcoin: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  Ethereum: KEY,
  Arbitrum: KEY,
  Bsc: KEY,
  Solana: "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK",
  Tron: "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8",
};

const USDC_SOLANA = INTENTS_SOURCES["usdc-solana"]!.asset;
const STARTS: BridgeStart[] = ["ethereum", "base"];
const sources = Object.entries(INTENTS_SOURCES) as [SourceId, IntentsSource][];

const client = createIntentsClient();

const request = (over: Partial<IntentsQuoteRequest>): IntentsQuoteRequest => ({
  exact: "output",
  amount: 50_200_000_000_000_000n,
  originAsset: USDC_SOLANA,
  destinationAsset: INTENTS_ETH.ethereum,
  recipient: KEY,
  refundTo: REFUND_TO.Solana!,
  slippageBps: 100,
  deadline: Date.now() + 2 * 3_600_000,
  ...over,
});

describe.skipIf(!ON)("the NEAR client against NEAR", () => {
  it("finds every asset of the table in NEAR's list, with the catalog's decimals", async () => {
    const listed = new Map((await client.tokens()).map((token) => [token.asset, token]));
    expect(listed.size).toBeGreaterThan(100);
    for (const start of STARTS) {
      expect(listed.get(INTENTS_ETH[start]), start).toMatchObject({ symbol: "ETH", decimals: 18 });
    }
    for (const [id, source] of sources) {
      const token = listed.get(source.asset);
      expect(token, id).toBeDefined();
      expect(token?.decimals, id).toBe(SOURCE_CONFIG_BY_ID.get(id)?.decimals);
    }
  }, 30_000);

  it.each(STARTS)(
    "quotes an exact amount of ETH delivered on %s",
    async (start) => {
      const asked = request({ destinationAsset: INTENTS_ETH[start] });
      const started = Date.now();
      const quote = await client.quote(asked);
      console.log(
        `exact output on ${start}: ${quote.amountIn} USDC units in (least ${quote.minAmountIn}) for ${quote.amountOut} wei, ${quote.timeEstimate} s estimated, answered in ${Date.now() - started} ms`,
      );
      // The key gets what was asked, whatever the price does.
      expect(quote.amountOut).toBe(asked.amount);
      expect(quote.minAmountOut).toBe(asked.amount);
      expect(quote.minAmountIn).toBeGreaterThan(0n);
      expect(quote.minAmountIn).toBeLessThanOrEqual(quote.amountIn);
    },
    30_000,
  );

  it.each(STARTS)(
    "quotes an exact payment for ETH delivered on %s",
    async (start) => {
      const asked = request({
        exact: "input",
        amount: 90_000_000n,
        destinationAsset: INTENTS_ETH[start],
      });
      const quote = await client.quote(asked);
      console.log(
        `exact input on ${start}: ${quote.amountIn} USDC units for ${quote.amountOut} wei (least ${quote.minAmountOut})`,
      );
      expect(quote.amountIn).toBe(asked.amount);
      expect(quote.minAmountOut).toBeGreaterThan(0n);
      expect(quote.minAmountOut).toBeLessThanOrEqual(quote.amountOut);
    },
    30_000,
  );

  it("quotes each source on each route it reaches through NEAR, for the catalog's amount", async () => {
    for (const [id, source] of sources) {
      const config = SOURCE_CONFIG_BY_ID.get(id)!;
      for (const start of STARTS) {
        if (sourceReach(source, start) === "direct") continue;
        const asked = request({
          exact: "input",
          amount: BigInt(config.referenceAmountBaseUnits),
          originAsset: source.asset,
          destinationAsset: INTENTS_ETH[start],
          refundTo: REFUND_TO[config.chain]!,
        });
        const quote = await client.quote(asked);
        console.log(`${id} to ${start}: ${asked.amount} units give ${quote.amountOut} wei`);
        expect(quote.amountOut, `${id} to ${start}`).toBeGreaterThan(0n);
      }
    }
  }, 180_000);

  it("is refused with a minimum when the amount is too small, and that minimum is taken", async () => {
    const error = await client.quote(request({ amount: 1_000n })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsRefused);
    const { refusal } = error as IntentsRefused;
    console.log(`too small: ${(error as Error).message}`);
    if (refusal.kind !== "too-small" || refusal.minimum === undefined) {
      throw new Error(`expected a minimum, got ${JSON.stringify(refusal)}`);
    }
    expect(refusal.minimum).toBeGreaterThan(1_000n);
    // The minimum is in the units of the amount asked. It moves with gas, so ask a little more.
    const enough = refusal.minimum + refusal.minimum / 20n;
    expect((await client.quote(request({ amount: enough }))).amountOut).toBe(enough);
    const less = await client.quote(request({ amount: refusal.minimum / 2n })).catch((e) => e);
    expect(less).toBeInstanceOf(IntentsRefused);
  }, 30_000);

  it("names the minimum of an exact payment in the units of the payment", async () => {
    const bitcoin = {
      exact: "input",
      originAsset: INTENTS_SOURCES.btc!.asset,
      refundTo: REFUND_TO.Bitcoin!,
    } as const;
    const error = await client
      .quote(request({ ...bitcoin, amount: 1_000n }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsRefused);
    const { refusal } = error as IntentsRefused;
    console.log(`too small in bitcoin: ${(error as Error).message}`);
    if (refusal.kind !== "too-small" || refusal.minimum === undefined) {
      throw new Error(`expected a minimum, got ${JSON.stringify(refusal)}`);
    }
    const enough = refusal.minimum + refusal.minimum / 20n;
    expect((await client.quote(request({ ...bitcoin, amount: enough }))).amountIn).toBe(enough);
  }, 30_000);

  it("is refused for want of liquidity when the amount is far too large", async () => {
    const error = await client
      .quote(request({ amount: 100_000n * 10n ** 18n }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsRefused);
    expect((error as IntentsRefused).refusal).toEqual({ kind: "no-liquidity" });
  }, 30_000);

  it("quotes a large top-up on both routes", async () => {
    for (const start of STARTS) {
      const asked = request({ amount: 3n * 10n ** 18n, destinationAsset: INTENTS_ETH[start] });
      const quote = await client.quote(asked);
      console.log(`3 ETH on ${start}: ${quote.amountIn} USDC units in, least ${quote.minAmountIn}`);
      expect(quote.minAmountOut).toBe(asked.amount);
    }
  }, 30_000);

  it("is refused as invalid for an asset NEAR does not have", async () => {
    const error = await client
      .quote(request({ originAsset: "nep141:not-a-token.near" }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsRefused);
    expect((error as IntentsRefused).refusal).toEqual({ kind: "invalid" });
  }, 30_000);

  it("is told that an address with no quote behind it is not found", async () => {
    const error = await client.status(KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentsRefused);
    expect((error as IntentsRefused).refusal).toEqual({ kind: "not-found" });
  }, 30_000);
});

// This part is not dry. Each run opens one deposit address at NEAR for each route. Nothing
// moves, because no one pays into the addresses, and they stop at their deadline. Run it only
// when NEAR's reply to such a quote must be checked again.
//   VERIFY_INTENTS_LIVE_QUOTE=1 pnpm vitest run tests/verify-intents-live.test.ts
describe.skipIf(process.env.VERIFY_INTENTS_LIVE_QUOTE !== "1")(
  "a quote that opens a deposit address, against NEAR",
  () => {
    /** The client over a fetch that prints each reply as NEAR sent it. */
    const printing = createIntentsClient({
      fetchImpl: async (url, init) => {
        const response = await fetch(url, init);
        const text = await response.text();
        console.log(`${init.method} ${url} gave HTTP ${response.status}: ${text}`);
        return { status: response.status, text: async () => text };
      },
    });

    it.each(STARTS)(
      "opens an address for ETH delivered on %s, and reads its state",
      async (start) => {
        // An address that no one holds the key of: nothing is ever paid for it.
        const recipient = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}`;
        const asked = request({
          destinationAsset: INTENTS_ETH[start],
          recipient,
          deadline: Date.now() + 30 * 60_000,
        });
        const deposit = await printing.openDeposit(asked);
        // USDC on Solana is paid to an address of Solana.
        expect(deposit.depositAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
        expect(deposit.minAmountOut).toBe(asked.amount);
        expect(deposit.minAmountIn).toBeLessThanOrEqual(deposit.amountIn);
        expect(JSON.parse(deposit.reply).signature).toMatch(/^ed25519:/);
        // NEAR states the deadline of the address, at or after the one that was asked.
        expect(deposit.deadline).toBeGreaterThanOrEqual(asked.deadline);

        // No one paid, so NEAR waits and has sent nothing back.
        const status = await printing.status(deposit.depositAddress);
        expect(status).toEqual({ state: "PENDING_DEPOSIT", refunded: 0n, deliveries: [] });
      },
      60_000,
    );
  },
);
