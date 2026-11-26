// The bridge leg over scripted hands: the order of the steps of each route, one transaction per
// run at most, the same signed bytes after a stop, and each ending.

import { describe, expect, it } from "vitest";
import {
  type BaseLegHands,
  BridgeLegEnded,
  type BridgeLegHands,
  type BridgeLegState,
  type BridgeLegStep,
  type BridgeMove,
  BridgeMoveRefused,
  bridgeTickOnce,
  freshBridgeLegState,
  type SnowbridgeLegHands,
} from "./leg";

interface MoveScript {
  /** How many asks after the send the chain needs to have the transaction. */
  minedAfter?: number;
  /** The transaction runs and fails. */
  fails?: boolean;
  /** The move must not make its transaction. */
  refuse?: string;
  /** How many times `prepare` fails before it works. */
  prepareFails?: number;
  /** How many times `send` fails before it works. */
  sendFails?: number;
}

/** A move on a chain that takes a signed transaction once and refuses the same bytes after. */
function fakeMove(name: string, log: string[], script: MoveScript = {}) {
  const onChain: string[] = [];
  let prepared = 0;
  let asked = 0;
  let prepareFails = script.prepareFails ?? 0;
  let sendFails = script.sendFails ?? 0;
  const move: BridgeMove = {
    async prepare() {
      log.push(`${name}: prepare`);
      if (script.refuse !== undefined) throw new BridgeMoveRefused(script.refuse);
      if (prepareFails-- > 0) throw new Error("the node did not answer");
      prepared += 1;
      return `${name}-tx-${prepared}`;
    },
    async send(text) {
      log.push(`${name}: send ${text}`);
      if (sendFails-- > 0) throw new Error("the node did not answer");
      if (onChain.includes(text)) throw new Error("already known");
      onChain.push(text);
    },
    async landed(text) {
      log.push(`${name}: landed?`);
      if (!onChain.includes(text)) return "not-yet";
      asked += 1;
      if (asked < (script.minedAfter ?? 1)) return "not-yet";
      return script.fails === true ? "failed" : "yes";
    },
  };
  return { move, onChain };
}

type Funding = Awaited<ReturnType<BridgeLegHands["funding"]>>;
type Arrival = Awaited<ReturnType<BridgeLegHands["arrival"]>>;

interface Script {
  funding?: Funding[];
  arrival?: Arrival[];
  minted?: boolean[];
  moves?: Partial<Record<BridgeLegStep, MoveScript>>;
}

function shared(log: string[], script: Script) {
  const funding = [...(script.funding ?? [])];
  const arrival = [...(script.arrival ?? [])];
  return {
    funding: async () => {
      log.push("funding?");
      return funding.shift() ?? "ready";
    },
    arrival: async () => {
      log.push("arrival?");
      return arrival.shift() ?? "usdt";
    },
  };
}

function snowbridge(script: Script = {}) {
  const log: string[] = [];
  const gateway = fakeMove("gateway", log, script.moves?.gateway);
  const hands: SnowbridgeLegHands = {
    route: "snowbridge",
    ...shared(log, script),
    gateway: gateway.move,
  };
  return { hands, log, gateway, state: freshBridgeLegState("snowbridge") };
}

function base(script: Script = {}) {
  const log: string[] = [];
  const minted = [...(script.minted ?? [])];
  const swap = fakeMove("swap", log, script.moves?.swap);
  const approve = fakeMove("approve", log, script.moves?.approve);
  const deposit = fakeMove("deposit", log, script.moves?.deposit);
  const permit = fakeMove("permit", log, script.moves?.permit);
  const hands: BaseLegHands = {
    route: "base",
    ...shared(log, script),
    swap: swap.move,
    approve: approve.move,
    deposit: deposit.move,
    minted: async () => {
      log.push("minted?");
      return minted.shift() ?? true;
    },
    permit: permit.move,
  };
  return { hands, log, swap, approve, deposit, permit, state: freshBridgeLegState("base") };
}

/** Runs the leg `times` times and gives the step after each run. */
async function run(hands: BridgeLegHands, state: BridgeLegState, times: number) {
  const steps: BridgeLegStep[] = [];
  for (let i = 0; i < times; i++) steps.push(await bridgeTickOnce(hands, state));
  return steps;
}

/** Runs the leg to its end. The state goes through JSON before each run, as a caller that
 *  saves it and reads it back does. */
async function runToEnd(hands: BridgeLegHands, start: BridgeLegState) {
  let state = start;
  const steps: BridgeLegStep[] = [];
  for (let i = 0; i < 100 && steps.at(-1) !== "done"; i++) {
    state = JSON.parse(JSON.stringify(state));
    steps.push(await bridgeTickOnce(hands, state));
  }
  return steps;
}

const ending = async (hands: BridgeLegHands, state: BridgeLegState) => {
  const error = await bridgeTickOnce(hands, state).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BridgeLegEnded);
  return (error as BridgeLegEnded).ending;
};

