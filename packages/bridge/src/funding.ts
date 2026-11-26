// How the bridge leg learns that the ETH of a top-up is on the key that sends the bridge
// transaction. The user sends the ETH, or NEAR Intents delivers it. Both answer the same
// question, so the rest of the leg does not know which of the two it was.
// TODO: read the forwarder in place of the key once a forwarder and a relayer exist.

import type { EvmRpc } from "./evm-rpc";
import type { BridgeLegHands } from "./leg";

export interface FundingInput {
  /** The node of the chain where the route starts. */
  rpc: Pick<EvmRpc, "balance">;
  /** The address of the key. */
  address: string;
  /** The wei that the route needs on the key. */
  needed: bigint;
}

/** ETH that the user sends to the key. */
export function directFunding(input: FundingInput): BridgeLegHands["funding"] {
  return async () =>
    (await input.rpc.balance(input.address)) >= input.needed ? "ready" : "waiting";
}

export interface NearFundingInput extends FundingInput {
  /** The part of the NEAR client that reads the state of a deposit address. */
  near: { status(depositAddress: string): Promise<{ state: string }> };
  /** The address where the user pays NEAR. */
  depositAddress: string;
}

/** ETH that NEAR Intents delivers to the key. */
export function nearFunding(input: NearFundingInput): BridgeLegHands["funding"] {
  const onKey = directFunding(input);
  return async () => {
    // The balance is the proof. NEAR is asked only while the ETH is not there.
    if ((await onKey()) === "ready") return "ready";
    const { state } = await input.near.status(input.depositAddress);
    if (state === "REFUNDED") return "refunded";
    if (state === "FAILED") return "failed";
    return "waiting";
  };
}
