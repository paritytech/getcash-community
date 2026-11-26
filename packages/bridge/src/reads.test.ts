// The checks of the two routes over scripted reads: when a route is open, what the top-up needs
// on it, and which answer each state and each failed read becomes.

import { describe, expect, it } from "vitest";
import type { VaultState } from "./base/vault";
import {
  askBase,
  askSnowbridge,
  type BaseAsk,
  type Delivery,
  type DeliveryAnswer,
  type SnowbridgeAsk,
} from "./reads";
import type { SnowbridgeCosts } from "./snowbridge/amounts";
import { accountClaimer } from "./snowbridge/program";
import type { SnowbridgeMessage } from "./snowbridge/wrapper";

const CASH = 1_000_000n;
const WEI = 10n ** 18n;
const GWEI = 1_000_000_000n;
const ACCOUNT = `0x${"42".repeat(32)}`;
const KEY = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
/** The fee of each kind that the trial message carries. */
const TRIAL_FEE = 1_000_000_000_000_000n;

const COSTS: SnowbridgeCosts = {
  assetHubExecution: 1_169_966_505_745n,
  hydrationDelivery: 12_530_707_914_008n,
  hydrationExecution: 34_600_000_000_000n,
  depositUsdt: 757n,
  depositEther: 439_000_000_000n,
  etherMinimum: 15_000_000_000_000n,
  bridgeHubDelivery: 12_850_000_000_000n,
  relayerTransaction: 9_815_000_000_000n,
};

