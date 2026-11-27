import type { ApiPromise } from "@polkadot/api";
import type { Hex } from "viem";
import type { NetworkId } from "./location.js";

const WESTEND_GENESIS: Hex = "0xe143f23803ac50e8f6f8e62695d1ce9e4e1d68aa36c1cd2cfd15340213f3423e";
const PASEO_GENESIS: Hex = "0x77afd6190f1554ad45fd0d31aee62aacc33c6db0ea801129acb813f913e0764f";
const ROCOCO_GENESIS: Hex = "0x6408de7737c59c238890533af25896a2c20608d8b380bb01029acb392781063e";

/** The relay networks Asset Hub runtimes name themselves with. The relay's genesis is not the genesis of the connected chain. */
const KNOWN_NETWORKS: NetworkId[] = [
  { Polkadot: null },
  { Kusama: null },
  { ByGenesis: WESTEND_GENESIS },
  { ByGenesis: PASEO_GENESIS },
  { ByGenesis: ROCOCO_GENESIS },
];

const PROBE_ACCOUNT: Hex = `0x${"11".repeat(32)}`;

/** The network a signed XCM origin carries on the connected chain, which a claim of trapped assets must name; found with `ExpectOrigin`. */
export async function signedOriginNetwork(api: ApiPromise): Promise<NetworkId> {
  const origin = { system: { Signed: PROBE_ACCOUNT } };
  for (const network of KNOWN_NETWORKS) {
    const location = { parents: 0, interior: { X1: [{ AccountId32: { network, id: PROBE_ACCOUNT } }] } };
    const call = api.tx.polkadotXcm.execute({ V5: [{ ExpectOrigin: location }] }, { refTime: 1_000_000_000n, proofSize: 100_000n });
    const result = (await api.call.dryRunApi.dryRunCall(origin, call, 5)).toJSON() as {
      ok?: { executionResult: { ok?: unknown } };
    };
    if (result.ok?.executionResult.ok) return network;
  }
  throw new Error("the signed origin of this chain names a network that is not in the known list");
}
