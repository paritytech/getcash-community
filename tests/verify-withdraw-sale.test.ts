// Live check of the sale per token on Paseo Asset Hub next: the program People forwards for a
// withdrawal is built from a stand-in, as the sizing prices it, and dry run on Asset Hub for each
// token the destination can take. Nothing is signed and no key is needed. Prints what lands in
// each token. Needs network and is not part of CI:
//   VERIFY_WITHDRAW_SALE=1 pnpm vitest run tests/verify-withdraw-sale.test.ts

import { describe, expect, it } from "vitest";
import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import {
  depositTokenOf,
  destinationEarmark,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  STABLE_TOKENS,
} from "@getsome/funding";
import {
  ASSET_HUB_FEE_BUFFER_CASH,
  CASH_ON_ASSET_HUB,
  dryRunOnAssetHub,
  forwardedStandIn,
  PEOPLE_NATIVE,
  type Sale,
  type SaleRoute,
} from "@getsome/withdraw";

const fmtUnits = (v: bigint, decimals: number) => (Number(v) / 10 ** decimals).toFixed(6);
const toHex = (b: Uint8Array) =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
/** A funded Asset Hub account, so a native deposit clears the existential deposit. */
const DESTINATION = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
/** What a 5 CASH withdrawal carries by the time it reaches Asset Hub. */
const CASH_TO_TELEPORT = 5_000_000n;
const PAS_TRAVELLING = 700_000_000n;
const SLIPPAGE_PCT = 5;
const SALES: Array<[string, SaleRoute]> = [
  ["DOT", { tier: "pool" }],
  ["dotUSD", { tier: "teleport" }],
  ["USDT", { tier: "pool", external: "USDT" }],
  ["USDC", { tier: "pool", external: "USDC" }],
];

const lessHeadroom = (amount: bigint) => (amount * BigInt(100 - SLIPPAGE_PCT)) / 100n;

const fungible = (id: unknown, value: bigint) => ({ id, fun: { type: "Fungible", value } });
const cash = (v: bigint) => fungible(CASH_ON_ASSET_HUB, v);
const pas = (v: bigint) => fungible(PEOPLE_NATIVE, v);

/** The message as Asset Hub receives it: the stand-in's own program after a prefix that keys
 *  the teleported assets the way Asset Hub does, which People's forwarding does on the way. The
 *  list is sorted as the runtime demands, and CASH keyed local sorts before the native. */
function asAssetHubSeesIt(standIn: ReturnType<typeof forwardedStandIn>, earmark: bigint) {
  return {
    type: "V5",
    value: [
      { type: "ReceiveTeleportedAsset", value: [cash(earmark)] },
      { type: "PayFees", value: { asset: cash(earmark) } },
      { type: "ReceiveTeleportedAsset", value: [cash(CASH_TO_TELEPORT), pas(PAS_TRAVELLING)] },
      ...standIn.value.slice(3),
    ],
  };
}

describe.runIf(process.env.VERIFY_WITHDRAW_SALE === "1")("the sale per token on Asset Hub", () => {
  it("completes the forwarded program for every token and credits the destination in it", async () => {
    const client = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const api = client.getTypedApi(paseo_next_v2);
    const destinationHex = toHex(AccountId().enc(DESTINATION));
    const quote = async (give: unknown, want: unknown, amountIn: bigint) => {
      const out = await api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
        give as never,
        want as never,
        amountIn,
        true,
      );
      if (out === undefined) throw new Error("Asset Hub cannot quote the sale");
      return out;
    };
    try {
      for (const [name, route] of SALES) {
        // The floors as the sizing sets them: each hop's quote on the whole CASH less the headroom.
        let sale: Sale;
        if (route.tier === "teleport") {
          sale = { tier: "teleport" };
        } else {
          const native = await quote(CASH_ON_ASSET_HUB, PEOPLE_NATIVE, CASH_TO_TELEPORT);
          if (route.external === undefined) {
            sale = { tier: "pool", minNativeOut: lessHeadroom(native) };
          } else {
            const stable = await quote(
              PEOPLE_NATIVE,
              STABLE_TOKENS[route.external].location,
              native,
            );
            sale = {
              tier: "pool",
              external: route.external,
              minNativeOut: lessHeadroom(native),
              minOut: lessHeadroom(stable),
            };
          }
        }
        const earmark = destinationEarmark(CASH_TO_TELEPORT, ASSET_HUB_FEE_BUFFER_CASH);
        const forwarded = asAssetHubSeesIt(
          forwardedStandIn({
            cashToTeleport: CASH_TO_TELEPORT,
            pasToWithdraw: PAS_TRAVELLING,
            payFeesPas: 0n,
            remoteFeesCash: earmark,
            sale,
            destinationHex,
            claimerHex: destinationHex,
            assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
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
        const floor =
          sale.tier === "teleport"
            ? 1n
            : sale.external === undefined
              ? sale.minNativeOut
              : sale.minOut;
        console.log(
          `${name.padEnd(6)} ${fmtUnits(CASH_TO_TELEPORT, 6)} CASH lands ${fmtUnits(landed, token.decimals)} ${token.symbol}, floor ${fmtUnits(floor, token.decimals)}`,
        );
        expect(landed).toBeGreaterThanOrEqual(floor);
      }
    } finally {
      client.destroy();
    }
  }, 120_000);
});