describe("bridgeTickOnce, the Snowbridge route", () => {
  it("waits for the funds, sends the one transaction and waits for the USDT", async () => {
    const { hands, log, state } = snowbridge({
      funding: ["waiting", "ready"],
      arrival: ["nothing", "usdt"],
    });
    expect(await run(hands, state, 8)).toEqual([
      "fund",
      "gateway",
      "gateway",
      "gateway",
      "arrive",
      "arrive",
      "done",
      "done",
    ]);
    expect(log).toEqual([
      "funding?",
      "funding?",
      "gateway: prepare",
      "gateway: landed?",
      "gateway: send gateway-tx-1",
      "gateway: landed?",
      "arrival?",
      "arrival?",
    ]);
  });

  it("sends nothing in the run that signs", async () => {
    const { hands, log, state, gateway } = snowbridge();
    await run(hands, state, 2);
    expect(log).toEqual(["funding?", "gateway: prepare"]);
    expect(gateway.onChain).toEqual([]);
    expect(state).toEqual({
      route: "snowbridge",
      step: "gateway",
      prepared: "gateway-tx-1",
      sent: false,
    });
  });

  it("sends the transaction once and then only waits for the chain", async () => {
    const { hands, log, state, gateway } = snowbridge({ moves: { gateway: { minedAfter: 3 } } });
    expect(await run(hands, state, 6)).toEqual([
      "gateway",
      "gateway",
      "gateway",
      "gateway",
      "gateway",
      "arrive",
    ]);
    expect(log.filter((line) => line.startsWith("gateway: send"))).toEqual([
      "gateway: send gateway-tx-1",
    ]);
    expect(gateway.onChain).toEqual(["gateway-tx-1"]);
    expect(state).toMatchObject({ step: "arrive", prepared: null, sent: false });
  });

  it("asks nothing when it is done", async () => {
    const { hands, log, state } = snowbridge();
    state.step = "done";
    expect(await bridgeTickOnce(hands, state)).toBe("done");
    expect(log).toEqual([]);
  });
});

describe("bridgeTickOnce, the Base route", () => {
  it("makes its transactions in order, each after the one before is on its chain", async () => {
    const { hands, log, state } = base({ minted: [false, false, true] });
    const steps = await runToEnd(hands, state);
    expect(steps.at(-1)).toBe("done");
    expect(log).toEqual([
      "funding?",
      "swap: prepare",
      "swap: landed?",
      "swap: send swap-tx-1",
      "swap: landed?",
      "approve: prepare",
      "approve: landed?",
      "approve: send approve-tx-1",
      "approve: landed?",
      "deposit: prepare",
      "deposit: landed?",
      "deposit: send deposit-tx-1",
      "deposit: landed?",
      "minted?",
      "minted?",
      "minted?",
      "permit: prepare",
      "permit: landed?",
      "permit: send permit-tx-1",
      "permit: landed?",
      "arrival?",
    ]);
  });

  it("sends at most one transaction in a run", async () => {
    const { hands, log, state } = base();
    let sends = 0;
    for (let i = 0; i < 40 && state.step !== "done"; i++) {
      await bridgeTickOnce(hands, state);
      const now = log.filter((line) => line.includes(": send")).length;
      expect(now - sends).toBeLessThanOrEqual(1);
      sends = now;
    }
    expect(state.step).toBe("done");
    expect(sends).toBe(4);
  });

  it("does not deposit when the move finds no room, and says so", async () => {
    const { hands, state, swap, approve, deposit } = base({
      moves: { deposit: { refuse: "the vault has no room for 50000000" } },
    });
    await run(hands, state, 7);
    expect(state.step).toBe("deposit");
    expect(await ending(hands, state)).toEqual({
      kind: "stopped",
      step: "deposit",
      reason: "the vault has no room for 50000000",
    });
    expect(swap.onChain).toEqual(["swap-tx-1"]);
    expect(approve.onChain).toEqual(["approve-tx-1"]);
    expect(deposit.onChain).toEqual([]);
    expect(state).toMatchObject({ step: "deposit", prepared: null, sent: false });
  });

  it("waits for the HOLLAR before it signs the permit", async () => {
    const { hands, log, state } = base({ minted: [false, false] });
    state.step = "mint";
    expect(await run(hands, state, 3)).toEqual(["mint", "mint", "permit"]);
    expect(log).toEqual(["minted?", "minted?", "minted?"]);
  });
});

