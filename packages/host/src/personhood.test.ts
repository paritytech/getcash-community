import { toHex } from "polkadot-api/utils";
import { describe, expect, it } from "vitest";
import type { ResultLike } from "./entropy";
import {
  PersonhoodRefused,
  proveLitePersonhood,
  type RingLocationLike,
  type RingVrfAccountsLike,
} from "./personhood";

const ring = (name: string): RingLocationLike => ({
  chainId: "0x67fa",
  junctions: [
    { tag: "PalletInstance", value: 61 },
    { tag: "CollectionId", value: toHex(new TextEncoder().encode(name.padEnd(32, " "))) },
  ],
});
const people = ring("pop:polkadot.network/people");
const lite = ring("pop:polkadot.network/people-lite");

const ok = <T>(value: T): PromiseLike<ResultLike<T>> =>
  Promise.resolve({ isErr: () => false, value });
const err = (error: unknown): PromiseLike<ResultLike<never>> =>
  Promise.resolve({ isErr: () => true, error });

function accounts(overrides: Partial<RingVrfAccountsLike<string>> = {}) {
  const calls: unknown[][] = [];
  const fake: RingVrfAccountsLike<string> = {
    listRingVrfKeys: (owner) => {
      calls.push(["list", owner]);
      return ok([
        { handle: "full", rings: [people] },
        { handle: "lite", rings: [lite] },
      ]);
    },
    createRingVRFProof: (...args) => {
      calls.push(["prove", ...args]);
      return ok({ proof: new Uint8Array([1, 2]), ringIndex: 62 });
    },
    ...overrides,
  };
  return { fake, calls };
}

describe("proveLitePersonhood", () => {
  it("proves with the lite key of the product's TLD at context index 0", async () => {
    const { fake, calls } = accounts();
    const message = new Uint8Array(56);

    const proof = await proveLitePersonhood(fake, "getcash.dot", message);

    expect(proof).toEqual({ proof: new Uint8Array([1, 2]), ringIndex: 62 });
    expect(calls).toEqual([
      ["list", "peopl.dot"],
      [
        "prove",
        "lite",
        { productId: "getcash.dot", suffix: { tag: "Index", value: 0 } },
        lite,
        message,
      ],
    ]);
  });

  it("carries the Host's refusal", async () => {
    const notMember = { tag: "Domain", value: { tag: "V1", value: { tag: "NotMember" } } };
    const { fake } = accounts({ createRingVRFProof: () => err(notMember) });

    await expect(proveLitePersonhood(fake, "getcash.dot", new Uint8Array(56))).rejects.toEqual(
      new PersonhoodRefused(JSON.stringify(notMember)),
    );
  });

  it("refuses when the Host lists no lite key", async () => {
    const { fake } = accounts({ listRingVrfKeys: () => ok([]) });

    await expect(
      proveLitePersonhood(fake, "getcash.dot", new Uint8Array(56)),
    ).rejects.toBeInstanceOf(PersonhoodRefused);
  });
});
