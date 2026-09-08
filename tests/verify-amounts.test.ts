// Live amount check: sizes the deposit as the app does, quotes the pool's swap, dry-runs the
// self-funding teleport and reads what lands on People. Needs network and is not part of CI:
//   VERIFY_AMOUNTS=1 pnpm vitest run tests/verify-amounts.test.ts

import { describe, it } from "vitest";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import {
  discoverPool,
  quoteNativeInMax,
  estimateTeleportFeesCash,
  buildSelfFundingTeleport,
  DEFAULT_SLIPPAGE_PCT,
  PASEO_UNDERLYING_ASSET_ID,
  PASEO_PEOPLE_PARA_ID,
  PASEO_ASSET_HUB_PARA_ID,
} from "@getsome/funding";

const CASH = (n: number) => BigInt(n) * 1_000_000n; // 6 decimals
const ZERO_32 = `0x${"00".repeat(32)}`;
const fmtCash = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const fmtPas = (v: bigint) => (Number(v) / 1e10).toFixed(6);
const j = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

describe.runIf(process.env.VERIFY_AMOUNTS === "1")("live amount check", () => {
  it("ask for 20 / 50 / 100 CASH -> what lands", async () => {
    const ahC = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const peC = createClient(getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ah: any = ahC.getTypedApi(paseo_next_v2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pe: any = peC.getTypedApi(paseo_people_next);
    try {
      const pool = await discoverPool(ah, PASEO_UNDERLYING_ASSET_ID);
      const origin = {
        type: "V5",
        value: {
          parents: 1,
          interior: { type: "X1", value: { type: "Parachain", value: PASEO_ASSET_HUB_PARA_ID } },
        },
      };
      const holders = await ah.query.Assets.Account.getEntries(PASEO_UNDERLYING_ASSET_ID);
      const slippages = [0.5, 1, DEFAULT_SLIPPAGE_PCT]; // 0.5% / 1% / 2%
      for (const n of [20, 50, 100]) {
        const settle = CASH(n);
        // Fee estimate and buy target (settle + teleport CASH fees), as the app sizes it.
        const fees = await estimateTeleportFeesCash({
          api: ah,
          pool,
          beneficiaryHex: ZERO_32,
          peopleParaId: PASEO_PEOPLE_PARA_ID,
          amount: settle,
        });
        const buyTarget = settle + fees.payFeesCash;
        console.log(
          `\n### Ask: ${n} CASH  (teleport fee ${fmtCash(fees.localCash + fees.deliveryCash)} CASH, all in CASH)`,
        );
        for (const slip of slippages) {
          // Deposit native (slippage-capped max-in for the buy target), then what it buys, then
          // land.
          const nativeInMax = await quoteNativeInMax(ah, pool, buyTarget, slip);
          const cashBought = (await ah.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
            pool.native,
            pool.underlying,
            nativeInMax,
            true,
          )) as bigint | undefined;
          if (cashBought === undefined) {
            console.log(`  ${slip}%: pool could not quote`);
            continue;
          }
          const holder = holders.find(
            (e: { value?: { balance?: bigint } }) =>
              (e.value?.balance ?? 0n) >= cashBought + CASH(10),
          )?.keyArgs?.[1];
          const call = ah.tx.PolkadotXcm.execute(
            buildSelfFundingTeleport({
              pool,
              withdrawAmount: cashBought,
              payFeesCash: fees.payFeesCash,
              remoteFeesCash: fees.payFeesCash,
              beneficiaryHex: ZERO_32,
              peopleParaId: PASEO_PEOPLE_PARA_ID,
            }),
          );
          const dr = await ah.apis.DryRunApi.dry_run_call(
            { type: "system", value: { type: "Signed", value: holder } },
            call.decodedCall,
            5,
          );
          let fwd: unknown;
          if (dr.success)
            fwd = (
              dr.value as { forwarded_xcms?: Array<[unknown, unknown[]]> }
            ).forwarded_xcms?.find(([d]) =>
              j(d).includes(`"value":${PASEO_PEOPLE_PARA_ID}`),
            )?.[1]?.[0];
          let landed = 0n;
          if (fwd) {
            const pdr = await pe.apis.DryRunApi.dry_run_xcm(origin, fwd);
            if (pdr.success)
              for (const ev of pdr.value.emitted_events as Array<{
                value?: { type?: string; value?: { amount?: bigint } };
              }>)
                if (ev.value?.type === "Deposited") {
                  const a = BigInt(ev.value.value?.amount ?? 0n);
                  if (a > landed) landed = a;
                }
          }
          console.log(
            `  ${String(slip).padStart(4)}% slippage -> send ${fmtPas(nativeInMax)} PAS -> LANDS ${fmtCash(landed)} CASH  ${landed >= settle ? "ok" : "SHORT"}  (over +${fmtCash(landed - settle)})`,
          );
        }
      }
    } finally {
      ahC.destroy();
      peC.destroy();
    }
  }, 180_000);
});
