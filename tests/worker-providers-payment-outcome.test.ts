// What became of the key's payment to a provider's channel, seen in a best block: the finalized
// chain's word on that block, and, where the block was replaced or is too old for the chain to
// name, the payment's own effect on the key at the finalized head, then at the best one.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOKENS } from "@getsome/core";

const mocks = vi.hoisted(() => ({
  settleBlock: vi.fn(),
  readAssetHubAccount: vi.fn(),
}));

vi.mock("@getsome/withdraw", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  settleBlock: mocks.settleBlock,
  readAssetHubAccount: mocks.readAssetHubAccount,
}));

vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  getHostLocalStorage: vi.fn(),
  proveLitePersonhood: vi.fn(),
}));

vi.mock("../worker/src/shared.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  connectChain: async () => ({ getTypedApi: () => ({ query: {} }), destroy: () => {} }),
}));

const KEY_HEX = `0x${"07".repeat(32)}`;
const record = {
  rail: "chainflip",
  tier: "psm",
  external: "USDT",
  feeRate: 5_000,
  keyPublicKeyHex: KEY_HEX,
  assetHubGenesis: "0xah",
};
const SEEN = { number: 7, hash: "0xseen" };
/** The sweep's effect: the key holds none of the token. */
const swept = (key: { free: bigint }) => key.free === 0n;

describe("a payment seen in a best block", () => {
  let heads: Record<"best" | "finalized", bigint>;
  beforeEach(() => {
    mocks.settleBlock.mockReset();
    mocks.readAssetHubAccount.mockReset();
    heads = { best: 0n, finalized: 0n };
    mocks.readAssetHubAccount.mockImplementation(
      async (
        _api: unknown,
        _hex: string,
        _token: unknown,
        { at }: { at: "best" | "finalized" },
      ) => ({
        free: heads[at],
        nonce: 1,
      }),
    );
  });

  const outcome = async () => {
    const { paymentOutcome } = await import("../worker/src/providers.js");
    return paymentOutcome(record, SEEN, swept);
  };

  it("is what the finalized chain says of its block while it can say it, reading nothing more", async () => {
    for (const verdict of ["pending", "final"]) {
      mocks.settleBlock.mockResolvedValue(verdict);
      expect(await outcome()).toBe(verdict);
    }
    expect(mocks.readAssetHubAccount).not.toHaveBeenCalled();
  });

  it("stands when its block is too old to name or was replaced but the key shows it at the finalized head", async () => {
    for (const verdict of ["unknown", "dropped"]) {
      mocks.settleBlock.mockResolvedValue(verdict);
      expect(await outcome()).toBe("final");
    }
    // Read in the sale's token, at the finalized head first.
    expect(mocks.readAssetHubAccount).toHaveBeenCalledWith(
      expect.anything(),
      KEY_HEX,
      TOKENS.USDT,
      { at: "finalized" },
    );
  });

  it("waits while it shows only at the best head, and is gone when it shows nowhere", async () => {
    mocks.settleBlock.mockResolvedValue("dropped");
    heads = { best: 0n, finalized: 20_000_000n };
    expect(await outcome()).toBe("pending");
    heads = { best: 20_000_000n, finalized: 20_000_000n };
    expect(await outcome()).toBe("gone");
  });
});
