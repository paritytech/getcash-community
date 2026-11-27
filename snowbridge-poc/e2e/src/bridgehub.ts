import { connect } from "../../assethub/src/chain";
import type { Api } from "./substrate";

export const BRIDGE_HUB_WS = "ws://127.0.0.1:11144";

export const connectBridgeHub = (): Promise<Api> => connect(BRIDGE_HUB_WS);

// The beacon slot of the Ethereum header Bridge Hub's light client last finalized.
export async function finalizedBeaconSlot(bridgeHub: Api): Promise<number> {
  const root = await bridgeHub.query.ethereumBeaconClient.latestFinalizedBlockRoot();
  const state = (await bridgeHub.query.ethereumBeaconClient.finalizedBeaconState(root)).toJSON() as { slot: number };
  return state.slot;
}

// Bridge Hub keeps one bit per inbound V2 nonce, set once the message was submitted.
export async function nonceDelivered(bridgeHub: Api, nonce: bigint): Promise<boolean> {
  const bucket = await bridgeHub.query.ethereumInboundQueueV2.nonceBitmap(nonce / 128n);
  return ((bucket as unknown as { toBigInt(): bigint }).toBigInt() >> (nonce % 128n)) & 1n ? true : false;
}
