// Dry runs of the teleport tier's program on Paseo Asset Hub next, from the account richest in
// dotUSD and as its own beneficiary: nothing is submitted and nothing is spent. Sizes the deposit
// as the app does, builds the program the worker would submit, runs it on both chains, and prints
// the fees, what would land on People and the refund, for a few purchase sizes.
//   VERIFY_DOTUSD=1 pnpm vitest run tests/verify-dotusd.test.ts

import { describe, it } from "vitest";
import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { TOKENS } from "@getsome/core";
import {
  buildTeleportFundingProgram,
  destinationEarmark,
  discoverPool,
  dryRunFundingProgram,
  estimateDestinationFeeCash,
  estimateTeleportProgramFees,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  signedOrigin,
  stableDepositNeeded,
} from "@getsome/funding";

const AMOUNTS = (process.env.VERIFY_AMOUNTS_CASH ?? "5,20,50").split(",").map((v) => BigInt(v));
const units = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

describe.runIf(process.env.VERIFY_DOTUSD === "1")("teleport tier dry runs", () => {
  it("dry-runs the dotUSD teleport from a rich holder as its own beneficiary", async () => {
    const ahC = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const peC = createClient(getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ah: any = ahC.getTypedApi(paseo_next_v2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pe: any = peC.getTypedApi(paseo_people_next);
    try {
      const pool = await discoverPool(ah, PASEO_UNDERLYING_ASSET_ID);
      const token = TOKENS.DOTUSD;
      const holders = await ah.query.Assets.Account.getEntries(token.assetHubId);
      holders.sort((a: { value: { balance: bigint } }, b: { value: { balance: bigint } }) =>
        a.value.balance < b.value.balance ? 1 : -1,
      );
      const holder: string = holders[0].keyArgs[1];
      const holderHex = toHex(AccountId().enc(holder));
      console.log(`holder ${holder} holds ${units(holders[0].value.balance)} dotUSD`);

      for (const whole of AMOUNTS) {
        const settle = whole * 1_000_000n;
        const destinationFee = await estimateDestinationFeeCash({
          peopleApi: pe,
          pool,
          assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
          beneficiaryHex: holderHex,
          amount: settle,
          transfer: "teleport",
        });
        const buyTarget = settle + destinationFee;
        const earmark = destinationEarmark(buyTarget, destinationFee);
        const fees = await estimateTeleportProgramFees({
          api: ah,
          beneficiaryHex: holderHex,
          peopleParaId: PASEO_PEOPLE_PARA_ID,
          depositUnderlying: buyTarget,
          remoteFeesCash: earmark,
          transfer: "teleport",
          feeProbeAddress: holder,
          dryRunFrom: holder,
        });
        // Sized as the app does, then the program as the worker builds it once that has arrived.
        const asked = stableDepositNeeded(buyTarget, fees);
        const send = asked - fees.dispatchExternal - fees.heldBackExternal;
        const execArgs = buildTeleportFundingProgram({
          withdrawUnderlying: send + fees.feeAllowanceExternal,
          payFeesUnderlying: fees.feeAllowanceExternal,
          remoteFeesCash: earmark,
          beneficiaryHex: holderHex,
          peopleParaId: PASEO_PEOPLE_PARA_ID,
          transfer: "teleport",
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
        const call = ah.tx.PolkadotXcm.execute(execArgs).decodedCall;
        const dr = await ah.apis.DryRunApi.dry_run_call(signedOrigin(holder), call, 5);
        let refund = 0n;
        let exchanges = 0;
        for (const ev of dr.value?.emitted_events ?? []) {
          if (ev.type === "AssetConversion" && ev.value?.type === "SwapCreditExecuted") {
            exchanges += 1;
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
            `${units(settle)} CASH:`,
            `  ask ${units(asked)} dotUSD, destination fee ${destinationFee}, earmark ${earmark}`,
            `  fees local ${fees.localExternal} delivery ${fees.deliveryExternal} allowance ${fees.feeAllowanceExternal} dispatch ${fees.dispatchExternal} min_balance ${fees.minBalanceExternal}`,
            `  weight ${fees.maxWeight.ref_time} / ${fees.maxWeight.proof_size}, pool swaps for fees ${exchanges}`,
            `  refund ${refund}, landed ${units(landed)} CASH ${landed >= settle ? "ok" : "SHORT"}`,
          ].join("\n"),
        );
      }
    } finally {
      ahC.destroy();
      peC.destroy();
    }
  }, 600_000);
});
