// The manual way to fund a recovery: a deposit on the burner's Asset Hub account, in any token a
// top-up takes, that the funding pipeline turns into at least the claim's fee in CASH on People.
//
// What the user is asked to send is the pipeline's own gate run forward with the fee as the
// target, as the app sizes a top-up: the quote for the fee, the min_balance a stable keeps on the
// burner, and one cushion over every fee the program pays. The program's fees are measured
// against a probe carved from a deposit a little above the quote, since the estimators refuse a
// probe that cannot cover its own fees. The pipeline converts whatever lands, so what the fee
// does not take reaches the purse with the recovered CASH.
//
// A stable tier leaves its min_balance and the unspent allowance on the burner, so a balance
// alone does not say a deposit was made: the deposit is the first token held at or above what
// was asked for it.

import type { CashTransfer } from "./cash-transfer";
import {
  destinationEarmark,
  estimateDotUsdProgramFees,
  estimateFundingProgramFees,
  estimateStableProgramFees,
  type Pool,
} from "./funding-program";
import {
  DEFAULT_REMOTE_FEE_BUFFER,
  DEFAULT_SLIPPAGE_PCT,
  psmDepositNeeded,
  quoteNativeInMax,
  quoteStableForUnderlying,
  readDeposit,
  stableDepositNeeded,
  withHeadroom,
} from "./pipeline";
import { estimatePsmBatchFees, sizePsmMint } from "./psm-batch";
import type { ConversionRoute } from "./route";
import { STABLE_TOKENS, type Stable } from "./stable";

type AssetHubApi = Parameters<typeof readDeposit>[0];

/** The tokens a recovery deposit may be made in, by their token-table name. */
export type RecoveryToken = "PAS" | "DOTUSD" | Stable;

export interface RecoveryMinimums {
  /** The least of each token, in its base units, that clears the pipeline's gate for the fee;
   *  null for a token the chain cannot price today. */
  minimums: Record<RecoveryToken, bigint | null>;
  /** The native the pool tier keeps for the program's own fees, which its gate takes; null when
   *  the native could not be priced. */
  keepNativeForFees: bigint | null;
}

/** What a probe carries above the quote so the estimators can carve their fees from it. */
const PROBE_NATIVE = 1_000_000_000n;
const PROBE_UNITS = 1_000_000n;

const priced = async (read: () => Promise<bigint>): Promise<bigint | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/** The least of each token to send so the pipeline lands at least `feeCash` on People. */
export async function recoveryMinimums(args: {
  api: AssetHubApi;
  peopleParaId: number;
  feeCash: bigint;
  transfer: CashTransfer;
  beneficiaryHex: string;
  probeAddress: string;
  /** The native/CASH pool; null when the chain has none. */
  pool: Pool | null;
  /** Each stable's native pool, where the chain has one. */
  stablePools: Partial<Record<Stable, Pool>>;
  /** The route each stable takes, as decided for the fee. */
  routes: Record<Stable, ConversionRoute>;
}): Promise<RecoveryMinimums> {
  const { api, feeCash, pool } = args;
  const common = {
    api,
    beneficiaryHex: args.beneficiaryHex,
    peopleParaId: args.peopleParaId,
    transfer: args.transfer,
    feeProbeAddress: args.probeAddress,
    // The destination fee allowance the pipeline will carry for a buy of the fee.
    remoteFeesCash: destinationEarmark(feeCash, DEFAULT_REMOTE_FEE_BUFFER),
  };
  let keepNativeForFees: bigint | null = null;
  const native = await priced(async () => {
    if (pool === null) throw new Error("no native pool");
    const nativeInMax = await quoteNativeInMax(api, pool, feeCash, DEFAULT_SLIPPAGE_PCT);
    const fees = await estimateFundingProgramFees({
      ...common,
      pool,
      nativeBalance: nativeInMax + PROBE_NATIVE,
      minUnderlyingOut: feeCash,
    });
    keepNativeForFees = fees.payFeesNative + fees.dispatchNative;
    return nativeInMax + keepNativeForFees;
  });
  const dotUsd = await priced(async () => {
    const fees = await estimateDotUsdProgramFees({
      ...common,
      depositUnderlying: feeCash + PROBE_UNITS,
    });
    return stableDepositNeeded(feeCash, fees);
  });
  const stable = (name: Stable) =>
    priced(async () => {
      const route = args.routes[name];
      if (route.tier === "psm") {
        const fees = await estimatePsmBatchFees({
          ...common,
          route,
          depositExternal: sizePsmMint(feeCash, route).externalIn + PROBE_UNITS,
        });
        return psmDepositNeeded(feeCash, route, fees);
      }
      const stablePool = args.stablePools[name];
      if (pool === null || stablePool === undefined) throw new Error(`no pool for ${name}`);
      const { nativeIn, stableIn } = await quoteStableForUnderlying(api, pool, stablePool, feeCash);
      const stableInMax = withHeadroom(stableIn, DEFAULT_SLIPPAGE_PCT);
      const fees = await estimateStableProgramFees({
        ...common,
        stable: name,
        stablePool,
        pool,
        depositStable: stableInMax + PROBE_UNITS,
        minNativeOut: nativeIn,
        minUnderlyingOut: feeCash,
      });
      return stableDepositNeeded(stableInMax, fees);
    });
  return {
    minimums: {
      PAS: native,
      DOTUSD: dotUsd,
      USDT: await stable("USDT"),
      USDC: await stable("USDC"),
    },
    keepNativeForFees,
  };
}

/** The routes a recovery deposit can take, each with the least of its token that counts as the
 *  deposit; a token without a figure cannot be taken. */
export function recoveryCandidates(
  minimums: RecoveryMinimums["minimums"],
  routes: Record<Stable, ConversionRoute>,
): Array<{ route: ConversionRoute; minimum: bigint }> {
  const candidates: Array<[ConversionRoute, bigint | null]> = [
    [{ tier: "pool" }, minimums.PAS],
    [{ tier: "dotusd" }, minimums.DOTUSD],
    ...(Object.keys(STABLE_TOKENS) as Stable[]).map((name): [ConversionRoute, bigint | null] => [
      routes[name],
      minimums[name],
    ]),
  ];
  return candidates.flatMap(([route, minimum]) => (minimum === null ? [] : [{ route, minimum }]));
}

/** The deposit on the burner's Asset Hub account, if one was made: the first token held at or
 *  above what was asked for it, read at the latest block, with its route. */
export async function findRecoveryDeposit(
  api: AssetHubApi,
  address: string,
  candidates: ReadonlyArray<{ route: ConversionRoute; minimum: bigint }>,
): Promise<{ route: ConversionRoute; held: bigint } | null> {
  for (const { route, minimum } of candidates) {
    const held = await readDeposit(api, route, address, "best");
    if (held >= minimum) return { route, held };
  }
  return null;
}

/** The token-table name of the token a route is fed with. */
export function recoveryTokenOf(route: ConversionRoute): RecoveryToken {
  if (route.tier === "dotusd") return "DOTUSD";
  return route.external ?? "PAS";
}
