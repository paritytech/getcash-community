import { describe, expect, it } from "vitest";
import { FeeGuard, FeeRefused } from "../src/trigger/fees";
import { AssetHubFeeSource, type QuoteApi } from "../src/trigger/quote";
import { FakeFeeSource } from "./helpers/fees";

const sample = { account: `0x${"11".repeat(32)}` as const, token: "0x54d6643762e46036b3448659791adaf554225541" as const, amount: 5_000_000n };

function guard(source: FakeFeeSource, overrides: { maxAgeMs?: number; retryAfterMs?: number } = {}) {
  const clock = { now: 1_000 };
  const instance = new FeeGuard(source, { marginMilli: 1200n, maxAgeMs: 10_000, retryAfterMs: 0, now: () => clock.now, ...overrides });
  return { instance, clock };
}

describe("execution fee guard", () => {
  it("refuses a configured fee below the quote plus the margin, and accepts one that covers it", async () => {
    const source = new FakeFeeSource();
    source.quoteWei = 1_000n;
    const { instance } = guard(source);

    await expect(instance.check(sample, 1_199n)).rejects.toMatchObject({ reason: "too-low" });
    await expect(instance.check(sample, 1_200n)).resolves.toBeUndefined();
  });

  it("rounds the margin up, so the required fee is never below the quote times the margin", async () => {
    const source = new FakeFeeSource();
    source.quoteWei = 1_001n;
    const { instance } = guard(source);

    await expect(instance.check(sample, 1_201n)).rejects.toBeInstanceOf(FeeRefused);
    await expect(instance.check(sample, 1_202n)).resolves.toBeUndefined();
  });

  it("quotes again on every check, so a rising quote is seen at once", async () => {
    const source = new FakeFeeSource();
    source.quoteWei = 1_000n;
    const { instance } = guard(source);
    await instance.check(sample, 1_200n);

    source.quoteWei = 2_000n;
    await expect(instance.check(sample, 1_200n)).rejects.toMatchObject({ reason: "too-low" });
    expect(source.calls).toHaveLength(2);
  });

  it("keeps the last good quote for a bounded time while Asset Hub is unreachable, then refuses", async () => {
    const source = new FakeFeeSource();
    source.quoteWei = 1_000n;
    const { instance, clock } = guard(source, { maxAgeMs: 10_000 });
    await instance.check(sample, 1_200n);

    source.failing = true;
    clock.now += 10_000;
    await expect(instance.check(sample, 1_200n)).resolves.toBeUndefined();
    await expect(instance.check(sample, 1_100n)).rejects.toMatchObject({ reason: "too-low" });

    clock.now += 1;
    await expect(instance.check(sample, 1_200n)).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("refuses from the start when there has never been a quote", async () => {
    const source = new FakeFeeSource();
    source.failing = true;
    const { instance } = guard(source);

    await expect(instance.check(sample, 10n ** 18n)).rejects.toThrow("no execution fee quote from Asset Hub");
  });

  it("leaves a failed source alone for the retry window instead of asking once per item", async () => {
    const source = new FakeFeeSource();
    source.failing = true;
    const { instance, clock } = guard(source, { retryAfterMs: 5_000 });

    for (let item = 0; item < 4; item++) await instance.check(sample, 1n).catch(() => undefined);
    expect(source.calls).toHaveLength(1);

    clock.now += 5_000;
    await instance.check(sample, 1n).catch(() => undefined);
    expect(source.calls).toHaveLength(2);
  });

  it("reports the quote, the required fee and the last error for the status endpoint", async () => {
    const source = new FakeFeeSource();
    source.quoteWei = 1_000n;
    const { instance, clock } = guard(source);
    expect(instance.status(5n)).toEqual({ configured: "5", quote: undefined, required: undefined, quotedAt: undefined, quoteError: undefined });

    await instance.refresh(sample);
    source.failing = true;
    clock.now += 1;
    await instance.refresh(sample);

    expect(instance.status(5n)).toMatchObject({ configured: "5", quote: "1000", required: "1200", quoteError: "asset hub unreachable" });
    expect(instance.ageMs()).toBe(1);
  });
});

describe("Asset Hub fee source", () => {
  const template = { xcmHead: "0x0510aa" as const, xcmTail: "0xbb" as const, claimerHead: "0x00010100" as const };
  const router = "0x7e57000000000000000000000000000000000001" as const;

  type Created = { type: string; value: unknown };

  function fakeApi(options: { endsWithTopic?: boolean; weight?: unknown; fee?: unknown; hang?: boolean } = {}) {
    const created: Created[] = [];
    const calls = { weight: [] as unknown[], fee: [] as unknown[] };
    let disconnects = 0;
    const api: QuoteApi = {
      createType(type, value) {
        created.push({ type, value });
        return {
          toU8a: () => Uint8Array.of(0xaa, 0xbb),
          asV5: [{ toU8a: () => Uint8Array.of(0x14), isSetTopic: false }, ...(options.endsWithTopic ? [{ toU8a: () => Uint8Array.of(0x2c), isSetTopic: true }] : [])],
        };
      },
      call: {
        xcmPaymentApi: {
          async queryXcmWeight(program) {
            calls.weight.push(program);
            if (options.hang) return new Promise(() => undefined);
            return { toJSON: () => options.weight ?? { ok: { refTime: 7, proofSize: 9 } } };
          },
          async queryWeightToAssetFee(weight, asset) {
            calls.fee.push({ weight, asset });
            return { toJSON: () => options.fee ?? { ok: "0x2386f26fc10000" } };
          },
        },
      },
      disconnect: async () => void disconnects++,
    };
    return { api, created, calls, disconnects: () => disconnects };
  }

  const source = (api: QuoteApi, timeoutMs = 1_000, connect = async () => api) =>
    new AssetHubFeeSource({ router, ethereumChainId: 11155111n, template, timeoutMs, connect });

  it("prices the weight of the delivered program in ether", async () => {
    const { api, created, calls } = fakeApi();

    expect(await source(api).quote(sample)).toBe(10n ** 16n);

    expect(calls.weight).toEqual(["0xaabb"]);
    expect(calls.fee).toEqual([
      { weight: { refTime: 7, proofSize: 9 }, asset: { V5: { parents: 2, interior: { X1: [{ GlobalConsensus: { Ethereum: { chainId: 11155111n } } }] } } } },
    ]);
    const program = created[1]!.value as { V5: Record<string, any>[] };
    const [descend, universal, feeDeposit, hints, payFees, tokenDeposit, router_, userInstruction, topic] = program.V5;
    expect(Object.keys(descend!)).toEqual(["DescendOrigin"]);
    expect(Object.keys(universal!)).toEqual(["UniversalOrigin"]);
    expect(Object.keys(feeDeposit!)).toEqual(["ReserveAssetDeposited"]);
    expect(hints!.SetHints.hints[0].AssetClaimer.location).toBe(`0x00010100${sample.account.slice(2)}`);
    expect(Object.keys(payFees!)).toEqual(["PayFees"]);
    expect(tokenDeposit!.ReserveAssetDeposited[0]).toMatchObject({ fun: { Fungible: sample.amount } });
    expect(tokenDeposit!.ReserveAssetDeposited[0].id.interior.X2[1]).toEqual({ AccountKey20: { network: null, key: sample.token } });
    expect(router_!.DescendOrigin.X1[0]).toEqual({ AccountKey20: { network: null, key: router } });
    expect(userInstruction).toBe("0x14");
    expect(Object.keys(topic!)).toEqual(["SetTopic"]);
    expect(program.V5).toHaveLength(9);
  });

  it("adds no topic when the router's program already ends with one", async () => {
    const { api, created } = fakeApi({ endsWithTopic: true });

    await source(api).quote(sample);

    const program = created[1]!.value as { V5: unknown[] };
    expect(program.V5.filter((instruction) => typeof instruction === "object" && instruction !== null && "SetTopic" in instruction)).toHaveLength(0);
    expect(program.V5.at(-1)).toBe("0x2c");
  });

  it("reports a runtime error instead of a quote", async () => {
    const { api } = fakeApi({ weight: { err: "Unroutable" } });

    await expect(source(api).quote(sample)).rejects.toThrow('queryXcmWeight failed: "Unroutable"');
  });

  it("gives up on a call that never answers and connects again for the next quote", async () => {
    const hanging = fakeApi({ hang: true });
    const healthy = fakeApi();
    const apis = [hanging.api, healthy.api];
    let connects = 0;
    const quoter = source(hanging.api, 50, async () => apis[connects++]!);

    await expect(quoter.quote(sample)).rejects.toThrow("timed out after 50 ms");
    expect(hanging.disconnects()).toBe(1);
    expect(await quoter.quote(sample)).toBe(10n ** 16n);
    expect(connects).toBe(2);
  });

  it("closes the connection it opened", async () => {
    const { api, disconnects } = fakeApi();
    const quoter = source(api);
    await quoter.quote(sample);

    await quoter.close();

    expect(disconnects()).toBe(1);
  });
});