/** A provider that gives one answer, and what it was asked. */
function provider(answer: DeliveryAnswer | Error = { kind: "open", pays: 0n, paysLeast: 0n }) {
  const asked: bigint[] = [];
  const delivery: Delivery = async (wei) => {
    asked.push(wei);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { delivery, asked };
}

const PAID: DeliveryAnswer = { kind: "open", pays: 205_480_000n, paysLeast: 203_440_000n };

describe("askSnowbridge", () => {
  /** A world where the pool on Hydration pays `poolPrice` USDT units for 1 ETH. */
  function world(change: Partial<SnowbridgeAsk> = {}, poolPrice = 1_690_000_000n) {
    const trials: SnowbridgeMessage[] = [];
    const near = provider(PAID);
    const ask: SnowbridgeAsk = {
      amountCash: 200n * CASH,
      account: ACCOUNT,
      sender: KEY,
      refusal: async () => null,
      gas: async () => ({ baseFee: 2n * GWEI, tip: GWEI / 10n }),
      trial: async (message) => {
        trials.push(message);
        const swapped = message.value - 2n * TRIAL_FEE;
        return { costs: COSTS, usdtOut: (swapped * poolPrice) / WEI };
      },
      delivery: near.delivery,
      usdtPerEther: 1_700_000_000n,
      maxBaseFee: 30n * GWEI,
      maxLossBps: 100n,
      toleranceBps: 100n,
      ...change,
    };
    return { ask, trials, near };
  }

  it("tries the ether that is worth the amount and the loss limit", async () => {
    const { ask, trials } = world();
    await askSnowbridge(ask);
    expect(trials).toHaveLength(1);
    // 202 USDT at 1,700 USDT for 1 ETH.
    const trialEther = (202n * CASH * WEI) / 1_700_000_000n;
    expect(trials[0]).toMatchObject({
      sender: KEY,
      value: trialEther + 2n * TRIAL_FEE,
      executionFee: TRIAL_FEE,
      claimer: accountClaimer(ACCOUNT),
    });
  });

  it("is open with a swap that pays the amount and the fee of its deposit", async () => {
    const { ask, near } = world();
    const answer = await askSnowbridge(ask);
    if (answer.kind !== "open") throw new Error(`not open: ${JSON.stringify(answer)}`);
    const offer = answer.value;
    expect(offer.route).toBe("snowbridge");
    expect(offer.minimumUsdt).toBe(200n * CASH + 2n * 757n);
    expect(offer.sizing.program.minimumUsdt).toBe(offer.minimumUsdt);
    expect(offer.sizing.program.account).toBe(ACCOUNT);
    // At the pool's price the swap pays the minimum, and the tolerance of 1% on top of it.
    const pays = (offer.sizing.program.swapEther * 1_690_000_000n) / WEI;
    expect(pays).toBeGreaterThanOrEqual((offer.minimumUsdt * 10_100n) / 10_000n);
    expect(pays).toBeLessThan((offer.minimumUsdt * 10_101n) / 10_000n);
    // The pool pays 1,690 where the outside price is 1,700.
    expect(offer.lossBps).toBe(58n);
    expect(offer.payment).toEqual({ pays: 205_480_000n, paysLeast: 203_440_000n });
    expect(near.asked).toEqual([offer.ethNeeded]);
  });

  it("needs on the key what the Gateway takes and the gas of its call", async () => {
    const { ask } = world();
    const answer = await askSnowbridge(ask);
    if (answer.kind !== "open") throw new Error("not open");
    const { ethNeeded, sizing } = answer.value;
    expect(ethNeeded).toBe(sizing.total + 150_000n * (4n * GWEI + GWEI / 10n));
  });

  it("is open with no payment when the user sends the ETH", async () => {
    const { ask } = world({ delivery: null });
    const answer = await askSnowbridge(ask);
    expect(answer).toMatchObject({ kind: "open", value: { route: "snowbridge", payment: null } });
  });

  it("is closed, and tries nothing, when Snowbridge takes no message", async () => {
    const { ask, trials, near } = world({
      refusal: async () => "the Gateway takes no messages now",
    });
    expect(await askSnowbridge(ask)).toEqual({
      kind: "closed",
      reason: "the Gateway takes no messages now",
    });
    expect(trials).toEqual([]);
    expect(near.asked).toEqual([]);
  });

  it("is closed when the base fee of Ethereum is over the cap, and open at the cap", async () => {
    const over = world({ gas: async () => ({ baseFee: 30n * GWEI + 1n, tip: 1n }) });
    expect(await askSnowbridge(over.ask)).toEqual({
      kind: "closed",
      reason: "the base fee of Ethereum is 30000000001 wei",
    });
    expect(over.trials).toEqual([]);
    const at = world({ gas: async () => ({ baseFee: 30n * GWEI, tip: 1n }) });
    expect((await askSnowbridge(at.ask)).kind).toBe("open");
  });

  it("is closed when the swap loses more than the limit", async () => {
    // The pool pays 1,680 where the outside price is 1,700: a loss of 1.18%.
    const { ask, near } = world({}, 1_680_000_000n);
    const answer = await askSnowbridge(ask);
    expect(answer).toEqual({
      kind: "closed",
      reason: "the swap on Hydration pays 199623529 USDT units for ether worth 202000000",
    });
    expect(near.asked).toEqual([]);
  });

  it("is open when the swap of the trial pays the minimum to the unit", async () => {
    const minimum = 200n * CASH + 2n * 757n;
    const exact = world({ trial: async () => ({ costs: COSTS, usdtOut: minimum }) });
    expect((await askSnowbridge(exact.ask)).kind).toBe("open");
    const under = world({ trial: async () => ({ costs: COSTS, usdtOut: minimum - 1n }) });
    expect((await askSnowbridge(under.ask)).kind).toBe("closed");
  });

  it.each<[string, Partial<SnowbridgeAsk>]>([
    [
      "the read of the operating modes",
      {
        refusal: async () => {
          throw new Error("no answer");
        },
      },
    ],
    [
      "the read of the gas",
      {
        gas: async () => {
          throw new Error("no answer");
        },
      },
    ],
    [
      "the trial",
      {
        trial: async () => {
          throw new Error("no answer");
        },
      },
    ],
  ])("gives no answer of the route when %s fails, and does not ask the provider", async (_n, c) => {
    const { ask, near } = world(c);
    expect(await askSnowbridge(ask)).toEqual({
      kind: "no-answer",
      from: "route",
      reason: "no answer",
    });
    expect(near.asked).toEqual([]);
  });

  it("is closed for an amount so small that the fee of its deposit is over the loss limit", async () => {
    const { ask, near } = world({ amountCash: 10n });
    expect(await askSnowbridge(ask)).toMatchObject({ kind: "closed" });
    expect(near.asked).toEqual([]);
  });

  it.each<[string, DeliveryAnswer | Error, unknown]>([
    [
      "a closed provider",
      { kind: "closed", reason: "No liquidity available" },
      { kind: "closed", reason: "No liquidity available" },
    ],
    [
      "a silent provider",
      { kind: "no-answer", reason: "HTTP 503" },
      { kind: "no-answer", from: "provider", reason: "HTTP 503" },
    ],
    [
      "a provider that throws",
      new Error("not a function"),
      { kind: "no-answer", from: "provider", reason: "not a function" },
    ],
    [
      "a minimum in dollars",
      { kind: "too-small", minimumUsd: 100 },
      { kind: "too-small", minimumCash: 100n * CASH },
    ],
    [
      "a minimum in dollars and cents",
      { kind: "too-small", minimumUsd: 12.345678901 },
      { kind: "too-small", minimumCash: 12_345_679n },
    ],
    [
      "a minimum with no figure",
      { kind: "too-small" },
      { kind: "closed", reason: "the amount is under the provider's minimum" },
    ],
  ])("turns %s into the answer of the route", async (_name, provided, answer) => {
    const { ask } = world({ delivery: provider(provided).delivery });
    expect(await askSnowbridge(ask)).toEqual(answer);
  });

  it("turns a minimum in wei into CASH in proportion to what was asked", async () => {
    const open = await askSnowbridge(world().ask);
    if (open.kind !== "open") throw new Error("not open");
    const { ethNeeded } = open.value;
    // The provider's minimum is three times what the 200 CASH needed, and one wei more.
    const { ask } = world({
      delivery: provider({ kind: "too-small", minimumWei: 3n * ethNeeded + 1n }).delivery,
    });
    expect(await askSnowbridge(ask)).toEqual({ kind: "too-small", minimumCash: 600n * CASH + 1n });
  });
});

describe("askBase", () => {
  const OPEN: VaultState = {
    depositsPaused: false,
    depositAllowance: 1_000_000n * CASH,
    mintPaused: false,
    mintHeadroom: 1_000_000n * CASH,
    usdcPrice: 100_000_000n,
    minUsdcPrice: 99_000_000n,
    messageFee: 7n,
  };
  /** The USDC of a top-up of 50 CASH: 1% on top, and the fees. */
  const USDC = 50_500_000n + 200_000n;

  function world(change: Partial<BaseAsk> = {}) {
    const quoted: bigint[] = [];
    const near = provider(PAID);
    const ask: BaseAsk = {
      amountCash: 50n * CASH,
      vault: async () => OPEN,
      ethFor: async (usdc) => {
        quoted.push(usdc);
        return 30_000_000_000_000_000n;
      },
      gas: async () => ({ baseFee: 10_000_000n, tip: 1_000_000n }),
      dataFee: async () => 2_000_000_000n,
      delivery: near.delivery,
      marginBps: 100n,
      roomMarginBps: 1_000n,
      toleranceBps: 100n,
      ...change,
    };
    return { ask, quoted, near };
  }

  it("deposits the amount, its margin and the fees, and asks the pool for that USDC", async () => {
    const { ask, quoted } = world();
    const answer = await askBase(ask);
    expect(answer).toMatchObject({ kind: "open", value: { route: "base", usdc: USDC } });
    expect(quoted).toEqual([USDC]);
  });

  it("needs on the key the ETH to swap, the gas, the data of three transactions and the fee of the message", async () => {
    const { ask, near } = world();
    const answer = await askBase(ask);
    if (answer.kind !== "open") throw new Error("not open");
    const swap = 30_300_000_000_000_000n;
    const gas = 900_000n * 21_000_000n;
    expect(answer.value.ethNeeded).toBe(swap + gas + 3n * 2_000_000_000n + 7n);
    expect(near.asked).toEqual([answer.value.ethNeeded]);
    expect(answer.value.payment).toEqual({ pays: 205_480_000n, paysLeast: 203_440_000n });
  });

  it("rounds the margin up", async () => {
    const { ask } = world({ amountCash: 50n * CASH + 1n });
    expect(await askBase(ask)).toMatchObject({ value: { usdc: USDC + 2n } });
  });

  it("is open when the room covers the deposit and its margin to the unit", async () => {
    const room = (USDC * 11n) / 10n;
    const exact = world({ vault: async () => ({ ...OPEN, mintHeadroom: room }) });
    expect((await askBase(exact.ask)).kind).toBe("open");
    const short = world({ vault: async () => ({ ...OPEN, depositAllowance: room - 1n }) });
    expect(await askBase(short.ask)).toEqual({
      kind: "closed",
      reason: `the vault has room for ${room - 1n} and the top-up needs ${room}`,
    });
    expect(short.near.asked).toEqual([]);
    expect(short.quoted).toEqual([]);
  });

  it.each<[string, Partial<VaultState>, string]>([
    ["the vault is paused", { depositsPaused: true }, "the vault takes no deposits now"],
    ["Hydration mints nothing", { mintPaused: true }, "Hydration mints no HOLLAR now"],
    [
      "USDC is under the vault's price",
      { usdcPrice: 98_999_999n },
      "USDC is under the price the vault accepts",
    ],
  ])("is closed when %s", async (_name, state, reason) => {
    const { ask, near } = world({ vault: async () => ({ ...OPEN, ...state }) });
    expect(await askBase(ask)).toEqual({ kind: "closed", reason });
    expect(near.asked).toEqual([]);
  });

  it.each<[string, Partial<BaseAsk>]>([
    [
      "the read of the vault",
      {
        vault: async () => {
          throw new Error("no answer");
        },
      },
    ],
    [
      "the quote of the pool",
      {
        ethFor: async () => {
          throw new Error("no answer");
        },
      },
    ],
    [
      "the read of the gas",
      {
        gas: async () => {
          throw new Error("no answer");
        },
      },
    ],
    [
      "the read of the data fee",
      {
        dataFee: async () => {
          throw new Error("no answer");
        },
      },
    ],
  ])("gives no answer of the route when %s fails, and does not ask the provider", async (_n, c) => {
    const { ask, near } = world(c);
    expect(await askBase(ask)).toEqual({ kind: "no-answer", from: "route", reason: "no answer" });
    expect(near.asked).toEqual([]);
  });

  it("gives the provider's silence as the provider's, so that the chooser stops", async () => {
    const { ask } = world({
      delivery: provider({ kind: "no-answer", reason: "HTTP 503" }).delivery,
    });
    expect(await askBase(ask)).toEqual({ kind: "no-answer", from: "provider", reason: "HTTP 503" });
  });

  it("turns the provider's dollar minimum into CASH", async () => {
    const { ask } = world({ delivery: provider({ kind: "too-small", minimumUsd: 100 }).delivery });
    expect(await askBase(ask)).toEqual({ kind: "too-small", minimumCash: 100n * CASH });
  });
});
