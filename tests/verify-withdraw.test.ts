// Live withdrawal sizing check: sizes both withdrawal transactions for a burner on People, to a
// funded Asset Hub address, through the same sizing and two-chain gate the worker will use, and
// prints what would move. Nothing is submitted. The XCM sizing needs PAS on the key, so it runs
// against the swap's expected outcome only when the key already holds PAS. Needs network, a
// burner label the on-ramp production proof printed, and is not part of CI:
//   VERIFY_WITHDRAW=1 WITHDRAW_BURNER=getcash-prod-proof-<ms> pnpm vitest run tests/verify-withdraw.test.ts
// WITHDRAW_ASSET picks what lands: dot (the default), dotusd, usdt or usdc. A stable's sale is
// decided as the page decides it, the PSM when it can serve and the pool otherwise.

import { describe, expect, it } from "vitest";
import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { deriveKeypairWithSecret } from "@getsome/ephemeral";
import {
  chooseRoute,
  depositTokenOf,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  type DepositAsset,
} from "@getsome/funding";
import { CASH_LOCATION } from "@getsome/people";
import { NeedsSwapError, PASEO_PEOPLE_POOL_ACCOUNT, sizeSwap, sizeXcm } from "@getsome/withdraw";

const fmtCash = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const fmtPas = (v: bigint) => (Number(v) / 1e10).toFixed(6);
const fmtUnits = (v: bigint, decimals: number) => (Number(v) / 10 ** decimals).toFixed(6);
const toHex = (b: Uint8Array) =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
/** Alice on Asset Hub: a funded account, so the deposit clears the existential deposit. */
const DESTINATION = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
/** The burner's entropy label, as the on-ramp production proof derives it. */
const BURNER_LABEL = process.env.WITHDRAW_BURNER;
const LANDINGS: Record<string, DepositAsset> = {
  dot: "native",
  dotusd: "dotUSD",
  usdt: "USDT",
  usdc: "USDC",
};
const LANDING = LANDINGS[process.env.WITHDRAW_ASSET ?? "dot"];

describe.runIf(process.env.VERIFY_WITHDRAW === "1")("live withdrawal sizing", () => {
  it("sizes the swap, and the XCM when the key holds PAS, and proves the XCM on both chains", async () => {
    const ahC = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const peC = createClient(getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"));
    const assetHubApi = ahC.getTypedApi(paseo_next_v2);
    const peopleApi = peC.getTypedApi(paseo_people_next);
    try {
      if (!BURNER_LABEL) throw new Error("set WITHDRAW_BURNER to a burner label holding CASH");
      if (LANDING === undefined) {
        throw new Error("WITHDRAW_ASSET must be dot, dotusd, usdt or usdc");
      }
      const entropy = new Uint8Array(32);
      new TextEncoder().encodeInto(BURNER_LABEL, entropy);
      const key = deriveKeypairWithSecret(entropy);
      const cashOnKey =
        (await peopleApi.query.Assets.Account.getValue(CASH_LOCATION as never, key.address))
          ?.balance ?? 0n;
      const pasOnKey =
        (await peopleApi.query.System.Account.getValue(key.address))?.data?.free ?? 0n;
      expect(cashOnKey).toBeGreaterThan(0n);
      const route =
        LANDING === "native"
          ? { tier: "pool" as const }
          : LANDING === "dotUSD"
            ? { tier: "teleport" as const }
            : await chooseRoute(assetHubApi, {
                direction: "redeem",
                internalAmount: cashOnKey,
                deposit: LANDING,
              });
      const token = depositTokenOf(route);
      console.log(
        `key ${key.address} holds ${fmtCash(cashOnKey)} CASH and ${fmtPas(pasOnKey)} PAS on People; lands ${token.symbol} through ${JSON.stringify(route)}`,
      );

      const swap = await sizeSwap({
        peopleApi,
        key: { address: key.address, publicKeyHex: toHex(key.publicKey) },
        poolAccount: PASEO_PEOPLE_POOL_ACCOUNT,
        cashBalance: cashOnKey,
        destinationHex: toHex(AccountId().enc(DESTINATION)),
        assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
        peopleParaId: PASEO_PEOPLE_PARA_ID,
        sale: route,
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
        sale: route,
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
      const { sale } = args;
      console.log(`XCM sized in ${Date.now() - started}ms`);
      console.log(`  tx fee reserve: ${fmtPas(sizing.txFeePasReserved)} PAS, reaped as dust`);
      console.log(`  People XCM:     ${fmtPas(args.payFeesPas)} PAS exact allowance`);
      console.log(
        `  teleports:      ${fmtCash(args.cashToTeleport)} CASH + ${fmtPas(args.pasToWithdraw - args.payFeesPas)} PAS`,
      );
      console.log(`  AH earmark:     ${fmtCash(args.remoteFeesCash)} CASH`);
      let floor = 1n;
      if (sale.tier === "pool") {
        console.log(`  price floor:    ${fmtPas(sale.minNativeOut)} PAS`);
        floor = sale.minNativeOut;
        if (sale.external !== undefined) {
          console.log(`  then at least:  ${fmtUnits(sale.minOut, 6)} ${sale.external}`);
          floor = sale.minOut;
        }
      } else if (sale.tier === "psm") {
        console.log(
          `  PSM redeem:     ${fmtCash(sale.redeemAmount)} CASH -> ${fmtUnits(sale.externalOut, 6)} ${sale.external} at ${sale.feeRate} ppm`,
        );
        floor = sale.externalOut;
      } else {
        console.log("  no sale: the CASH lands as dotUSD");
      }
      console.log(
        `  lands:          ${fmtUnits(sizing.landed, token.decimals)} ${token.symbol} at the destination`,
      );
      console.log(`  max weight:     ${JSON.stringify(args.maxWeight, (_k, v) => String(v))}`);
      // Every unit of CASH leaves, and every PAS but the fee reserve.
      expect(args.cashToTeleport).toBe(cashOnKey);
      expect(args.pasToWithdraw + sizing.txFeePasReserved).toBe(pasOnKey);
      // What lands clears the floor the program holds the sale to.
      expect(sizing.landed).toBeGreaterThanOrEqual(floor);
    } finally {
      ahC.destroy();
      peC.destroy();
    }
  }, 180_000);
});
