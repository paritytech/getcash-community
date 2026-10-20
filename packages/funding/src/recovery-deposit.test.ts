// The manual path's figures over a scripted Asset Hub: the least of each token for the fee, as
// the pipeline's gate would take it, and which balance on the burner counts as the deposit.

import { TOKENS } from "@getsome/core";
import { describe, expect, it } from "vitest";
import { withFeeMargin } from "./funding-program";
import { psmDepositNeeded, stableDepositNeeded, withHeadroom } from "./pipeline";
import { sizePsmMint, type PsmRoute } from "./psm-batch";
import {
  findRecoveryDeposit,
  recoveryCandidates,
  recoveryMinimums,
  recoveryTokenOf,
} from "./recovery-deposit";
import type { ConversionRoute } from "./route";

const FEE_CASH = 15_000n;
const NATIVE_LOC = { parents: 1, interior: { type: "Here" } };
const CASH_POOL = { native: NATIVE_LOC, underlying: TOKENS.CASH.location } as never;
const USDT_POOL = { native: NATIVE_LOC, underlying: TOKENS.USDT.location } as never;
const USDC_POOL = { native: NATIVE_LOC, underlying: TOKENS.USDC.location } as never;
/** Native per unit of CASH or stable on the scripted pools. */
const RATE = 1_000n;
const MIN_BALANCE = 70_000n;
const DISPATCH_NATIVE = 1_000n;
const LOCAL_FEE = 100n;
const DELIVERY_FEE = 10n;
const PSM_ROUTE: PsmRoute = { tier: "psm", external: "USDT", feeRate: 5_000 };
const USDC_ROUTE: ConversionRoute = { tier: "pool", external: "USDC" };
const ROUTES = { USDT: PSM_ROUTE as ConversionRoute, USDC: USDC_ROUTE };

const isNative = (loc: unknown) =>
  (loc as { parents: number; interior: { type: string } }).parents === 1 &&
  (loc as { interior: { type: string } }).interior.type === "Here";

/** Asset Hub as the sizing reads it: fixed-rate quotes, one min_balance, flat fees. */
function scriptedAssetHub(balances: {
  native?: bigint;
  usdt?: bigint;
  usdc?: bigint;
  cash?: bigint;
}) {
  const tx = (args: unknown) => ({
    decodedCall: { type: "call", value: args },
    getEstimatedFees: async () => DISPATCH_NATIVE,
  });
  return {
    query: {
      Assets: {
        Asset: { getValue: async () => ({ min_balance: MIN_BALANCE }) },
        Account: {
          getValue: async (id: number) => {
            const held =
              id === TOKENS.USDT.assetHubId
                ? balances.usdt
                : id === TOKENS.USDC.assetHubId
                  ? balances.usdc
                  : balances.cash;
            return held === undefined ? undefined : { balance: held };
          },
        },
      },
      System: { Account: { getValue: async () => ({ data: { free: balances.native ?? 0n } }) } },
    },
    apis: {
      AssetConversionApi: {
        // Native for an exact amount of CASH or a stable, or a stable for an exact native.
        quote_price_tokens_for_exact_tokens: async (give: unknown, _want: unknown, out: bigint) =>
          isNative(give) ? out * RATE : out / RATE,
      },
      XcmPaymentApi: {
        query_xcm_weight: async () => ({
          success: true,
          value: { ref_time: 1_000_000n, proof_size: 1_000n },
        }),
        query_weight_to_asset_fee: async () => ({ success: true, value: LOCAL_FEE }),
        query_delivery_fees: async () => ({
          success: true,
          value: { value: [{ fun: { type: "Fungible", value: DELIVERY_FEE } }] },
        }),
      },
    },
    tx: {
      PolkadotXcm: { execute: tx },
      Psm: { mint: tx },
      Utility: { batch_all: tx },
    },
  } as never;
}

const sizing = (api: unknown, pools: Partial<{ pool: unknown; USDT: unknown; USDC: unknown }>) =>
  recoveryMinimums({
    api: api as never,
    peopleParaId: 1004,
    feeCash: FEE_CASH,
    transfer: "teleport",
    beneficiaryHex: `0x${"07".repeat(32)}`,
    probeAddress: "5Burner",
    pool: (pools.pool ?? null) as never,
    stablePools: {
      ...(pools.USDT === undefined ? {} : { USDT: pools.USDT as never }),
      ...(pools.USDC === undefined ? {} : { USDC: pools.USDC as never }),
    },
    routes: ROUTES,
  });

/** Every program's own fees in the token it pays them in: the dispatch priced through the pool,
 *  the measured execution and delivery, one cushion over all three. */
