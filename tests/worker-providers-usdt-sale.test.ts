// The hand that pays a direct sale of USDT: the provider's deposit is read in USDT, and the key
// pays the exact figure in USDT, its fee in USDT, judged by its USDT balance and its nonce. A sale
// of PAS keeps paying PAS.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SELL_TOKEN, USDT_SELL_TOKEN } from "@getsome/meld";
import { stableTxOptions } from "@getsome/funding";

const mocks = vi.hoisted(() => ({
  saleRail: vi.fn(),
  payExactOnce: vi.fn(),
  exactPaymentLanded: vi.fn(),
  readAssetHubAccount: vi.fn(),
}));

vi.mock("@getsome/meld", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MELD_SELL_ENABLED: true,
  createMeldClient: () => ({}),
  saleRail: mocks.saleRail,
}));

vi.mock("@getsome/withdraw", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  payExactOnce: mocks.payExactOnce,
  exactPaymentLanded: mocks.exactPaymentLanded,
  readAssetHubAccount: mocks.readAssetHubAccount,
}));

vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  getHostLocalStorage: vi.fn(),
}));

const API = { fake: "asset-hub" };

vi.mock("../worker/src/shared.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  keypairFor: async () => ({ address: "5Key", signer: {} }),
  anchorFor: async () => ({ hash: "0xbest", number: 7 }),
  connectChain: async () => ({
    getTypedApi: () => API,
    getFinalizedBlock: async () => ({ number: 7 }),
    destroy: () => {},
  }),
}));

const KEY_HEX = `0x${"07".repeat(32)}`;
const DEPOSIT = "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM";
const dotSale = {
  rail: "meld",
  tier: "pool",
  label: "wd:eph:meld-bank:1",
  keyPublicKeyHex: KEY_HEX,
  assetHubGenesis: "0xah",
  channel: { id: "funding-sell-1", address: DEPOSIT, amount: "234521000000" },
  meld: { baseUrl: "https://adapter.test" },
};
const usdtSale = {
  ...dotSale,
  tier: "psm",
  external: "USDT",
  feeRate: 1000,
  channel: { ...dotSale.channel, amount: "25000000" },
};
const handoff = { id: "funding-sell-1", address: DEPOSIT, openedAt: 1, expiresAt: 0 };
const exact = () => ({ nonce: 0, inFlight: true, balanceBefore: "25300000", rejections: 0 });

describe("a direct sale's provider and payment", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.saleRail.mockReturnValue({ channel: vi.fn(), status: vi.fn() });
    mocks.payExactOnce.mockResolvedValue(undefined);
    mocks.exactPaymentLanded.mockResolvedValue(false);
    mocks.readAssetHubAccount.mockResolvedValue({ free: 0n, nonce: 0 });
  });

  it("reads a sale of USDT's deposit in USDT, and a sale of PAS's in PAS", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    railFor("meld", usdtSale);
    expect(mocks.saleRail.mock.calls[0]![3]).toEqual(USDT_SELL_TOKEN);
    railFor("meld", dotSale);
    expect(mocks.saleRail.mock.calls[1]![3]).toEqual(SELL_TOKEN);
  });

  it("pays a sale of USDT in USDT, its fee in USDT, and reads the key's USDT", async () => {
    const { payRailExact } = await import("../worker/src/providers.js");
    await payRailExact(usdtSale, handoff, 25_000_000n, exact());
    const [input] = mocks.payExactOnce.mock.calls[0]!;
    expect(input).toMatchObject({
      to: DEPOSIT,
      amount: 25_000_000n,
      assetId: 1984,
      signOptions: { at: "0xbest", ...stableTxOptions("USDT") },
      anchorNumber: 7,
    });
    await input.readKey();
    expect(mocks.readAssetHubAccount).toHaveBeenCalledWith(API, KEY_HEX, 1984);
  });

  it("pays a sale of PAS in PAS, as it always has", async () => {
    const { payRailExact } = await import("../worker/src/providers.js");
    await payRailExact(dotSale, handoff, 234_521_000_000n, exact());
    const [input] = mocks.payExactOnce.mock.calls[0]!;
    expect(input).not.toHaveProperty("assetId");
    expect(input.signOptions).toEqual({ at: "0xbest" });
    await input.readKey();
    expect(mocks.readAssetHubAccount).toHaveBeenCalledWith(API, KEY_HEX, undefined);
  });

  it("reads whether an earlier USDT payment landed from the key's USDT", async () => {
    const { exactPaymentOut } = await import("../worker/src/providers.js");
    await exactPaymentOut(usdtSale, 25_000_000n, exact());
    const [input] = mocks.exactPaymentLanded.mock.calls[0]!;
    await input.readKey();
    expect(mocks.readAssetHubAccount).toHaveBeenCalledWith(API, KEY_HEX, 1984);
  });
});
