// Prints the flow each site's flat constant and computed bound absorb on the live Paseo pools.
// Read-only, not in CI:
//   SLIPPAGE_REPORT=1 pnpm vitest run tests/slippage-report.test.ts

import { describe, it } from "vitest";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import {
  DEFAULT_SLIPPAGE_PCT,
  absorbableFlow,
  discoverPool,
  withdrawalBounds,
  PASEO_UNDERLYING_ASSET_ID,
  type Exposure,
  type OrientedReserves,
} from "@getsome/funding";
import { CASH_LOCATION } from "@getsome/people";
import { headroomFor } from "../lib/funding-fees";
import {
  DEFAULT_WITHDRAW_SLIPPAGE_PCT,
  PEOPLE_NATIVE,
  SWAP_HEADROOM_PCT,
  saleBounds,
  swapHeadroomPct,
} from "@getsome/withdraw";

const AH_WS = "wss://paseo-asset-hub-next-rpc.polkadot.io";
const PEOPLE_WS = "wss://paseo-people-next-system-rpc.polkadot.io";

const CASH_DEC = 6;
const PAS_DEC = 10;
const fmt = (v: bigint, dec: number) =>
  (Number(v) / 10 ** dec).toLocaleString("en-US", {
    maximumFractionDigits: dec > 6 ? 4 : 2,
  });
const pad = (s: string, n: number) => s.padStart(n);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reserves(api: any, a: unknown, b: unknown): Promise<[bigint, bigint]> {
  const out = await api.view.AssetConversion.get_reserves(a, b);
  const pair = (out as { value?: unknown })?.value ?? out;
  return [BigInt((pair as bigint[])[0]), BigInt((pair as bigint[])[1])];
}

/** Prints one site: the flat constant and the computed bound, and the flow each absorbs. */
function compare(args: {
  site: string;
  what: string;
  reserves: OrientedReserves;
  tradeOut: bigint;
  outDec: number;
  outSym: string;
  /** The site's flat constant: the fallback on the ramps, the floor on the fee swap. */
  flat: number;
  exposure: Exposure;
  feePpm: bigint;
  /** The computed bound, from the function the site's caller uses. */
  pct: number;
  /** What that function said about the pool, when it flagged it. */
  flag?: string;
}) {
  const flatFlow = absorbableFlow(args.tradeOut, args.reserves, args.flat, args.feePpm);
  const flowAbsorbed = absorbableFlow(args.tradeOut, args.reserves, args.pct, args.feePpm);
  const share = (f: bigint) => ((Number(f) / Number(args.reserves.out)) * 100).toFixed(2);
  console.log(`\n  ${args.site}:  ${args.what}`);
  console.log(`    pool out-side reserve : ${fmt(args.reserves.out, args.outDec)} ${args.outSym}`);
  console.log(`    this trade            : ${fmt(args.tradeOut, args.outDec)} ${args.outSym}`);
  console.log(`    exposure              : ${args.exposure}`);
  console.log(
    `    FLAT     ${pad(args.flat.toFixed(2), 6)}%  absorbs ${pad(
      fmt(flatFlow, args.outDec),
      14,
    )} ${args.outSym}  (${pad(share(flatFlow), 6)}% of the pool)`,
  );
  console.log(
    `    COMPUTED ${pad(args.pct.toFixed(2), 6)}%  absorbs ${pad(
      fmt(flowAbsorbed, args.outDec),
      14,
    )} ${args.outSym}  (${pad(share(flowAbsorbed), 6)}% of the pool)` +
      `${args.flag ? `   [${args.flag}]` : ""}`,
  );
}

