// Dry runs on Paseo next of what the recovery relies on: People runs the funding program unpaid
// and lands everything sent, and a program that leaves the CASH in the holding traps it under
// the key this app computes for the burner. Nothing is submitted and nothing is spent.
//   VERIFY_TRAP=1 pnpm vitest run tests/verify-trap.test.ts

import { describe, expect, it } from "vitest";
import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { TOKENS } from "@getsome/core";
import {
  buildDotUsdFundingProgram,
  chooseCashTransfer,
  dryRunFundingProgram,
  estimateDotUsdProgramFees,
  forwardedTo,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  siblingOrigin,
  signedOrigin,
  stableDepositNeeded,
  trapKey,
} from "@getsome/funding";

const SETTLE = 5_000_000n;
const units = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
/** JSON with bigints as strings, for the log. */
const json = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

type Instruction = { type: string; value?: unknown };

describe.runIf(process.env.VERIFY_TRAP === "1")(
  "the unpaid program and the trap key on Paseo next",
  () => {
    it("lands everything sent unpaid on People, and traps under the computed key when the deposit fails", async () => {
      const ahC = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
      const peC = createClient(getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ah: any = ahC.getTypedApi(paseo_next_v2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pe: any = peC.getTypedApi(paseo_people_next);
      try {
        const transfer = await chooseCashTransfer({
          assetHub: ahC,
          people: peC,
          assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
          peopleParaId: PASEO_PEOPLE_PARA_ID,
        });
        const token = TOKENS.DOTUSD;
        const holders = await ah.query.Assets.Account.getEntries(token.assetHubId);
        holders.sort((a: { value: { balance: bigint } }, b: { value: { balance: bigint } }) =>
          a.value.balance < b.value.balance ? 1 : -1,
        );
        const holder: string = holders[0].keyArgs[1];
        const holderHex = toHex(AccountId().enc(holder));
        console.log(`CASH moves by ${transfer}; holder ${holder} as its own beneficiary`);

        // The dotUSD program, sized as the app does: what it sends is exactly what lands.
        const fees = await estimateDotUsdProgramFees({
          api: ah,
          beneficiaryHex: holderHex,
          peopleParaId: PASEO_PEOPLE_PARA_ID,
          depositUnderlying: SETTLE,
          transfer,
          feeProbeAddress: holder,
          dryRunFrom: holder,
        });
        const asked = stableDepositNeeded(SETTLE, fees);
        const send = asked - fees.dispatchExternal - fees.heldBackExternal;
        const execArgs = buildDotUsdFundingProgram({
          withdrawUnderlying: send + fees.feeAllowanceExternal,
          payFeesUnderlying: fees.feeAllowanceExternal,
          beneficiaryHex: holderHex,
          peopleParaId: PASEO_PEOPLE_PARA_ID,
          transfer,
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
          mustLand: SETTLE,
        });
        console.log(`sent ${units(send)} CASH, landed ${units(landed)} CASH unpaid on People`);
        expect(landed).toBe(send);

        // The program People receives, with its deposit aimed at a location no account answers to:
        // the CASH stays in the holding and People traps it under the claimer the hint names.
        const call = ah.tx.PolkadotXcm.execute(execArgs).decodedCall;
        const dr = await ah.apis.DryRunApi.dry_run_call(signedOrigin(holder), call, 5);
        expect(dr.success && dr.value.execution_result.success).toBe(true);
        const forwarded = forwardedTo(dr.value, PASEO_PEOPLE_PARA_ID) as { value: Instruction[] };
        expect(forwarded.value.map((i) => i.type)).toEqual([
          transfer === "teleport" ? "ReceiveTeleportedAsset" : "ReserveAssetDeposited",
          "ClearOrigin",
          "UnpaidExecution",
          "SetHints",
          "DepositAsset",
          "SetTopic",
        ]);
        const nowhere = {
          parents: 0,
          interior: {
            type: "X1",
            value: { type: "Plurality", value: { id: { type: "Unit" }, part: { type: "Voice" } } },
          },
        };
        const trapping = {
          ...forwarded,
          value: forwarded.value.map((i) =>
            i.type === "DepositAsset"
              ? { ...i, value: { ...(i.value as object), beneficiary: nowhere } }
              : i,
          ),
        };
        const run = await pe.apis.DryRunApi.dry_run_xcm(
          siblingOrigin(PASEO_ASSET_HUB_PARA_ID),
          trapping,
        );
        expect(run.success).toBe(true);
        console.log(`trapping program ends with ${json(run.value.execution_result)}`);
        const trapped = run.value.emitted_events.find(
          (e: { type: string; value: { type: string } }) =>
            e.type === "PolkadotXcm" && e.value.type === "AssetsTrapped",
        );
        expect(trapped).toBeDefined();
        const { hash, origin, assets } = trapped.value.value;
        console.log(`trapped ${json(assets)} for ${json(origin)} under ${hash}`);
        expect(hash).toBe(await trapKey(holderHex, send));
      } finally {
        ahC.destroy();
        peC.destroy();
      }
    }, 600_000);
  },
);