const feesHeld = MIN_BALANCE + withFeeMargin(DISPATCH_NATIVE / RATE + LOCAL_FEE + DELIVERY_FEE);

describe("recoveryMinimums", () => {
  it("prices each token as the pipeline's gate takes it: the quote for the fee, the min_balance, the cushioned fees", async () => {
    const sized = await sizing(scriptedAssetHub({}), {
      pool: CASH_POOL,
      USDT: USDT_POOL,
      USDC: USDC_POOL,
    });
    // The native: the headroomed quote plus what the program keeps for its own fees.
    const nativeInMax = withHeadroom(FEE_CASH * RATE, 1);
    const keep = LOCAL_FEE + DELIVERY_FEE + DISPATCH_NATIVE;
    expect(sized.keepNativeForFees).toBe(keep);
    expect(sized.minimums.PAS).toBe(nativeInMax + keep);
    // dotUSD: the fee itself, with what the program holds back.
    expect(sized.minimums.DOTUSD).toBe(FEE_CASH + feesHeld);
    // USDT through the PSM: the mint that pays out the fee, with the same.
    expect(sized.minimums.USDT).toBe(sizePsmMint(FEE_CASH, PSM_ROUTE).externalIn + feesHeld);
    expect(sized.minimums.USDT).toBe(
      psmDepositNeeded(FEE_CASH, PSM_ROUTE, {
        dispatchExternal: DISPATCH_NATIVE / RATE,
        localExternal: LOCAL_FEE,
        deliveryExternal: DELIVERY_FEE,
        minBalanceExternal: MIN_BALANCE,
      }),
    );
    // USDC through the pools: the headroomed two-hop quote, with the same.
    const stableInMax = withHeadroom(FEE_CASH, 1);
    expect(sized.minimums.USDC).toBe(stableInMax + feesHeld);
    expect(sized.minimums.USDC).toBe(
      stableDepositNeeded(stableInMax, {
        dispatchExternal: DISPATCH_NATIVE / RATE,
        localExternal: LOCAL_FEE,
        deliveryExternal: DELIVERY_FEE,
        minBalanceExternal: MIN_BALANCE,
      }),
    );
  });

  it("leaves a token the chain cannot price without a figure, and the rest priced", async () => {
    const sized = await sizing(scriptedAssetHub({}), { USDT: USDT_POOL });
    expect(sized.minimums.PAS).toBeNull();
    expect(sized.keepNativeForFees).toBeNull();
    expect(sized.minimums.USDC).toBeNull();
    expect(sized.minimums.DOTUSD).toBe(FEE_CASH + feesHeld);
    expect(sized.minimums.USDT).toBe(sizePsmMint(FEE_CASH, PSM_ROUTE).externalIn + feesHeld);
  });
});

describe("recoveryCandidates and findRecoveryDeposit", () => {
  const minimums = { PAS: 50n, DOTUSD: null, USDT: 90_000n, USDC: 80_000n };

  it("lists the priced tokens with their routes, the native first", () => {
    expect(recoveryCandidates(minimums, ROUTES)).toEqual([
      { route: { tier: "pool" }, minimum: 50n },
      { route: PSM_ROUTE, minimum: 90_000n },
      { route: USDC_ROUTE, minimum: 80_000n },
    ]);
  });

  it("takes the first token held at or above its figure, and not what a stable tier left behind", async () => {
    const candidates = recoveryCandidates(minimums, ROUTES);
    // The min_balance and the unspent allowance of the top-up that trapped: not a deposit.
    expect(
      await findRecoveryDeposit(
        scriptedAssetHub({ usdt: MIN_BALANCE + 5n }),
        "5Burner",
        candidates,
      ),
    ).toBeNull();
    expect(
      await findRecoveryDeposit(
        scriptedAssetHub({ usdt: MIN_BALANCE + 5n, usdc: 80_000n }),
        "5Burner",
        candidates,
      ),
    ).toEqual({ route: USDC_ROUTE, held: 80_000n });
    expect(
      await findRecoveryDeposit(
        scriptedAssetHub({ native: 50n, usdc: 80_000n }),
        "5Burner",
        candidates,
      ),
    ).toEqual({ route: { tier: "pool" }, held: 50n });
  });

  it("names the token a route is fed with", () => {
    expect(recoveryTokenOf({ tier: "pool" })).toBe("PAS");
    expect(recoveryTokenOf({ tier: "dotusd" })).toBe("DOTUSD");
    expect(recoveryTokenOf(PSM_ROUTE)).toBe("USDT");
    expect(recoveryTokenOf(USDC_ROUTE)).toBe("USDC");
  });
});
