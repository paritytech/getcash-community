// The network a build targets. `.papi/` must describe the same chains: the build checks the
// genesis hashes agree.

import values from "./network.json";

export interface ChainConfig {
  paraId: number;
  genesis: `0x${string}`;
  /** Dialled only outside a host; inside one, the host routes by genesis. */
  rpc: string;
}

export interface Network {
  /** Allows demo builds, and with them the faucet and Skip. */
  testnet: boolean;
  nativeSymbol: string;
  assetHub: ChainConfig;
  people: ChainConfig & {
    /** The account holding the reserves of People's native/CASH pool. */
    poolAccount: string;
  };
}

const NETWORK_FIELDS = [
  "testnet",
  "nativeSymbol",
  "assetHub",
  "people",
] satisfies (keyof Network)[];
const CHAIN_FIELDS = ["paraId", "genesis", "rpc"] satisfies (keyof ChainConfig)[];
const PEOPLE_FIELDS = [...CHAIN_FIELDS, "poolAccount"] satisfies (keyof Network["people"])[];

const HASH = /^0x[0-9a-fA-F]{64}$/;
const SS58_ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{46,48}$/;
const WS_URL = /^wss?:\/\/\S+$/;

const fail = (path: string, expected: string): never => {
  throw new Error(`network.json: ${path} must be ${expected}`);
};

const isHash = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && HASH.test(value);

const isParaId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

/** The object at `path` (the file itself when empty), refusing fields outside `allowed`. */
function fieldsOf(value: unknown, path: string, allowed: readonly string[]) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path || "the file", "an object");
  }
  const fields: Record<string, unknown> = { ...value };
  const extra = Object.keys(fields).find((key) => !allowed.includes(key));
  if (extra !== undefined) {
    throw new Error(`network.json: unknown field ${path ? `${path}.${extra}` : extra}`);
  }
  return fields;
}

function chainOf(fields: Record<string, unknown>, path: string): ChainConfig {
  const { paraId, genesis, rpc } = fields;
  return {
    paraId: isParaId(paraId) ? paraId : fail(`${path}.paraId`, "a positive integer"),
    genesis: isHash(genesis) ? genesis : fail(`${path}.genesis`, "a 0x-prefixed 32-byte hash"),
    rpc: matches(rpc, WS_URL) ? rpc : fail(`${path}.rpc`, "a ws:// or wss:// URL"),
  };
}

export function parseNetwork(input: unknown): Network {
  const root = fieldsOf(input, "", NETWORK_FIELDS);
  const { testnet, nativeSymbol } = root;
  const people = fieldsOf(root.people, "people", PEOPLE_FIELDS);
  return {
    testnet: typeof testnet === "boolean" ? testnet : fail("testnet", "a boolean"),
    nativeSymbol:
      typeof nativeSymbol === "string" && nativeSymbol.trim() !== ""
        ? nativeSymbol
        : fail("nativeSymbol", "a non-empty string"),
    assetHub: chainOf(fieldsOf(root.assetHub, "assetHub", CHAIN_FIELDS), "assetHub"),
    people: {
      ...chainOf(people, "people"),
      poolAccount: matches(people.poolAccount, SS58_ACCOUNT)
        ? people.poolAccount
        : fail("people.poolAccount", "an SS58 address"),
    },
  };
}

export const NETWORK: Network = parseNetwork(values);
