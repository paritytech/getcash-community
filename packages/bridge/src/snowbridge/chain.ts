// How the Snowbridge reads reach a chain: a runtime call by its names, and a storage read. The
// package holds no connection of its own. The caller makes the connections and passes them in.

import type { XcmInstruction, XcmValue } from "./codec";

export const BRIDGE_HUB = 1002;
export const ASSET_HUB = 1000;
export const HYDRATION = 2034;

/** A chain as the reads use it. */
export interface ChainReader {
  /** A runtime call, by the name of its group and its own name. */
  call(group: string, name: string, ...args: unknown[]): Promise<unknown>;
  /** The value of a storage entry, by the names of its pallet and the entry, and its keys. */
  storage(pallet: string, entry: string, ...keys: unknown[]): Promise<unknown>;
}

/** The part of a polkadot-api client with no types that a reader needs. */
export interface UntypedApi {
  apis: Record<string, Record<string, (...args: never[]) => Promise<unknown>>>;
  query: Record<string, Record<string, { getValue(...args: never[]): Promise<unknown> }>>;
}

/** A reader over a polkadot-api client. With `at`, every read is of the block with that hash, so
 *  that the figures of one chain agree with each other. */
export function chainReader(api: UntypedApi, at?: string): ChainReader {
  const where = at === undefined ? [] : [{ at }];
  return {
    call(group, name, ...args) {
      const call = api.apis[group]?.[name] as ((...all: unknown[]) => Promise<unknown>) | undefined;
      if (call === undefined) throw new SnowbridgeReadError(`the chain has no ${group}.${name}`);
      return call(...args, ...where);
    },
    storage(pallet, entry, ...keys) {
      const item = api.query[pallet]?.[entry] as
        { getValue(...all: unknown[]): Promise<unknown> } | undefined;
      if (item === undefined) throw new SnowbridgeReadError(`the chain has no ${pallet}.${entry}`);
      return item.getValue(...keys, ...where);
    },
  };
}

/** A chain did not give a read, or gave one that cannot be used. */
export class SnowbridgeReadError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SnowbridgeReadError";
  }
}

export const versioned = (value: unknown): XcmValue => ({ type: "V5", value });

/** A parachain as a sibling names it. */
export const sibling = (paraId: number) => ({
  parents: 1,
  interior: { type: "X1", value: { type: "Parachain", value: paraId } },
});

/** An event a dry run emitted. */
export interface ChainEvent {
  pallet: string;
  name: string;
  fields: Record<string, unknown>;
}

/** What a chain did with a program in a dry run. */
export interface XcmDryRun {
  /** Null when the program ran to its end. Else the instruction that stopped it and the error. */
  failure: { index: number; error: string } | null;
  events: ChainEvent[];
  /** The program the chain sends to the sibling `paraId`, or null when it sends none there. */
  forwardedTo(paraId: number): XcmInstruction[] | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Runs `program` on `chain` as a message from the sibling `fromPara`. Nothing is sent. */
export async function dryRunXcm(
  chain: ChainReader,
  fromPara: number,
  program: XcmInstruction[],
): Promise<XcmDryRun> {
  const reply = await chain.call(
    "DryRunApi",
    "dry_run_xcm",
    versioned(sibling(fromPara)),
    versioned(program),
  );
  if (!isRecord(reply) || reply.success !== true || !isRecord(reply.value)) {
    throw new SnowbridgeReadError("the chain did not run the program in a dry run");
  }
  const effects = reply.value;
  const result = effects.execution_result;
  if (!isRecord(result) || typeof result.type !== "string") {
    throw new SnowbridgeReadError("the dry run gave no result");
  }
  let failure: XcmDryRun["failure"] = null;
  if (result.type !== "Complete") {
    // An incomplete run names the instruction and the error. A run that did not start names the
    // error alone.
    const outer = isRecord(result.value) && isRecord(result.value.error) ? result.value.error : {};
    const inner = isRecord(outer.error) ? outer.error : outer;
    failure = {
      index: typeof outer.index === "number" ? outer.index : 0,
      error: typeof inner.type === "string" ? inner.type : result.type,
    };
  }
  const events = (Array.isArray(effects.emitted_events) ? effects.emitted_events : []).flatMap(
    (event): ChainEvent[] => {
      if (!isRecord(event) || typeof event.type !== "string" || !isRecord(event.value)) return [];
      const { type: name, value: fields } = event.value;
      if (typeof name !== "string") return [];
      return [{ pallet: event.type, name, fields: isRecord(fields) ? fields : {} }];
    },
  );
  const forwarded = Array.isArray(effects.forwarded_xcms) ? effects.forwarded_xcms : [];
  return {
    failure,
    events,
    forwardedTo(paraId) {
      for (const entry of forwarded) {
        if (!Array.isArray(entry)) continue;
        const [destination, messages] = entry as [unknown, unknown];
        const location = isRecord(destination) ? destination.value : undefined;
        const interior = isRecord(location) && isRecord(location.interior) ? location.interior : {};
        const junction = isRecord(interior.value) ? interior.value : {};
        if (junction.type !== "Parachain" || junction.value !== paraId) continue;
        const last = Array.isArray(messages) ? messages.at(-1) : undefined;
        if (isRecord(last) && last.type === "V5" && Array.isArray(last.value)) {
          return last.value as XcmInstruction[];
        }
      }
      return null;
    },
  };
}
