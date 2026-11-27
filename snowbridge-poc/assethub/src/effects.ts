import type { ApiPromise } from "@polkadot/api";
import type { GenericEvent } from "@polkadot/types";
import type { Codec } from "@polkadot/types/types";
import { decodeEventLog, type Abi, type Address, type Hex } from "viem";
import { BRIDGE_HUB_PARA_ID } from "./constants.js";

export type Json = Record<string, unknown>;

export interface ChainEvent {
  section: string;
  method: string;
  fields: Json;
}

export interface DryRun {
  outcome: Json;
  events: ChainEvent[];
}

const BRIDGE_HUB_ORIGIN = { V5: { parents: 1, interior: { X1: [{ Parachain: BRIDGE_HUB_PARA_ID }] } } };

export const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));

/** Runs an encoded `VersionedXcm` on Asset Hub as if Bridge Hub had delivered it. */
export async function dryRunFromBridgeHub(api: ApiPromise, program: Hex): Promise<DryRun> {
  const result = (await api.call.dryRunApi.dryRunXcm(BRIDGE_HUB_ORIGIN, program)) as unknown as {
    isOk: boolean;
    asOk: { executionResult: Codec; emittedEvents: GenericEvent[] };
    asErr: Codec;
  };
  if (!result.isOk) throw new Error(`dry run unavailable: ${result.asErr.toString()}`);
  return {
    outcome: result.asOk.executionResult.toJSON() as Json,
    events: result.asOk.emittedEvents.map((event) => ({
      section: event.section,
      method: event.method,
      fields: Object.fromEntries(event.data.map((value, i) => [event.data.names?.[i] ?? i, value.toJSON()])),
    })),
  };
}

export function poolEvents(events: ChainEvent[], poolAbi: Abi, pool: Address) {
  return events
    .filter((e) => e.section === "revive" && e.method === "ContractEmitted" && String(e.fields.contract).toLowerCase() === pool.toLowerCase())
    .map((e) => decodeEventLog({ abi: poolAbi, data: e.fields.data as Hex, topics: e.fields.topics as [Hex, ...Hex[]] }));
}

export function sum(events: ChainEvent[], pick: (e: ChainEvent) => unknown): bigint {
  return events.reduce((total, e) => total + BigInt((pick(e) as string | number | undefined) ?? 0), 0n);
}