describe.runIf(process.env.SLIPPAGE_REPORT === "1")("slippage report", () => {
  it("prints each site's flat constant next to the computed bound", async () => {
    const ahC = createClient(getWsProvider(AH_WS));
    const peC = createClient(getWsProvider(PEOPLE_WS));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ah: any = ahC.getTypedApi(paseo_next_v2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pe: any = peC.getTypedApi(paseo_people_next);
    try {
      const [ahFee, peFee] = await Promise.all([
        ah.constants.AssetConversion.LPFee(),
        pe.constants.AssetConversion.LPFee(),
      ]);
      const pool = await discoverPool(ah, PASEO_UNDERLYING_ASSET_ID);
      const [ahPas, ahCash] = await reserves(ah, pool.native, pool.underlying);
      const [pePas, peCash] = await reserves(pe, PEOPLE_NATIVE, CASH_LOCATION);

      console.log(`\n=== POOLS (live) ===`);
      console.log(
        `  Asset Hub : ${fmt(ahPas, PAS_DEC)} PAS  /  ${fmt(ahCash, CASH_DEC)} CASH` +
          `   -> 1 PAS = ${(Number(ahCash) / 1e6 / (Number(ahPas) / 1e10)).toFixed(4)} CASH`,
      );
      console.log(
        `  People    : ${fmt(pePas, PAS_DEC)} PAS  /  ${fmt(peCash, CASH_DEC)} CASH` +
          `   -> 1 PAS = ${(Number(peCash) / 1e6 / (Number(pePas) / 1e10)).toFixed(4)} CASH`,
      );
      console.log(
        `  LP fee    : Asset Hub ${Number(ahFee) / 10_000}%   People ${Number(peFee) / 10_000}%`,
      );

      console.log(`\n=== THE THREE SITES ===`);

      // A: the on-ramp buy on Asset Hub, from headroomFor without the live dispatch fee.
      for (const [rail, exposure] of [
        ["crypto (DOT direct)", "minutes"],
        ["card (Meld)", "hours"],
        ["bank transfer (Meld)", "days"],
      ] as Array<[string, Exposure]>) {
        const headroom = headroomFor({
          reserves: { in: ahPas, out: ahCash },
          buyTarget: 100_000_000n,
          exposure,
          feePpm: BigInt(ahFee),
        });
        compare({
          site: "A  on-ramp",
          what: `deposit sizing for 100 CASH via ${rail}`,
          reserves: { in: ahPas, out: ahCash },
          tradeOut: 100_000_000n,
          outDec: CASH_DEC,
          outSym: "CASH",
          flat: DEFAULT_SLIPPAGE_PCT,
          exposure,
          feePpm: BigInt(ahFee),
          pct: headroom.pct,
          ...(headroom.unavailable ? { flag: "unavailable: a fresh quote is refused" } : {}),
        });
      }

      // B: the off-ramp sale on Asset Hub, where a breach traps the withdrawal.
      const sellCash = 100_000_000n;
      const quotedPas = await ah.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
        pool.underlying,
        pool.native,
        sellCash,
        true,
      );
      // What sizeXcm ships: the derived bound clamped to the ceiling.
      const sale = saleBounds({
        reserves: { in: ahCash, out: ahPas },
        quoted: BigInt(quotedPas),
        cashOnKey: sellCash,
        ceilingPct: DEFAULT_WITHDRAW_SLIPPAGE_PCT,
        feePpm: BigInt(ahFee),
      });
      compare({
        site: "B  off-ramp",
        what: `minPasOut for a 100 CASH withdrawal (quoted ${fmt(BigInt(quotedPas), PAS_DEC)} PAS)`,
        reserves: { in: ahCash, out: ahPas },
        tradeOut: BigInt(quotedPas),
        outDec: PAS_DEC,
        outSym: "PAS",
        flat: DEFAULT_WITHDRAW_SLIPPAGE_PCT,
        exposure: "instant",
        feePpm: BigInt(ahFee),
        pct: sale.safetyPct,
        ...(sale.overCapacity ? { flag: "over capacity: the ceiling cut the bound" } : {}),
      });

      // C: the People fee swap, where a rejection burns a fee and one of the three shared strikes.
      compare({
        site: "C  fee swap",
        // What sizeSwap buys: the ED plus 1.05 x the XCM fee, 0.1041559 PAS (about 0.42 CASH).
        what: "buying the ~0.104 PAS the withdrawal's fees need, on People",
        reserves: { in: peCash, out: pePas },
        tradeOut: 1_041_559_000n,
        outDec: PAS_DEC,
        outSym: "PAS",
        // The 5% floor alone; swapHeadroomPct never ships below it.
        flat: SWAP_HEADROOM_PCT,
        exposure: "instant",
        feePpm: BigInt(peFee),
        pct: swapHeadroomPct({ cash: peCash, pas: pePas }, 1_041_559_000n),
      });

      // Site B's bound for a few concurrency values: typical withdrawals landing ahead of the sale.
      console.log(`\n=== THE CONCURRENCY KNOB at site B, on the live pool ===`);
      for (const concurrency of [2, 6, 12, 24, 50]) {
        const b = withdrawalBounds({
          reserves: { in: ahCash, out: ahPas },
          tradeOut: BigInt(quotedPas),
          feeTakenFromTrade: (BigInt(quotedPas) * 10_000n) / sellCash,
          referenceTrade: (BigInt(quotedPas) * 100_000_000n) / sellCash,
          feePpm: BigInt(ahFee),
          concurrency,
          // The ceiling sizeXcm passes, so overCapacity is judged against what ships.
          ceilingPct: DEFAULT_WITHDRAW_SLIPPAGE_PCT,
        });
        const flow = absorbableFlow(
          BigInt(quotedPas),
          { in: ahCash, out: ahPas },
          b.safetyPct,
          BigInt(ahFee),
        );
        console.log(
          `  ${pad(String(concurrency), 3)} in flight: ${pad(b.safetyPct.toFixed(2), 6)}%  absorbs ${pad(fmt(flow, PAS_DEC), 12)} PAS` +
            `${b.overCapacity ? "  [over capacity]" : ""}`,
        );
      }
    } finally {
      ahC.destroy();
      peC.destroy();
    }
  }, 180_000);
});
