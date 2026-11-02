// Lite personhood proofs with the Host's reserved `peopl.<tld>` ring VRF key.

import { toHex } from "polkadot-api/utils";
import type { ResultLike } from "./entropy";

const PEOPLE_LITE = toHex(
  new TextEncoder().encode("pop:polkadot.network/people-lite".padEnd(32, " ")),
);

/** The adapter verifies proofs in the product's context at index 0 only. */
const CONTEXT_INDEX = 0;

export interface RingLocationLike {
  chainId: string;
  junctions: Array<
    { tag: "PalletInstance"; value: number } | { tag: "CollectionId"; value: string }
  >;
}

/** Mirrors the two calls of `@parity/product-sdk-host`'s `AccountsProvider` a proof needs. */
export interface RingVrfAccountsLike<Handle> {
  listRingVrfKeys(
    owner: string,
  ): PromiseLike<ResultLike<Array<{ handle: Handle; rings: RingLocationLike[] }>>>;
  createRingVRFProof(
    handle: Handle,
    context: { productId: string; suffix: { tag: "Index"; value: number } },
    ring: RingLocationLike,
    message: Uint8Array,
  ): PromiseLike<ResultLike<{ proof: Uint8Array; ringIndex: number }>>;
}

export interface PersonhoodProof {
  proof: Uint8Array;
  ringIndex: number;
}

/** The Host refused, e.g. `NotMember` for a user in no lite ring yet. */
export class PersonhoodRefused extends Error {
  constructor(readonly reason: string) {
    super(`personhood proof refused: ${reason}`);
    this.name = "PersonhoodRefused";
  }
}

const isPeopleLite = (ring: RingLocationLike) =>
  ring.junctions.some((j) => j.tag === "CollectionId" && j.value.toLowerCase() === PEOPLE_LITE);

function unwrap<T>(result: ResultLike<T>): T {
  if (!result.isErr()) return result.value as T;
  const { error } = result;
  throw new PersonhoodRefused(
    error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error),
  );
}

/** Proves `message` as a lite person in `productId`'s context, whose TLD names the key owner. */
export async function proveLitePersonhood<Handle>(
  accounts: RingVrfAccountsLike<Handle>,
  productId: string,
  message: Uint8Array,
): Promise<PersonhoodProof> {
  const owner = `peopl.${productId.slice(productId.lastIndexOf(".") + 1)}`;
  const keys = unwrap(await accounts.listRingVrfKeys(owner));
  for (const { handle, rings } of keys) {
    const ring = rings.find(isPeopleLite);
    if (ring === undefined) continue;
    const { proof, ringIndex } = unwrap(
      await accounts.createRingVRFProof(
        handle,
        { productId, suffix: { tag: "Index", value: CONTEXT_INDEX } },
        ring,
        message,
      ),
    );
    return { proof, ringIndex };
  }
  throw new PersonhoodRefused(`no ${owner} key in people-lite`);
}
