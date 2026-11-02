// Lite personhood proofs with the Host's reserved `peopl.<tld>` ring VRF key.

import type { ResultLike } from "./entropy";

const PEOPLE_LITE = new TextEncoder().encode("pop:polkadot.network/people-lite".padEnd(32, " "));

/** The adapter verifies proofs in the product's context at index 0 only. */
const CONTEXT_INDEX = 0;

export type RingVrfKeyHandleLike = [
  owner: string,
  index: { tag: "Index"; value: number } | { tag: "Raw"; value: Uint8Array },
];

export interface RingLocationLike {
  chainId: `0x${string}`;
  junctions: Array<
    { tag: "PalletInstance"; value: number } | { tag: "CollectionId"; value: Uint8Array }
  >;
}

/** Mirrors the two calls of host-api-wrapper's `createAccountsProvider()` a proof needs. */
export interface RingVrfAccountsLike {
  listRingVrfKeys(
    owner: string,
  ): PromiseLike<ResultLike<Array<{ handle: RingVrfKeyHandleLike; rings: RingLocationLike[] }>>>;
  createRingVRFProof(
    handle: RingVrfKeyHandleLike,
    context: [productId: string, index: number],
    ring: RingLocationLike,
    message: Uint8Array,
  ): PromiseLike<ResultLike<{ proof: Uint8Array; ringIndex: number }>>;
}

export interface PersonhoodProof {
  proof: Uint8Array;
  ringIndex: number;
}

/** The Host refused, e.g. `CreateProofErr::NotMember` for a user in no lite ring yet. */
export class PersonhoodRefused extends Error {
  constructor(readonly reason: string) {
    super(`personhood proof refused: ${reason}`);
    this.name = "PersonhoodRefused";
  }
}

const isPeopleLite = (ring: RingLocationLike) =>
  ring.junctions.some(
    (j) =>
      j.tag === "CollectionId" &&
      j.value.length === PEOPLE_LITE.length &&
      j.value.every((byte, i) => byte === PEOPLE_LITE[i]),
  );

function unwrap<T>(result: ResultLike<T>): T {
  if (!result.isErr()) return result.value as T;
  const { error } = result;
  throw new PersonhoodRefused(error instanceof Error ? error.name : String(error));
}

/** Proves `message` as a lite person in `productId`'s context, whose TLD names the key owner. */
export async function proveLitePersonhood(
  accounts: RingVrfAccountsLike,
  productId: string,
  message: Uint8Array,
): Promise<PersonhoodProof> {
  const owner = `peopl.${productId.slice(productId.lastIndexOf(".") + 1)}`;
  const keys = unwrap(await accounts.listRingVrfKeys(owner));
  for (const { handle, rings } of keys) {
    const ring = rings.find(isPeopleLite);
    if (ring === undefined) continue;
    const { proof, ringIndex } = unwrap(
      await accounts.createRingVRFProof(handle, [productId, CONTEXT_INDEX], ring, message),
    );
    return { proof, ringIndex };
  }
  throw new PersonhoodRefused(`no ${owner} key in people-lite`);
}
