// Live withdrawal sizing check: sizes both withdrawal transactions for a burner on People, to a
// funded Asset Hub address, through the same sizing and two-chain gate the worker will use, and
// prints what would move. Nothing is submitted. The XCM sizing needs PAS on the key, so it runs
// against the swap's expected outcome only when the key already holds PAS. Needs network, a
// burner label the on-ramp production proof printed, and is not part of CI:
//   VERIFY_WITHDRAW=1 WITHDRAW_BURNER=getcash-prod-proof-<ms> pnpm vitest run tests/verify-withdraw.test.ts

import { describe, expect, it } from "vitest";
import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { deriveKeypairWithSecret } from "@getsome/ephemeral";
import { PASEO_ASSET_HUB_PARA_ID, PASEO_PEOPLE_PARA_ID } from "@getsome/funding";
import { CASH_LOCATION } from "@getsome/people";
import { NeedsSwapError, PASEO_PEOPLE_POOL_ACCOUNT, sizeSwap, sizeXcm } from "@getsome/withdraw";

const fmtCash = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const fmtPas = (v: bigint) => (Number(v) / 1e10).toFixed(6);
const toHex = (b: Uint8Array) =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
/** Alice on Asset Hub: a funded account, so the deposit clears the existential deposit. */
const DESTINATION = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
/** The burner's entropy label, as the on-ramp production proof derives it. */
const BURNER_LABEL = process.env.WITHDRAW_BURNER;

describe.runIf(process.env.VERIFY_WITHDRAW === "1")("live withdrawal sizing", () => {
  it("sizes the swap, and the XCM when the key holds PAS, and proves the XCM on both chains", async () => {
    const ahC = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const peC = createClient(getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"));
    const assetHubApi = ahC.getTypedApi(paseo_next_v2);
    const peopleApi = peC.getTypedApi(paseo_people_next);
    try {
      if (!BURNER_LABEL) throw new Error("set WITHDRAW_BURNER to a burner label holding CASH");
      const entropy = new Uint8Array(32);
      new TextEncoder().encodeInto(BURNER_LABEL, entropy);
      const key = deriveKeypairWithSecret(entropy);
      const cashOnKey =
        (await peopleApi.query.Assets.Account.getValue(CASH_LOCATION as never, key.address))
          ?.balance ?? 0n;
      const pasOnKey =
        (await peopleApi.query.System.Account.getValue(key.address))?.data?.free ?? 0n;
      console.log(
        `key ${key.address} holds ${fmtCash(cashOnKey)} CASH and ${fmtPas(pasOnKey)} PAS on People`,
      );
      expect(cashOnKey).toBeGreaterThan(0n);

      const swap = await sizeSwap({
        peopleApi,
        key: { address: key.address, publicKeyHex: toHex(key.publicKey) },
        poolAccount: PASEO_PEOPLE_POOL_ACCOUNT,
        cashBalance: cashOnKey,
        destinationHex: toHex(AccountId().enc(DESTINATION)),
        assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
      });
      console.log(`swap: at most ${fmtCash(swap.cashInMax)} CASH -> ${fmtPas(swap.pasOut)} PAS`);
      expect(swap.cashInMax).toBeLessThan(cashOnKey);

      if (pasOnKey === 0n) {
        console.log("no PAS on the key: the XCM sizing needs the swap to have run");
        return;
      }
      const started = Date.now();
      const sizing = await sizeXcm({
        peopleApi,
        assetHubApi,
        key: { address: key.address, publicKeyHex: toHex(key.publicKey) },
        cashOnKey,
        pasOnKey,
        destinationHex: toHex(AccountId().enc(DESTINATION)),
        assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
        peopleParaId: PASEO_PEOPLE_PARA_ID,
        slippagePct: 5,
      }).catch((e: unknown) => {
        if (e instanceof NeedsSwapError) return null;
        throw e;
      });
      if (sizing === null) {
        console.log("the key's PAS cannot pay the XCM's fee and keep the deposit: swap first");
        return;
      }
      const { args } = sizing;
      console.log(`XCM sized in ${Date.now() - started}ms`);
      console.log(`  tx fee reserve: ${fmtPas(sizing.txFeePasReserved)} PAS, reaped as dust`);
      console.log(`  People XCM:     ${fmtPas(args.payFeesPas)} PAS exact allowance`);
      console.log(
        `  teleports:      ${fmtCash(args.cashToTeleport)} CASH + ${fmtPas(args.pasToWithdraw - args.payFeesPas)} PAS`,
      );
      console.log(
        `  AH earmark:     ${fmtCash(args.remoteFeesCash)} CASH, price floor ${fmtPas(args.minPasOut)} PAS`,
      );
      console.log(`  lands:          ${fmtPas(sizing.landed)} PAS at the destination`);
      console.log(`  max weight:     ${JSON.stringify(args.maxWeight, (_k, v) => String(v))}`);
      // Every unit of CASH leaves, and every PAS but the fee reserve.
      expect(args.cashToTeleport).toBe(cashOnKey);
      expect(args.pasToWithdraw + sizing.txFeePasReserved).toBe(pasOnKey);
      expect(sizing.landed).toBeGreaterThanOrEqual(args.minPasOut);
    } finally {
      ahC.destroy();
      peC.destroy();
    }
  }, 180_000);
});
