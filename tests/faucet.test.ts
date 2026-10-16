import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKENS } from "@getsome/core";

/** The faucet transfer's watch: the test emits its events. */
const watch = vi.hoisted(() => ({
  observer: null as {
    next(event: unknown): void;
    error(error: unknown): void;
    complete(): void;
  } | null,
}));
vi.mock("../lib/host-chain", () => ({
  ASSET_HUB: {},
  connectChain: async () => ({
    getTypedApi: () => ({
      tx: {
        Balances: {
          transfer_keep_alive: () => ({
            signSubmitAndWatch: () => ({
              subscribe(observer: NonNullable<typeof watch.observer>) {
                watch.observer = observer;
                return { unsubscribe() {} };
              },
            }),
          }),
        },
      },
    }),
  }),
}));

const words = (count: number) => Array(count).fill("word").join(" ");
const HEX_SEED = `0x${"ab".repeat(32)}`;
const BURNER = "14uAyRtbeRsrgERPLETm72yFPKW3oi3m4RX93arNwGQhsduC";

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
    ["0x-prefixed 32-byte hex", HEX_SEED, true],
    ["an 18-word phrase", words(18), false],
    ["hex of the wrong length", `0x${"ab".repeat(16)}`, false],
    ["an empty value", "", false],
  ])("%s: %s", async (_, seed, expected) => {
    expect(await configuredWith(seed)).toBe(expected);
  });
});

describe("fundFromFaucet", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    watch.observer = null;
  });

  /** Starts a transfer of 5 PAS and waits for its watch. */
  async function transfer() {
    vi.stubEnv("VITE_FAUCET_SEED", HEX_SEED);
    vi.resetModules();
    const { fundFromFaucet } = await import("../lib/faucet");
    const sent = fundFromFaucet({ address: BURNER, amount: 5n, route: { tier: "pool" } });
    await vi.waitFor(() => expect(watch.observer).not.toBeNull());
    return { sent, observer: watch.observer! };
  }

  it("resolves once the transfer is broadcast", async () => {
    const { sent, observer } = await transfer();
    observer.next({ type: "signed", txHash: "0x01" });
    observer.next({ type: "broadcasted", txHash: "0x01" });

    await expect(sent).resolves.toBeUndefined();
  });

  it("rejects when the transfer is refused before the broadcast", async () => {
    const { sent, observer } = await transfer();
    observer.error(new Error("Invalid: Payment"));

    await expect(sent).rejects.toThrow(
      `faucet transfer refused (is the faucet funded with ${TOKENS.PAS.symbol}?): Invalid: Payment`,
    );
  });
});
