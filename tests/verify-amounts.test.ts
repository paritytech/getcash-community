// Live amount check: sizes the deposit as the app does, dry-runs the funding program from a funded
// account and reads what lands on People. Nothing is submitted. Needs network and is not part of
// CI:
//   VERIFY_AMOUNTS=1 pnpm vitest run tests/verify-amounts.test.ts

import { describe, it } from "vitest";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import {
  buildFundingProgram,
  destinationEarmark,
  discoverPool,
  estimateFundingProgramFees,
  quoteNativeInMax,
  DEFAULT_SLIPPAGE_PCT,
  PASEO_UNDERLYING_ASSET_ID,
  PASEO_PEOPLE_PARA_ID,
  PASEO_ASSET_HUB_PARA_ID,
} from "@getsome/funding";
import { estimateFundingSizing } from "../lib/funding-fees";

const CASH = (n: number) => BigInt(n) * 1_000_000n; // 6 decimals
const ZERO_32 = `0x${"00".repeat(32)}`;
const fmtCash = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const fmtPas = (v: bigint) => (Number(v) / 1e10).toFixed(6);
const j = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

type Event = { type: string; value?: { type?: string; value?: unknown } };

describe.runIf(process.env.VERIFY_AMOUNTS === "1")("live amount check", () => {
  it("ask for 20 / 50 / 100 CASH -> what lands", async () => {
    const ahC = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const peC = createClient(getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ah: any = ahC.getTypedApi(paseo_next_v2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pe: any = peC.getTypedApi(paseo_people_next);
    try {
      // Dry-run from the richest native holder, so the whole program can be simulated whatever
      // the deposit size.
      const accounts = (await ah.query.System.Account.getEntries()) as Array<{
        keyArgs: [string];
        value: { data: { free: bigint } };
      }>;
      const holder = accounts.reduce((best, e) =>
        e.value.data.free > best.value.data.free ? e : best,
      );
      const from = holder.keyArgs[0];
      console.log(`dry-run origin ${from} (free ${fmtPas(holder.value.data.free)} PAS)`);

      const pool = await discoverPool(ah, PASEO_UNDERLYING_ASSET_ID);
      const origin = {
        type: "V5",
        value: {
          parents: 1,
          interior: { type: "X1", value: { type: "Parachain", value: PASEO_ASSET_HUB_PARA_ID } },
        },
      };
      const slippages = [0.5, 1, DEFAULT_SLIPPAGE_PCT];
      for (const n of [20, 50, 100]) {
        const settle = CASH(n);
        // The deposit's fee allowances, as the app sizes them.
        const sizing = await estimateFundingSizing({
          ahClient: ahC,
          peopleClient: peC,
          underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
          peopleParaId: PASEO_PEOPLE_PARA_ID,
          settleAmount: settle,
          probeAddress: from,
        });
        if (!sizing) throw new Error("sizing failed");
        const buyTarget = settle + sizing.remoteFeeBuffer;
        const earmark = destinationEarmark(buyTarget, sizing.remoteFeeBuffer);
        console.log(
          `\n### Ask: ${n} CASH  (fee native ${fmtPas(sizing.keepNativeForFees)} PAS, destination over-buy ${fmtCash(sizing.remoteFeeBuffer)} CASH)`,
        );
        for (const slip of slippages) {
          // The deposit: the slippage-capped quote for the buy target plus the fee native.
          const nativeInMax = await quoteNativeInMax(ah, pool, buyTarget, slip);
          const deposit = nativeInMax + sizing.keepNativeForFees;
          // Fees as the worker prices them at the submitting tick, dry-running from the holder.
          const fees = await estimateFundingProgramFees({
            api: ah,
            pool,
            beneficiaryHex: ZERO_32,
            peopleParaId: PASEO_PEOPLE_PARA_ID,
            nativeBalance: deposit,
            minUnderlyingOut: buyTarget,
            remoteFeesCash: earmark,
            feeProbeAddress: from,
            dryRunFrom: from,
          });
          const call = ah.tx.PolkadotXcm.execute(
            buildFundingProgram({
              pool,
              withdrawNative: deposit - fees.dispatchNative,
              payFeesNative: fees.payFeesNative,
              minUnderlyingOut: buyTarget,
              remoteFeesCash: earmark,
              beneficiaryHex: ZERO_32,
              peopleParaId: PASEO_PEOPLE_PARA_ID,
              maxWeight: fees.maxWeight,
            }),
          );
          const dr = await ah.apis.DryRunApi.dry_run_call(
            { type: "system", value: { type: "Signed", value: from } },
            call.decodedCall,
            5,
          );
          if (!dr.success) {
            console.log(`  ${slip}%: dry-run unavailable: ${j(dr.value)}`);
            continue;
          }
          const effects = dr.value as {
            execution_result?: { success?: boolean; value?: unknown };
            emitted_events?: Event[];
            forwarded_xcms?: Array<[unknown, unknown[]]>;
          };
          if (effects.execution_result?.success === false) {
            console.log(
              `  ${slip}%: funding program would fail: ${j(effects.execution_result.value)}`,
            );
            continue;
          }
          // Native the program leaves in Asset Hub's asset trap: the unused PayFees earmark.
          let trapped = 0n;
          for (const ev of effects.emitted_events ?? []) {
            if (ev.type === "PolkadotXcm" && ev.value?.type === "AssetsTrapped") {
              const assets = (
                ev.value.value as { assets?: { value?: Array<{ fun?: { value?: bigint } }> } }
              ).assets?.value;
              for (const a of assets ?? []) trapped += BigInt(a.fun?.value ?? 0n);
            }
          }
          const fwd = effects.forwarded_xcms?.find(([d]) =>
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
            `  ${String(slip).padStart(4)}% slippage -> send ${fmtPas(deposit)} PAS (fees ${fmtPas(fees.dispatchNative + fees.payFeesNative)}, trapped ${fmtPas(trapped)}) -> LANDS ${fmtCash(landed)} CASH  ${landed >= settle ? "ok" : "SHORT"}  (over +${fmtCash(landed - settle)})`,
          );
        }
      }
    } finally {
      ahC.destroy();
      peC.destroy();
    }
  }, 180_000);
});
