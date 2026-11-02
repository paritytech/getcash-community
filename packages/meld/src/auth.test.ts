import { describe, expect, it } from "vitest";
import { type CredentialStorage, devAdapterFetch, personhoodAdapterFetch } from "./auth";

const BASE = "https://adapter.test";
const CHALLENGE = new Uint8Array(56).fill(0xfb);
const CHALLENGE_TEXT = Buffer.from(CHALLENGE).toString("base64url");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An adapter whose redeem and gated-route answers are scripted, the last repeating. */
function adapter(
  script: { redeem?: number[]; gated?: number[] } = {},
  storage?: CredentialStorage,
) {
  const calls: { path: string; headers: Headers; body: unknown }[] = [];
  let tokens = 0;
  const next = (answers: number[] | undefined, n: number) =>
    answers?.[Math.min(n, answers.length - 1)] ?? 200;
  const count = (path: string) => calls.filter((c) => c.path === path).length - 1;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).slice(BASE.length);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, headers: new Headers(init?.headers), body });
    if (path === "/api/v1/auth/challenge") return json(200, { challenge: CHALLENGE_TEXT });
    if (path === "/api/v1/auth/redeem") {
      const status = next(script.redeem, count(path));
      if (status !== 200) return json(status, { error: { tag: "Unauthorized" } });
      return json(200, { token: `t${++tokens}`, expiresAtMs: Date.now() + 300_000 });
    }
    return json(next(script.gated, count(path)), {});
  }) as typeof fetch;

  const prove = async (message: Uint8Array) => {
    expect(message).toEqual(CHALLENGE);
    return { proof: new Uint8Array([0xff, 0xfe]), ringIndex: 62 };
  };
  const runtime = () =>
    personhoodAdapterFetch({
      baseUrl: `${BASE}/`,
      productId: "getcash.paseo",
      prove,
      fetchImpl,
      ...(storage ? { storage } : {}),
    });
  return { authed: runtime(), runtime, calls };
}

function memoryStorage() {
  const values = new Map<string, unknown>();
  const storage: CredentialStorage = {
    readJSON: async (key) => values.get(key) ?? null,
    writeJSON: async (key, value) => values.set(key, value),
  };
  return { storage, values };
}

const bearer = (c: { headers: Headers }) => c.headers.get("authorization");

describe("devAdapterFetch", () => {
  it("names the product in the dev header", async () => {
    const { calls } = adapter();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ path: String(input), headers: new Headers(init?.headers), body: undefined });
      return json(200, {});
    }) as typeof fetch;

    await devAdapterFetch("getcash.dev", fetchImpl)(`${BASE}/assets`, { headers: { accept: "x" } });
    expect(calls[0]?.headers.get("x-dev-product-id")).toBe("getcash.dev");
    expect(calls[0]?.headers.get("accept")).toBe("x");
  });
});

describe("personhoodAdapterFetch", () => {
  it("redeems a proof of the challenge bytes once and carries the token on every call", async () => {
    const { authed, calls } = adapter();

    await Promise.all([authed(`${BASE}/assets`), authed(`${BASE}/assets`)]);
    await authed(`${BASE}/quote`, { method: "POST", body: "{}" });

    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/auth/challenge",
      "/api/v1/auth/redeem",
      "/assets",
      "/assets",
      "/quote",
    ]);
    expect(calls[1]?.body).toEqual({
      challenge: CHALLENGE_TEXT,
      proof: "__4",
      ring: 62,
      productId: "getcash.paseo",
    });
    expect(calls.slice(2).map(bearer)).toEqual(["Bearer t1", "Bearer t1", "Bearer t1"]);
  });

  it("proves again once when the redeem is refused", async () => {
    const { authed, calls } = adapter({ redeem: [401, 200] });

    expect((await authed(`${BASE}/assets`)).status).toBe(200);
    expect(calls.filter((c) => c.path === "/api/v1/auth/redeem")).toHaveLength(2);
  });

  it("answers the call with the refusal when the handshake fails, and retries on the next", async () => {
    const { authed, calls } = adapter({ redeem: [401, 401, 200] });

    expect((await authed(`${BASE}/assets`)).status).toBe(401);
    expect(calls.some((c) => c.path === "/assets")).toBe(false);
    expect((await authed(`${BASE}/assets`)).status).toBe(200);
  });

  it("renews a token the adapter refuses and replays the call once", async () => {
    const { authed, calls } = adapter({ gated: [401, 200] });

    expect((await authed(`${BASE}/quote`, { method: "POST", body: "{}" })).status).toBe(200);
    expect(calls.filter((c) => c.path === "/quote").map(bearer)).toEqual([
      "Bearer t1",
      "Bearer t2",
    ]);
  });

  it("reuses the token another runtime stored", async () => {
    const { storage } = memoryStorage();
    const { authed, runtime, calls } = adapter({}, storage);

    await authed(`${BASE}/assets`);
    await runtime()(`${BASE}/funding/1`);

    expect(calls.filter((c) => c.path === "/api/v1/auth/redeem")).toHaveLength(1);
    expect(calls.filter((c) => !c.path.startsWith("/api")).map(bearer)).toEqual([
      "Bearer t1",
      "Bearer t1",
    ]);
  });

  it("does not take back a stored token the adapter refused", async () => {
    const { storage, values } = memoryStorage();
    const { authed, runtime } = adapter({ gated: [200, 401, 200] }, storage);

    await authed(`${BASE}/assets`);
    expect((await runtime()(`${BASE}/assets`)).status).toBe(200);
    expect(values.get("getsome.adapter.token")).toMatchObject({ token: "t2" });
  });
});
