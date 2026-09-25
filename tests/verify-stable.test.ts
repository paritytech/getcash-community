// Dry runs of the stable pool tier's program on Paseo Asset Hub next, from the account richest in
// the stable and as its own beneficiary: nothing is submitted and nothing is spent. Sizes the
// deposit as the app does, builds the program the worker would submit, runs it on both chains, and
// prints what would land on People, both exchanges and the refund, for a few purchase sizes.
//   VERIFY_STABLE=1 pnpm vitest run tests/verify-stable.test.ts

import { describe, it } from "vitest";
import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import {
  buildStableFundingProgram,
  DEFAULT_SLIPPAGE_PCT,
  destinationEarmark,
  discoverPool,
  dryRunFundingProgram,
  estimateDestinationFeeCash,
  estimateStableProgramFees,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  quoteNativeOut,
  quoteStableForUnderlying,
  signedOrigin,
  STABLE_TOKENS,
  stableDepositNeeded,
  type Stable,
} from "@getsome/funding";

const STABLES: Stable[] = ["USDC", "USDT"];
/** CASH to ask for, whole units. */
const AMOUNTS = (process.env.VERIFY_AMOUNTS_CASH ?? "5,20,50").split(",").map((v) => BigInt(v));
const cash = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const stable = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const pas = (v: bigint) => (Number(v) / 1e10).toFixed(6);
const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

describe.runIf(process.env.VERIFY_STABLE === "1")("stable pool tier dry runs", () => {
  it("dry-runs the USDC and USDT programs from a rich holder as its own beneficiary", async () => {
    const ahC = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const peC = createClient(getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ah: any = ahC.getTypedApi(paseo_next_v2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pe: any = peC.getTypedApi(paseo_people_next);
    try {
      const pool = await discoverPool(ah, PASEO_UNDERLYING_ASSET_ID);
      for (const name of STABLES) {
        const token = STABLE_TOKENS[name];
        const stablePool = await discoverPool(ah, token.assetHubId);
        // The richest holder stands in for the burner and for the beneficiary.
        const holders = await ah.query.Assets.Account.getEntries(token.assetHubId);
        holders.sort((a: { value: { balance: bigint } }, b: { value: { balance: bigint } }) =>
          a.value.balance < b.value.balance ? 1 : -1,
        );
        const holder: string = holders[0].keyArgs[1];
        const holderHex = toHex(AccountId().enc(holder));
        console.log(`\n${name}: holder ${holder} holds ${stable(holders[0].value.balance)}`);

        for (const whole of AMOUNTS) {
          const settle = whole * 1_000_000n;
          const destinationFee = await estimateDestinationFeeCash({
            peopleApi: pe,
            pool,
            assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
            beneficiaryHex: holderHex,
            amount: settle,
          });
          const buyTarget = settle + destinationFee;
          const earmark = destinationEarmark(buyTarget, destinationFee);
          // Sized as the app does: the plain two-hop quote is the gate, the ask carries the
          // headroom once.
          const { nativeIn, stableIn } = await quoteStableForUnderlying(
            ah,
            pool,
            stablePool,
            buyTarget,
          );
          const stableInMax = (stableIn * BigInt(10_000 + DEFAULT_SLIPPAGE_PCT * 100)) / 10_000n;
          const fees = await estimateStableProgramFees({
            api: ah,
            stable: name,
            stablePool,
            pool,
            beneficiaryHex: holderHex,
            peopleParaId: PASEO_PEOPLE_PARA_ID,
            depositStable: stableInMax,
            minUnderlyingOut: buyTarget,
            remoteFeesCash: earmark,
            feeProbeAddress: holder,
            dryRunFrom: holder,
          });
          const asked = stableDepositNeeded(stableInMax, fees);
          const gate = stableDepositNeeded(stableIn, fees);
          // The program as the worker builds it once `asked` has arrived.
          const spend = asked - fees.dispatchExternal - fees.heldBackExternal;
          const nativeOut = await quoteNativeOut(ah, stablePool, spend);
          if (nativeOut === null) throw new Error(`${name}: the stable pool cannot take ${spend}`);
          const minNativeOut = (nativeOut * BigInt(10_000 - DEFAULT_SLIPPAGE_PCT * 100)) / 10_000n;
          const execArgs = buildStableFundingProgram({
            stablePool,
            pool,
            withdrawStable: spend + fees.feeAllowanceExternal,
            payFeesStable: fees.feeAllowanceExternal,
            minNativeOut,
            minUnderlyingOut: buyTarget,
            remoteFeesCash: earmark,
            beneficiaryHex: holderHex,
            peopleParaId: PASEO_PEOPLE_PARA_ID,
            maxWeight: fees.maxWeight,
          });
          const { landed } = await dryRunFundingProgram({
            api: ah,
            peopleApi: pe,
            execArgs,
            from: holder,
            beneficiaryHex: holderHex,
            peopleParaId: PASEO_PEOPLE_PARA_ID,
            assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
            mustLand: settle,
          });
          // The same dry run once more, for the exchanges and the refund it reports.
          const call = ah.tx.PolkadotXcm.execute(execArgs).decodedCall;
          const dr = await ah.apis.DryRunApi.dry_run_call(signedOrigin(holder), call, 5);
          const swaps: string[] = [];
          let refund = 0n;
          for (const ev of dr.value?.emitted_events ?? []) {
            if (ev.type === "AssetConversion" && ev.value?.type === "SwapCreditExecuted") {
              swaps.push(`${ev.value.value.amount_in} -> ${ev.value.value.amount_out}`);
            }
            if (
              ev.type === "Assets" &&
              ev.value?.type === "Deposited" &&
              ev.value.value.asset_id === token.assetHubId &&
              ev.value.value.who === holder
            ) {
              refund = ev.value.value.amount;
            }
          }
          console.log(
            [
              `${name} ${cash(settle)} CASH:`,
              `  quote ${stable(stableIn)} ${name} for ${pas(nativeIn)} PAS, gate ${stable(gate)}, ask ${stable(asked)}`,
              `  fees local ${fees.localExternal} delivery ${fees.deliveryExternal} dispatch ${fees.dispatchExternal} (${pas(fees.dispatchNative)} PAS) min_balance ${fees.minBalanceExternal}`,
              `  weight ${fees.maxWeight.ref_time} / ${fees.maxWeight.proof_size}`,
              `  swaps ${swaps.join(" | ")}`,
              `  refund ${refund} ${name}, landed ${cash(landed)} CASH ${landed >= settle ? "ok" : "SHORT"}`,
            ].join("\n"),
          );
        }
      }
    } finally {
      ahC.destroy();
      peC.destroy();
    }
  }, 600_000);
});
