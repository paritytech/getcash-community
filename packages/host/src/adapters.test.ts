import { describe, expect, it } from "vitest";
import { recipientFromPublicKey } from "./accounts";
import type { ResultLike } from "./entropy";
import { createHostEnv } from "./env";
import { requestPaymentPermissions, type RemotePermissionItemLike } from "./permissions";

const ok = <T>(value: T): PromiseLike<ResultLike<T>> =>
  Promise.resolve({ isErr: () => false, value });
const err = <T>(error: unknown): PromiseLike<ResultLike<T>> =>
  Promise.resolve({ isErr: () => true, error });

describe("requestPaymentPermissions", () => {
  it("sequences ChainSubmit then Remote and reports full grant", async () => {
    const asked: RemotePermissionItemLike[] = [];
    const res = await requestPaymentPermissions(
      (item) => {
        asked.push(item);
        return ok(true);
      },
      { chainSubmit: true, remote: ["*.chainflip.io", "chainflip.io"] },
    );

    expect(res).toEqual({ granted: true, denied: [] });
    expect(asked).toEqual([
      { tag: "ChainSubmit" },
      { tag: "Remote", value: ["*.chainflip.io", "chainflip.io"] },
    ]);
  });

  it("a denial is a normal outcome, not an error", async () => {
    const res = await requestPaymentPermissions(
      (item) => ok(item.tag !== "ChainSubmit"), // user denies chain submit
      { chainSubmit: true, remote: ["chainflip.io"] },
    );
    expect(res.granted).toBe(false);
    expect(res.denied).toEqual(["ChainSubmit"]);
  });

  it("only asks for what was requested", async () => {
    const asked: RemotePermissionItemLike[] = [];
    await requestPaymentPermissions(
      (item) => {
        asked.push(item);
        return ok(true);
      },
      { remote: ["chainflip.io"] },
    );
    expect(asked.map((a) => a.tag)).toEqual(["Remote"]);
  });

  it("a transport error throws", async () => {
    await expect(
      requestPaymentPermissions(() => err(new Error("bridge down")), { chainSubmit: true }),
    ).rejects.toThrow("bridge down");
  });
});

describe("recipientFromPublicKey", () => {
  it("decodes a 32-byte publicKey to a prefix-0 (Asset Hub) SS58 address", () => {
    const address = recipientFromPublicKey(new Uint8Array(32).fill(1));
    expect(address.startsWith("1")).toBe(true); // prefix 0 encoding
    expect(address.startsWith("5")).toBe(false); // not the generic prefix 42
  });

  it("rejects wrong-length keys loudly", () => {
    expect(() => recipientFromPublicKey(new Uint8Array(20))).toThrow("32 bytes");
  });
});

describe("createHostEnv", () => {
  it("wraps the sandbox transport", async () => {
    const env = createHostEnv({
      isCorrectEnvironment: () => true,
      isReady: async () => true,
    });
    expect(env.isHost()).toBe(true);
    expect(await env.isReady()).toBe(true);
  });
});