describe("bridgeTickOnce, after a stop", () => {
  it("sends the bytes that the earlier run signed, and does not sign again", async () => {
    const first = snowbridge();
    await run(first.hands, first.state, 2);
    const saved: BridgeLegState = JSON.parse(JSON.stringify(first.state));

    const { hands, log, state } = { ...snowbridge(), state: saved };
    await bridgeTickOnce(hands, state);
    expect(log).toEqual(["gateway: landed?", "gateway: send gateway-tx-1"]);
    expect(state.sent).toBe(true);
  });

  it("does not send again a transaction that the chain already has", async () => {
    const { hands, log, state, gateway } = snowbridge();
    // The earlier run sent the transaction and stopped before the caller saved that.
    gateway.onChain.push("gateway-tx-1");
    Object.assign(state, { step: "gateway", prepared: "gateway-tx-1", sent: false });
    expect(await bridgeTickOnce(hands, state)).toBe("arrive");
    expect(log).toEqual(["gateway: landed?"]);
  });

  it("finds a transaction that was sent and is still in no block", async () => {
    const { hands, log, state, gateway } = snowbridge({ moves: { gateway: { minedAfter: 2 } } });
    gateway.onChain.push("gateway-tx-1");
    Object.assign(state, { step: "gateway", prepared: "gateway-tx-1", sent: false });
    // The node refuses the bytes it already has. The run throws and the next one finds them.
    await expect(bridgeTickOnce(hands, state)).rejects.toThrow("already known");
    expect(state).toMatchObject({ step: "gateway", prepared: "gateway-tx-1", sent: false });
    expect(await bridgeTickOnce(hands, state)).toBe("arrive");
    expect(gateway.onChain).toEqual(["gateway-tx-1"]);
    expect(log).toEqual(["gateway: landed?", "gateway: send gateway-tx-1", "gateway: landed?"]);
  });

  it("sends the same bytes again when the send failed", async () => {
    const { hands, log, state, gateway } = snowbridge({ moves: { gateway: { sendFails: 1 } } });
    await run(hands, state, 2);
    await expect(bridgeTickOnce(hands, state)).rejects.toThrow("the node did not answer");
    expect(state).toMatchObject({ prepared: "gateway-tx-1", sent: false });
    await bridgeTickOnce(hands, state);
    expect(state.sent).toBe(true);
    expect(gateway.onChain).toEqual(["gateway-tx-1"]);
    expect(log.filter((line) => line.includes("prepare"))).toHaveLength(1);
  });

  it("signs again when the run that signs failed", async () => {
    const { hands, log, state } = snowbridge({ moves: { gateway: { prepareFails: 1 } } });
    await run(hands, state, 1);
    await expect(bridgeTickOnce(hands, state)).rejects.toThrow("the node did not answer");
    expect(state).toMatchObject({ step: "gateway", prepared: null, sent: false });
    await bridgeTickOnce(hands, state);
    expect(state.prepared).toBe("gateway-tx-1");
    expect(log.filter((line) => line.includes(": send"))).toEqual([]);
  });
});

describe("bridgeTickOnce, the endings", () => {
  it.each<[Funding, string]>([
    ["refunded", "refunded"],
    ["failed", "funding-failed"],
  ])("ends when the funding is %s", async (funding, kind) => {
    const { hands, log, state } = snowbridge({ funding: ["waiting", funding] });
    await run(hands, state, 1);
    expect(await ending(hands, state)).toEqual({ kind });
    expect(state.step).toBe("fund");
    expect(log).toEqual(["funding?", "funding?"]);
  });

  it("ends when a transaction ran and failed", async () => {
    const { hands, state } = base({ moves: { approve: { fails: true } } });
    await run(hands, state, 6);
    expect(state).toMatchObject({ step: "approve", sent: true });
    expect(await ending(hands, state)).toEqual({ kind: "reverted", step: "approve" });
  });

  it("ends when the ether came back to Asset Hub", async () => {
    const { hands, state } = snowbridge({ arrival: ["nothing", "ether"] });
    state.step = "arrive";
    await run(hands, state, 1);
    expect(await ending(hands, state)).toEqual({ kind: "ether-returned" });
  });

  it("does not take the refusal of a move for a temporary error", async () => {
    const { hands, state, gateway } = snowbridge({
      moves: { gateway: { refuse: "the fees are over the limit" } },
    });
    await run(hands, state, 1);
    expect(await ending(hands, state)).toEqual({
      kind: "stopped",
      step: "gateway",
      reason: "the fees are over the limit",
    });
    expect(gateway.onChain).toEqual([]);
  });
});

describe("bridgeTickOnce, a state that does not fit", () => {
  it("refuses hands of another route and asks nothing", async () => {
    const { hands, log } = base();
    const state = freshBridgeLegState("snowbridge");
    await expect(bridgeTickOnce(hands, state)).rejects.toThrow(
      "the leg is of the snowbridge route, and the hands of base",
    );
    expect(log).toEqual([]);
  });

  it("refuses a step that the route does not have", async () => {
    const { hands, log, state } = snowbridge();
    state.step = "swap";
    const error = await bridgeTickOnce(hands, state).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(BridgeLegEnded);
    expect((error as Error).message).toBe("the snowbridge route has no step swap");
    expect(log).toEqual([]);
  });

  it("starts a new leg at the funding, with nothing signed", () => {
    expect(freshBridgeLegState("base")).toEqual({
      route: "base",
      step: "fund",
      prepared: null,
      sent: false,
    });
  });
});
