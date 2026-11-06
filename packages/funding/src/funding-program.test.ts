import { describe, expect, it } from "vitest";
import { estimateFundingProgramFees, withFeeMargin } from "./funding-program";

// The estimator prices the delivery fee on the program the chain really forwards, which it gets
// from a dry run of a probe. The probe pays its own fees from an allowance; one that runs short
// forwards nothing, and the stand-in message that then stands in is not the real one's size.

const NATIVE_LOC = { parents: 1, interior: { type: "Here" } };
const POOL = {
  native: NATIVE_LOC,
  underlying: { parents: 0, interior: { type: "X1", value: { type: "GeneralIndex", value: 1n } } },
};
const LOCAL = 21_000_000n;
const DISPATCH = 17_000_000n;
/** What the chain charges to deliver the real forwarded message, and what it says for the
 *  stand-in: a byte apart, as they were on Paseo. */
const REAL_DELIVERY = 308_400_000n;
const STAND_IN_DELIVERY = 307_850_000n;
const REAL = { marker: "the real forwarded program" };

/** An Asset Hub api whose probe dry run forwards the real program only when the probe's fee
 *  allowance covers what the chain charges, and whose delivery fee tells the two messages apart. */
function scriptedApi() {
  const probes: bigint[] = [];
  const priced: unknown[] = [];
  const execute = (args: unknown) => ({
    decodedCall: { type: "PolkadotXcm", value: { type: "execute", value: args } },
    getEstimatedFees: async () => DISPATCH,
  });
  const api = {
    tx: { PolkadotXcm: { execute } },
    apis: {
      XcmPaymentApi: {
        query_xcm_weight: async () => ({
          success: true,
          value: { ref_time: 1_000n, proof_size: 10n },
        }),
        query_weight_to_asset_fee: async () => ({ success: true, value: LOCAL }),
        query_delivery_fees: async (_dest: unknown, message: unknown) => {
          priced.push(message);
          const fee = message === REAL ? REAL_DELIVERY : STAND_IN_DELIVERY;
          return { success: true, value: { value: [{ fun: { type: "Fungible", value: fee } }] } };
        },
      },
      DryRunApi: {
        dry_run_call: async (_origin: unknown, call: unknown) => {
          const message = (
            call as { value: { value: { message: { value: Array<{ value: unknown }> } } } }
          ).value.value.message.value;
          const allowance = (message[1]!.value as { asset: { fun: { value: bigint } } }).asset.fun
            .value;
          probes.push(allowance);
          if (allowance < LOCAL + REAL_DELIVERY) {
            // Short of fees at the send: nothing is forwarded.
            return {
              success: true,
              value: { execution_result: { success: false }, forwarded_xcms: [] },
            };
          }
          const dest = {
            type: "V5",
            value: {
              parents: 1,
              interior: { type: "X1", value: { type: "Parachain", value: 1502 } },
            },
          };
          return {
            success: true,
            value: { execution_result: { success: true }, forwarded_xcms: [[dest, [REAL]]] },
          };
        },
      },
    },
  };
  return { api, probes, priced };
}

const estimate = (api: unknown, nativeBalance: bigint) =>
  estimateFundingProgramFees({
    api: api as never,
    pool: POOL as never,
    beneficiaryHex: `0x${"11".repeat(32)}`,
    peopleParaId: 1502,
    nativeBalance,
    minUnderlyingOut: 8_799n,
    remoteFeesCash: 1_000n,
    transfer: "teleport",
    feeProbeAddress: "burner",
    dryRunFrom: "burner",
  });

/** The allowance a probe pays its fees from when a quarter of the balance is not enough. */
const SIZED = withFeeMargin(LOCAL + STAND_IN_DELIVERY);

describe("estimateFundingProgramFees", () => {
  it("probes with a quarter of a top-up's balance and prices the delivery on the real forwarded program", async () => {
    const { api, probes, priced } = scriptedApi();
    const fees = await estimate(api, 44_900_000_000n);
    expect(probes).toEqual([44_900_000_000n / 4n]);
    expect(priced).toHaveLength(2);
    expect(priced[1]).toBe(REAL);
    expect(fees.deliveryNative).toBe(REAL_DELIVERY);
    expect(fees.payFeesNative).toBe(LOCAL + REAL_DELIVERY);
  });

  it("probes with the stand-in's fees and the margin when a quarter of a small balance runs short", async () => {
    const { api, probes, priced } = scriptedApi();
    const fees = await estimate(api, 1_000_000_000n);
    expect(SIZED).toBeGreaterThan(1_000_000_000n / 4n);
    expect(probes).toEqual([SIZED]);
    expect(priced[1]).toBe(REAL);
    expect(fees.deliveryNative).toBe(REAL_DELIVERY);
    expect(fees.payFeesNative).toBe(LOCAL + REAL_DELIVERY);
  });

  it("keeps the stand-in's figure without a probe when that allowance would not leave anything to exchange", async () => {
    const { api, probes, priced } = scriptedApi();
    const fees = await estimate(api, 350_000_000n);
    expect(SIZED).toBeGreaterThanOrEqual(350_000_000n);
    expect(probes).toEqual([]);
    expect(priced).toHaveLength(1);
    expect(fees.deliveryNative).toBe(STAND_IN_DELIVERY);
  });
});
