// Checks `quoteDirectMinimum`, the estimated "receive at least" for a direct withdrawal, over a
// scripted Asset Hub pool. For the same pool read it must match the bound the worker would write
// into the program if it sized the sale now.

import { describe, expect, it, vi } from "vitest";
import { amountOut } from "@getsome/funding";
import { DEFAULT_WITHDRAW_SLIPPAGE_PCT, saleBounds } from "@getsome/withdraw";

/** Asset Hub as measured 2026-09-25 (PAS, CASH). Times 24 gives the 2.5M release depth. */
const LIVE = { pas: 421_298_658_123_227n, cash: 103_995_356_467n };
const pool = { current: LIVE };
const readAt: unknown[] = [];

vi.mock("@novasamatech/host-api", () => ({
  PaymentRequestErr: class PaymentRequestErr extends Error {},
  PaymentStatusErr: class PaymentStatusErr extends Error {},
}));
vi.mock("../lib/host-payments", () => ({
  requestPayment: vi.fn(),
  subscribePaymentStatus: vi.fn(),
}));
vi.mock("../lib/host-chain", () => ({
  ASSET_HUB: "asset-hub",
  PEOPLE: "people",
  ASSET_HUB_GENESIS: "0xah",
  PEOPLE_GENESIS: "0xpe",
  connectChain: async () => ({
    getTypedApi: () => ({
      apis: {
        AssetConversionApi: {
          quote_price_exact_tokens_for_tokens: async (
            _a: unknown,
            _b: unknown,
            sold: bigint,
            _fee: boolean,
            options?: { at?: string },
          ) => {
            readAt.push(options?.at);
            return amountOut(sold, { in: pool.current.cash, out: pool.current.pas }, 3_000n);
          },
        },
      },
      view: {
        AssetConversion: {
          get_reserves: async () => [pool.current.pas, pool.current.cash],
        },
      },
      constants: { AssetConversion: { LPFee: async () => 3_000 } },
    }),
  }),
}));

const CASH = (n: number) => BigInt(Math.round(n * 1e6));

describe("quoteDirectMinimum", () => {
  it("matches saleBounds for the same pool read, below the expected amount", async () => {
    const { quoteDirectMinimum } = await import("../lib/withdraw-live");
    for (const current of [LIVE, { pas: LIVE.pas * 24n, cash: LIVE.cash * 24n }]) {
      pool.current = current;
      const q = await quoteDirectMinimum(CASH(100));
      const sold = CASH(100) - 450_000n;
      const bounds = saleBounds({
        reserves: { in: current.cash, out: current.pas },
        quoted: q.expected,
        cashOnKey: sold,
        ceilingPct: DEFAULT_WITHDRAW_SLIPPAGE_PCT,
        feePpm: 3_000n,
      });
      expect(q.slippagePct).toBe(bounds.safetyPct);
      expect(q.atLeast).toBeLessThan(q.expected);
      expect(q.atLeast).toBe(
        (q.expected * BigInt(Math.round((100 - q.slippagePct) * 100))) / 10_000n,
      );
    }
  });

  it("quotes the sale at the best head, as the worker does", async () => {
    const { quoteDirectMinimum } = await import("../lib/withdraw-live");
    readAt.length = 0;
    await quoteDirectMinimum(CASH(50));
    expect(readAt).toEqual(["best"]);
  });

  it("is tighter on a deeper pool, and never below the 2% floor", async () => {
    const { quoteDirectMinimum } = await import("../lib/withdraw-live");
    pool.current = LIVE;
    const today = await quoteDirectMinimum(CASH(100));
    pool.current = { pas: LIVE.pas * 24n, cash: LIVE.cash * 24n };
    const release = await quoteDirectMinimum(CASH(100));
    expect(release.slippagePct).toBeLessThan(today.slippagePct);
    expect(release.slippagePct).toBeGreaterThanOrEqual(2);
  });

  it("answers zero for an amount the fees eat whole", async () => {
    const { quoteDirectMinimum } = await import("../lib/withdraw-live");
    expect(await quoteDirectMinimum(CASH(0.1))).toMatchObject({ expected: 0n, atLeast: 0n });
  });
});
