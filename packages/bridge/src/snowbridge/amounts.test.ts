// The sizing of a Snowbridge top-up. The costs below are real reads of the live chains.

import { describe, expect, it } from "vitest";
import { sizeSnowbridgeTopUp, type SnowbridgeCosts } from "./amounts";
import { snowbridgeProgram } from "./program";

const ACCOUNT = `0x${"42".repeat(32)}`;

const COSTS: SnowbridgeCosts = {
  assetHubExecution: 1_169_966_505_745n,
  hydrationDelivery: 12_530_707_914_008n,
  hydrationExecution: 34_622_646_012_343n,
  depositUsdt: 757n,
  depositEther: 439_497_861_055n,
  etherMinimum: 15_000_000_000_000n,
  bridgeHubDelivery: 12_846_579_360_187n,
  relayerTransaction: 9_809_513_428_701n,
};

const SWAP = 50_000_000_000_000_000n;
const MINIMUM = 85_000_000n;

const size = (change: Partial<Parameters<typeof sizeSnowbridgeTopUp>[0]> = {}) =>
  sizeSnowbridgeTopUp({
    costs: COSTS,
    account: ACCOUNT,
    swapEther: SWAP,
    minimumUsdt: MINIMUM,
    ...change,
  });

describe("sizeSnowbridgeTopUp", () => {
  it("pays Asset Hub three times its price for the message and its delivery to Hydration", () => {
    expect(size().executionFee).toBe(41_102_023_259_259n);
  });

  it("pays the relayer its two costs and 30% more, rounded down", () => {
    expect(size().relayerFee).toBe(29_452_920_625_554n);
  });

  it("pays Hydration twice its price", () => {
    expect(size().program.hydrationFeeEther).toBe(69_245_292_024_686n);
  });

  it("pays the deposit on Asset Hub 100 times its price, in USDT and in ether", () => {
    expect(size().program.assetHubFeeUsdt).toBe(75_700n);
    expect(size().program.assetHubFeeEther).toBe(43_949_786_105_500n);
  });

  it("carries the ether to swap, the Hydration fee and the minimum balance", () => {
    const sizing = size();
    expect(sizing.value).toBe(SWAP + 69_245_292_024_686n + 15_000_000_000_000n);
    expect(sizing.total).toBe(sizing.executionFee + sizing.relayerFee + sizing.value);
    // All the ether a top-up costs on top of what it swaps: 0.000155 ETH.
    expect(sizing.total - SWAP).toBe(154_800_235_909_499n);
  });

  it("gives the program its account, its ether and its minimum as they came", () => {
    const { program } = size();
    expect(program).toMatchObject({ account: ACCOUNT, swapEther: SWAP, minimumUsdt: MINIMUM });
    expect(() => snowbridgeProgram(program)).not.toThrow();
  });

  it("costs the same on top of the swap for any amount", () => {
    const small = size();
    const large = size({ swapEther: 100n * SWAP });
    expect(large.total - 100n * SWAP).toBe(small.total - SWAP);
  });

  it("refuses ether that does not cover the fee of its own way back", () => {
    expect(size({ swapEther: 43_949_786_105_501n }).program.swapEther).toBe(43_949_786_105_501n);
    expect(() => size({ swapEther: 43_949_786_105_500n })).toThrow("its own way back");
  });

  it("refuses a minimum of USDT that does not cover the fee of its deposit", () => {
    expect(size({ minimumUsdt: 75_701n }).program.minimumUsdt).toBe(75_701n);
    expect(() => size({ minimumUsdt: 75_700n })).toThrow("fee of its deposit");
  });

  it.each(Object.keys(COSTS) as (keyof SnowbridgeCosts)[])("refuses no %s", (name) => {
    expect(() => size({ costs: { ...COSTS, [name]: 0n } })).toThrow(`${name} must be more`);
  });
});
