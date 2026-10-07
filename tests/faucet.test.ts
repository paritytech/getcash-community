import { afterEach, describe, expect, it, vi } from "vitest";

const words = (count: number) => Array(count).fill("word").join(" ");

async function configuredWith(seed: string): Promise<boolean> {
  vi.stubEnv("VITE_FAUCET_SEED", seed);
  vi.resetModules();
  const { isFaucetConfigured } = await import("../lib/faucet");
  return isFaucetConfigured();
}

describe("isFaucetConfigured", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["a 12-word phrase", words(12), true],
    ["a 24-word phrase", words(24), true],
    ["0x-prefixed 32-byte hex", `0x${"ab".repeat(32)}`, true],
    ["an 18-word phrase", words(18), false],
    ["hex of the wrong length", `0x${"ab".repeat(16)}`, false],
    ["an empty value", "", false],
  ])("%s: %s", async (_, seed, expected) => {
    expect(await configuredWith(seed)).toBe(expected);
  });
});
