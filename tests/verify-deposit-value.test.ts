// Prices a deposit that already landed, on every direct route, against Paseo Asset Hub next and
// People, and checks the figure the other way round: sizing that much CASH on the same route must
// not ask for more than the deposit. Reads only; nothing is submitted.
//   VERIFY_DEPOSIT_VALUE=1 pnpm vitest run tests/verify-deposit-value.test.ts

import { describe, expect, it } from "vitest";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  DIRECT_SLIPPAGE_PCT,
  PASEO_PEOPLE_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  type ConversionRoute,
} from "@getsome/funding";
import {
  estimatePsmFundingSizing,
  estimateStableFundingSizing,
  estimateDotUsdFundingSizing,
  quoteDepositValue,
} from "../lib/funding-fees";

/** A funded Paseo account for the fee reads; the fees do not depend on its balance. */
const PROBE = "14TSnbZch5jFAqDvp3szNt6qyTPw5BAeEQ4VgJ6w5qjmYSos";
const units = (v: bigint, d = 6) => (Number(v) / 10 ** d).toFixed(d);

const CASES: Array<{ name: string; route: ConversionRoute; deposit: bigint; decimals: number }> = [
  { name: "dotUSD tier", route: { tier: "dotusd" }, deposit: 8_000_000n, decimals: 6 },
  {
    name: "USDT through the PSM",
    route: { tier: "psm", external: "USDT", feeRate: 5_000 },
    deposit: 8_000_000n,
    decimals: 6,
  },
  {
    name: "USDC through the pools",
    route: { tier: "pool", external: "USDC" },
    deposit: 8_000_000n,
    decimals: 6,
  },
  { name: "DOT through the pool", route: { tier: "pool" }, deposit: 30_000_000_000n, decimals: 10 },
];

describe.runIf(process.env.VERIFY_DEPOSIT_VALUE === "1")("deposit value on Paseo", () => {
  it("prices a landed deposit on every direct route, and the figure sizes back under it", async () => {
    const ahClient = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const peopleClient = createClient(
      getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"),
    );
    const base = {
      ahClient,
      peopleClient,
      underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
      peopleParaId: PASEO_PEOPLE_PARA_ID,
      probeAddress: PROBE,
    };
    try {
      for (const c of CASES) {
        const value = await quoteDepositValue({
          ...base,
          route: c.route,
          deposit: c.deposit,
          slippagePct: DIRECT_SLIPPAGE_PCT,
        });
        expect(value, c.name).not.toBeNull();
        const receive = value!.receive;
        // Sized back the way a fresh quote for that much CASH would be, the ask stays within
        // what arrived.
        let asked: bigint | null = null;
        if (c.route.tier === "dotusd") {
          asked = (await estimateDotUsdFundingSizing({ ...base, settleAmount: receive }))
            .quotedDeposit;
        } else if (c.route.tier === "psm") {
          asked = (
            await estimatePsmFundingSizing({ ...base, settleAmount: receive, route: c.route })
          ).quotedDeposit;
        } else if (c.route.external !== undefined) {
          asked = (
            await estimateStableFundingSizing({
              ...base,
              settleAmount: receive,
              route: { tier: "pool", external: c.route.external },
              slippagePct: 0,
            })
          ).quotedDeposit;
        }
        console.log(
          `${c.name}: ${units(c.deposit, c.decimals)} in -> ${units(receive)} CASH` +
            (asked === null ? "" : `, which a fresh quote sizes at ${units(asked, c.decimals)}`),
        );
        if (asked !== null) expect(asked, c.name).toBeLessThanOrEqual(c.deposit);
      }
    } finally {
      ahClient.destroy();
      peopleClient.destroy();
    }
  }, 600_000);
});
