// Live check of the sale per token on Paseo Asset Hub next: the program People forwards for a
// withdrawal is priced and built as the sizing does it, and dry run on Asset Hub for each token
// the destination can take, the PSM redeem included. Nothing is signed and no key is needed.
// Prints what lands in each token. Needs network and is not part of CI:
//   VERIFY_WITHDRAW_SALE=1 pnpm vitest run tests/verify-withdraw-sale.test.ts

import { describe, expect, it } from "vitest";
import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import {
  chooseRoute,
  depositTokenOf,
  destinationEarmark,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  type ConversionRoute,
} from "@getsome/funding";
import {
  ASSET_HUB_FEE_BUFFER_CASH,
  CASH_ON_ASSET_HUB,
  dryRunOnAssetHub,
  forwardedStandIn,
  PEOPLE_NATIVE,
  priceSale,
  type Sale,
} from "@getsome/withdraw";

const fmtUnits = (v: bigint, decimals: number) => (Number(v) / 10 ** decimals).toFixed(6);
const toHex = (b: Uint8Array) =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
/** A funded Asset Hub account, so a native deposit clears the existential deposit. */
const DESTINATION = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
/** The key the XCM is signed by; only its origin matters here. */
const KEY_HEX = `0x${"07".repeat(32)}`;
/** What a 5 CASH withdrawal carries by the time it reaches Asset Hub. */
const CASH_TO_TELEPORT = 5_000_000n;
const PAS_TRAVELLING = 700_000_000n;
const SLIPPAGE_PCT = 5;

const fungible = (id: unknown, value: bigint) => ({ id, fun: { type: "Fungible", value } });
const cash = (v: bigint) => fungible(CASH_ON_ASSET_HUB, v);
const pas = (v: bigint) => fungible(PEOPLE_NATIVE, v);

/** The message as Asset Hub receives it: the stand-in's own program after a prefix that keys
 *  the teleported assets the way Asset Hub does, which People's forwarding does on the way. The
 *  earmark comes out of the CASH teleported and the rest travels. The list is sorted as the
 *  runtime demands, and CASH keyed local sorts before the native. */
function asAssetHubSeesIt(standIn: ReturnType<typeof forwardedStandIn>, earmark: bigint) {
  return {
    type: "V5",
    value: [
      { type: "ReceiveTeleportedAsset", value: [cash(earmark)] },
      { type: "PayFees", value: { asset: cash(earmark) } },
      {
        type: "ReceiveTeleportedAsset",
        value: [cash(CASH_TO_TELEPORT - earmark), pas(PAS_TRAVELLING)],
      },
      ...standIn.value.slice(3),
    ],
  };
}

/** The floor the program holds the sale to, in the landing asset. */
const floorOf = (sale: Sale): bigint => {
  if (sale.tier === "teleport") return 1n;
  if (sale.tier === "psm") return sale.externalOut;
  return sale.external === undefined ? sale.minNativeOut : sale.minOut;
};

describe.runIf(process.env.VERIFY_WITHDRAW_SALE === "1")("the sale per token on Asset Hub", () => {
  it("completes the forwarded program for every token and credits the destination in it", async () => {
    const client = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const api = client.getTypedApi(paseo_next_v2);
    const destinationHex = toHex(AccountId().enc(DESTINATION));
    try {
      // The routes as the page decides them: USDT through the PSM when it can serve, and the
      // pool for the same token so both sales are proven.
      const usdt = await chooseRoute(api, {
        direction: "redeem",
        internalAmount: CASH_TO_TELEPORT,
        deposit: "USDT",
      });
      const routes: Array<[string, ConversionRoute]> = [
        ["DOT", { tier: "pool" }],
        ["dotUSD", { tier: "teleport" }],
        [`USDT ${usdt.tier}`, usdt],
        ["USDT pool", { tier: "pool", external: "USDT" }],
        ["USDC", { tier: "pool", external: "USDC" }],
      ];
      for (const [name, route] of routes) {
        const earmark = destinationEarmark(CASH_TO_TELEPORT, ASSET_HUB_FEE_BUFFER_CASH);
        const sale = await priceSale({
          assetHubApi: api,
          route,
          cashOnKey: CASH_TO_TELEPORT,
          remoteFeesCash: earmark,
          slippagePct: SLIPPAGE_PCT,
          originHex: KEY_HEX,
          peopleParaId: PASEO_PEOPLE_PARA_ID,
        });
        const forwarded = asAssetHubSeesIt(
          forwardedStandIn({
            cashToTeleport: CASH_TO_TELEPORT,
            pasToWithdraw: PAS_TRAVELLING,
            payFeesPas: 0n,
            remoteFeesCash: earmark,
            sale,
            destinationHex,
            claimerHex: destinationHex,
            originHex: KEY_HEX,
            assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
            peopleParaId: PASEO_PEOPLE_PARA_ID,
          }),
          earmark,
        );
        const landed = await dryRunOnAssetHub(
          api,
          PASEO_PEOPLE_PARA_ID,
          forwarded,
          destinationHex,
          route,
        );
        const token = depositTokenOf(route);
        const floor = floorOf(sale);
        console.log(
          `${name.padEnd(10)} ${fmtUnits(CASH_TO_TELEPORT, 6)} CASH teleported with ${fmtUnits(PAS_TRAVELLING, 10)} PAS lands ${fmtUnits(landed, token.decimals)} ${token.symbol}, floor ${fmtUnits(floor, token.decimals)}`,
        );
        expect(landed).toBeGreaterThanOrEqual(floor);
      }
    } finally {
      client.destroy();
    }
  }, 120_000);
});
