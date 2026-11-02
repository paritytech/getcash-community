import { describe, expect, it } from "vitest";
import type { ResultLike } from "./entropy";
import {
  PersonhoodRefused,
  proveLitePersonhood,
  type RingLocationLike,
  type RingVrfAccountsLike,
} from "./personhood";

const collection = (name: string) => new TextEncoder().encode(name.padEnd(32, " "));
const ring = (name: string): RingLocationLike => ({
  chainId: "0x4a2b",
  junctions: [
    { tag: "PalletInstance", value: 61 },
    { tag: "CollectionId", value: collection(name) },
  ],
});
const people = ring("pop:polkadot.network/people");
const lite = ring("pop:polkadot.network/people-lite");

const ok = <T>(value: T): PromiseLike<ResultLike<T>> =>
  Promise.resolve({ isErr: () => false, value });
const err = (error: unknown): PromiseLike<ResultLike<never>> =>
  Promise.resolve({ isErr: () => true, error });

function accounts(overrides: Partial<RingVrfAccountsLike> = {}) {
  const calls: unknown[][] = [];
  const fake: RingVrfAccountsLike = {
    listRingVrfKeys: (owner) => {
      calls.push(["list", owner]);
      return ok([
        { handle: [owner, { tag: "Index", value: 0 }], rings: [people] },
        { handle: [owner, { tag: "Index", value: 1 }], rings: [lite] },
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

    const proof = await proveLitePersonhood(fake, "getcash.paseo", message);

    expect(proof).toEqual({ proof: new Uint8Array([1, 2]), ringIndex: 62 });
    expect(calls).toEqual([
      ["list", "peopl.paseo"],
      ["prove", ["peopl.paseo", { tag: "Index", value: 1 }], ["getcash.paseo", 0], lite, message],
    ]);
  });

  it("names the Host's refusal", async () => {
    const notMember = Object.assign(new Error("not a member"), {
      name: "CreateProofErr::NotMember",
    });
    const { fake } = accounts({ createRingVRFProof: () => err(notMember) });

    await expect(proveLitePersonhood(fake, "getcash.paseo", new Uint8Array(56))).rejects.toEqual(
      new PersonhoodRefused("CreateProofErr::NotMember"),
    );
  });

  it("refuses when the Host lists no lite key", async () => {
    const { fake } = accounts({ listRingVrfKeys: () => ok([]) });

    await expect(
      proveLitePersonhood(fake, "getcash.paseo", new Uint8Array(56)),
    ).rejects.toBeInstanceOf(PersonhoodRefused);
  });
});
