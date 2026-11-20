import { describe, expect, it } from "vitest";
import { sendableNative, type NativeAccount } from "./native-balance";

const ED = 100n;
const FREE = 1_000n;

const account = (over: {
  consumers?: number;
  providers?: number;
  free?: bigint;
  reserved?: bigint;
  frozen?: bigint;
}): NativeAccount => ({
  consumers: over.consumers ?? 0,
  providers: over.providers ?? 1,
  data: { free: over.free ?? FREE, reserved: over.reserved ?? 0n, frozen: over.frozen ?? 0n },
});

describe("sendableNative", () => {
  it("is the whole free balance of an account nothing holds open", () => {
    expect(sendableNative(account({}), ED)).toBe(FREE);
  });

  it("leaves the existential deposit on an account that cannot be closed", () => {
    expect(sendableNative(account({ consumers: 1 }), ED)).toBe(FREE - ED);
    expect(sendableNative(account({ consumers: 1, free: ED }), ED)).toBe(0n);
    expect(sendableNative(account({ consumers: 1, free: ED - 1n }), ED)).toBe(0n);
  });

  it("is the whole free balance where another provider keeps the account", () => {
    expect(sendableNative(account({ consumers: 1, providers: 2 }), ED)).toBe(FREE);
  });

  it("leaves what a freeze holds, less what is reserved against it", () => {
    expect(sendableNative(account({ frozen: 300n }), ED)).toBe(FREE - 300n);
    expect(sendableNative(account({ frozen: 300n, reserved: 120n }), ED)).toBe(FREE - 180n);
    expect(sendableNative(account({ frozen: 300n, reserved: 400n }), ED)).toBe(FREE);
    expect(sendableNative(account({ frozen: 2n * FREE }), ED)).toBe(0n);
  });

  it("leaves the larger of the freeze and the existential deposit, not their sum", () => {
    expect(sendableNative(account({ consumers: 1, frozen: 300n }), ED)).toBe(FREE - 300n);
    expect(sendableNative(account({ consumers: 1, frozen: 30n }), ED)).toBe(FREE - ED);
  });

  it("sends nothing from an account the chain does not know", () => {
    const unknown = account({ providers: 0, free: 0n });
    expect(sendableNative(unknown, ED)).toBe(0n);
    expect(sendableNative(unknown, ED, { keepAlive: true })).toBe(0n);
  });

  it("holds the existential deposit back when asked, whatever the references say", () => {
    expect(sendableNative(account({}), ED, { keepAlive: true })).toBe(FREE - ED);
    expect(sendableNative(account({ consumers: 1, providers: 2 }), ED, { keepAlive: true })).toBe(
      FREE - ED,
    );
    expect(sendableNative(account({ consumers: 1 }), ED, { keepAlive: true })).toBe(FREE - ED);
    expect(sendableNative(account({ frozen: 300n }), ED, { keepAlive: true })).toBe(FREE - 300n);
  });
});
