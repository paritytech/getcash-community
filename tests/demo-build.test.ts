import { afterEach, describe, expect, it, vi } from "vitest";

const build = vi.hoisted(() => ({ testnet: true, faucet: false }));

vi.mock("@getsome/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getsome/core")>()),
  NETWORK: {
    get testnet() {
      return build.testnet;
    },
  },
}));
vi.mock("../lib/faucet", () => ({ isFaucetConfigured: () => build.faucet }));

import { isDemoBuild } from "../app/utils/demo";

describe("isDemoBuild", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { testnet: true, dev: false, faucet: true, demo: true },
    { testnet: true, dev: true, faucet: false, demo: true },
    { testnet: true, dev: false, faucet: false, demo: false },
    { testnet: false, dev: false, faucet: true, demo: false },
    { testnet: false, dev: true, faucet: false, demo: false },
  ])("testnet $testnet, dev $dev, faucet $faucet: $demo", ({ testnet, dev, faucet, demo }) => {
    build.testnet = testnet;
    build.faucet = faucet;
    vi.stubEnv("DEV", dev);
    expect(isDemoBuild()).toBe(demo);
  });
});
