// The bridge leg of a top-up: from the payment of the user to USDT on the request's account on
// Asset Hub. It is a step function. Each run does at most one thing that cannot be undone: it
// sends one transaction, or none. The state is the caller's to save between runs, and a run that
// throws can be run again.
//
// A step that sends a transaction takes three runs or more. The first signs the transaction and
// sends nothing, so that the caller saves the signed bytes before they leave. The next sends
// those bytes. The runs after that wait for the chain. A run after a stop asks the chain first
// and sends the same bytes again only when the chain does not have them. The same signed
// transaction can run once only, so a step never pays twice.
//
// The leg does not know the chains. The caller gives it hands: the reads and the transactions of
// the route.

import type { BridgeRoute } from "./route";

/** The steps of the leg. `gateway` is of the Snowbridge route. `swap`, `approve`, `deposit`,
 *  `mint` and `permit` are of the Base route. */
export type BridgeLegStep =
  "fund" | "gateway" | "swap" | "approve" | "deposit" | "mint" | "permit" | "arrive" | "done";

/** One transaction of the leg. */
export interface BridgeMove {
  /** Builds and signs the transaction from live reads, and sends nothing. A later run needs only
   *  the text it returns to send the transaction and to find it. It throws `BridgeMoveRefused`
   *  when the transaction must not be made. */
  prepare(): Promise<string>;
  /** Hands the prepared transaction to its chain. */
  send(prepared: string): Promise<void>;
  /** What the chain has of the prepared transaction: it ran, it ran and failed, or nothing. */
  landed(prepared: string): Promise<"yes" | "failed" | "not-yet">;
}

/** A move found, before it signed, that its transaction must not be made. */
export class BridgeMoveRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BridgeMoveRefused";
  }
}

interface SharedHands {
  /** Where the ETH for the key is: on the key, on its way, returned to the user, or lost in a
   *  swap that the provider says failed. */
  funding(): Promise<"ready" | "waiting" | "refunded" | "failed">;
  /** What reached the request's account on Asset Hub: the USDT, the ether of a swap that failed
   *  on Hydration, or nothing yet. */
  arrival(): Promise<"usdt" | "ether" | "nothing">;
}

export interface SnowbridgeLegHands extends SharedHands {
  route: "snowbridge";
  /** The message to the Gateway, with the ether. */
  gateway: BridgeMove;
}

export interface BaseLegHands extends SharedHands {
  route: "base";
  /** ETH to USDC. */
  swap: BridgeMove;
  /** The vault may take the USDC. */
  approve: BridgeMove;
  /** The USDC goes into the vault. The move reads the room of the vault first. */
  deposit: BridgeMove;
  /** Whether the HOLLAR of the deposit is on the key's account on Hydration. */
  minted(): Promise<boolean>;
  /** HOLLAR to USDT, and the USDT to Asset Hub. */
  permit: BridgeMove;
}

export type BridgeLegHands = SnowbridgeLegHands | BaseLegHands;

/** The memory of the leg between runs. It is plain data, and `bridgeTickOnce` changes it. */
export interface BridgeLegState {
  route: BridgeRoute;
  step: BridgeLegStep;
  /** The signed transaction of the step, from the run that prepared it. */
  prepared: string | null;
  /** The prepared transaction was handed to its chain. */
  sent: boolean;
}

export const freshBridgeLegState = (route: BridgeRoute): BridgeLegState => ({
  route,
  step: "fund",
  prepared: null,
  sent: false,
});

/** Why a leg ended with no USDT on the request's account. */
export type BridgeLegEnding =
  /** The provider sent the payment back to the user. Nothing reached the key. */
  | { kind: "refunded" }
  /** The provider says its swap failed. Nothing reached the key. */
  | { kind: "funding-failed" }
  /** A move must not send its transaction. What the earlier steps moved is on the key. */
  | { kind: "stopped"; step: BridgeLegStep; reason: string }
  /** A transaction ran and failed on its chain. What it was to move is on the key. */
  | { kind: "reverted"; step: BridgeLegStep }
  /** The swap on Hydration failed. The ether is on the request's account on Asset Hub. */
  | { kind: "ether-returned" };

/** The leg ended, and to run it again does not help. */
export class BridgeLegEnded extends Error {
  constructor(readonly ending: BridgeLegEnding) {
    super(`the bridge leg ended: ${ending.kind}`);
    this.name = "BridgeLegEnded";
  }
}

/** A part of a route: a wait that says when the leg can go on, or a transaction. */
type Stage =
  | { step: BridgeLegStep; ready: () => Promise<boolean> }
  | { step: BridgeLegStep; move: BridgeMove };

function stagesOf(hands: BridgeLegHands): Stage[] {
  const fund: Stage = {
    step: "fund",
    ready: async () => {
      const funding = await hands.funding();
      if (funding === "refunded") throw new BridgeLegEnded({ kind: "refunded" });
      if (funding === "failed") throw new BridgeLegEnded({ kind: "funding-failed" });
      return funding === "ready";
    },
  };
  const arrive: Stage = {
    step: "arrive",
    ready: async () => {
      const arrival = await hands.arrival();
      if (arrival === "ether") throw new BridgeLegEnded({ kind: "ether-returned" });
      return arrival === "usdt";
    },
  };
  if (hands.route === "snowbridge") return [fund, { step: "gateway", move: hands.gateway }, arrive];
  return [
    fund,
    { step: "swap", move: hands.swap },
    { step: "approve", move: hands.approve },
    { step: "deposit", move: hands.deposit },
    { step: "mint", ready: () => hands.minted() },
    { step: "permit", move: hands.permit },
    arrive,
  ];
}

/** One run of the leg. It returns the step the leg is on after the run. The leg is over when
 *  that step is "done", or when the run throws `BridgeLegEnded`. Any other error is temporary. */
export async function bridgeTickOnce(
  hands: BridgeLegHands,
  state: BridgeLegState,
): Promise<BridgeLegStep> {
  if (hands.route !== state.route) {
    throw new Error(`the leg is of the ${state.route} route, and the hands of ${hands.route}`);
  }
  if (state.step === "done") return "done";
  const stages = stagesOf(hands);
  const index = stages.findIndex((stage) => stage.step === state.step);
  const stage = stages[index];
  if (stage === undefined) throw new Error(`the ${state.route} route has no step ${state.step}`);
  const goOn = (): BridgeLegStep => {
    state.step = stages[index + 1]?.step ?? "done";
    state.prepared = null;
    state.sent = false;
    return state.step;
  };

  if ("ready" in stage) return (await stage.ready()) ? goOn() : state.step;

  if (state.prepared === null) {
    try {
      state.prepared = await stage.move.prepare();
    } catch (error) {
      if (!(error instanceof BridgeMoveRefused)) throw error;
      throw new BridgeLegEnded({ kind: "stopped", step: state.step, reason: error.message });
    }
    return state.step;
  }
  // The chain is asked before anything is sent: an earlier run can have sent the transaction
  // and stopped before the caller saved that.
  const landed = await stage.move.landed(state.prepared);
  if (landed === "failed") throw new BridgeLegEnded({ kind: "reverted", step: state.step });
  if (landed === "yes") return goOn();
  // TODO: when a chain refuses the prepared bytes for good, every run fails here. Sign again
  // with the same nonce, so that only one of the two can run.
  if (!state.sent) {
    await stage.move.send(state.prepared);
    state.sent = true;
  }
  return state.step;
}
