import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { describeConfig, loadConfig } from "../src/payout/config";
import { createHttpServer } from "../src/payout/server";
import { BRIDGE_FEE, CAP_BPS, confirmedDeposit, ONE, PAYER, startService, TOKEN } from "./helpers/payout";

const env = {
  ROUTER_ADDRESS: "0x1111111111111111111111111111111111111111",
  POOL_ADDRESS: "0x2222222222222222222222222222222222222222",
  TOKEN_ADDRESS: TOKEN,
  PAYER_SEED: `0x${"07".repeat(32)}`,
  MAX_PER_DEPOSIT: "1000000000000000000000",
  MAX_OUTSTANDING: "5000000000000000000000",
};

describe("payout config", () => {
  it("reads defaults and the exposure caps", () => {
    expect(loadConfig(env)).toMatchObject({
      confirmations: 2,
      frontFeeBps: 10,
      maxPerDeposit: 1_000n * ONE,
      maxOutstanding: 5_000n * ONE,
      ethereumRpcUrl: "http://127.0.0.1:8545",
      assetHubWs: "ws://127.0.0.1:12144",
      startBlock: undefined,
      failedRetryMs: 60_000,
      submitTimeoutMs: 60_000,
      unsettledAlertMinutes: 30,
    });
  });

  it("requires the payer seed and both caps, and rejects a malformed value", () => {
    for (const name of ["PAYER_SEED", "MAX_PER_DEPOSIT", "MAX_OUTSTANDING", "POOL_ADDRESS"]) {
      expect(() => loadConfig({ ...env, [name]: undefined })).toThrow(`missing ${name}`);
    }
    expect(() => loadConfig({ ...env, MAX_PER_DEPOSIT: "1e18" })).toThrow("MAX_PER_DEPOSIT");
    expect(() => loadConfig({ ...env, CONFIRMATIONS: "-1" })).toThrow("CONFIRMATIONS");
    expect(() => loadConfig({ ...env, SUBMIT_TIMEOUT_MS: "soon" })).toThrow("SUBMIT_TIMEOUT_MS");
  });

  it("keeps the payer seed and URL paths out of the description", () => {
    const described = JSON.stringify(describeConfig(loadConfig({ ...env, ETHEREUM_RPC_URL: "https://rpc.example/v3/secret-key" })));
    expect(described).not.toContain(env.PAYER_SEED.slice(2));
    expect(described).not.toContain("secret-key");
  });
});

describe("payout status endpoint", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function serve() {
    const started = await startService();
    const server = createHttpServer(started.service, started.log.logger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { ...started, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it("reports the payer, caps, outstanding exposure, funds and deposit counts", async () => {
    const { url, ethereum, service } = await serve();
    confirmedDeposit(ethereum, 1n, 100n * ONE);
    await service.tick();

    const status = (await (await fetch(`${url}/status`)).json()) as Record<string, any>;

    expect(status).toMatchObject({
      payer: PAYER,
      pool: { bridgeFee: BRIDGE_FEE.toString(), capBps: CAP_BPS, frontFeeBps: 10 },
      caps: { maxPerDeposit: (1_000n * ONE).toString(), maxOutstanding: (5_000n * ONE).toString() },
      counts: { fronted: 1, queued: 0, unrepaid: 0 },
      reconcilePending: false,
    });
    expect(BigInt(status.caps.outstanding)).toBe(100n * ONE - BRIDGE_FEE - ONE / 10n);
    expect(BigInt(status.payerFunds)).toBe(10_000n * ONE - BigInt(status.caps.outstanding));
  });

  it("lists deposits and returns one by id", async () => {
    const { url, ethereum, service } = await serve();
    confirmedDeposit(ethereum, 7n, 100n * ONE);
    await service.tick();

    expect(((await (await fetch(`${url}/deposits`)).json()) as unknown[]).length).toBe(1);
    expect(await (await fetch(`${url}/deposits/7`)).json()).toMatchObject({ depositId: "7", status: "fronted" });
    expect((await fetch(`${url}/deposits/8`)).status).toBe(404);
    expect((await fetch(`${url}/nothing`)).status).toBe(404);
    expect((await fetch(`${url}/status`, { method: "POST" })).status).toBe(405);
  });
});
