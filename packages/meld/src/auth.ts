// Fetches that carry the caller's credential to the adapter's gated routes.

interface Credential {
  token: string;
  expiresAtMs: number;
}

export interface PersonhoodFetchConfig {
  /** Base URL of the onramp adapter service. */
  baseUrl: string;
  productId: string;
  /** Proves the challenge bytes as a person, e.g. `proveLitePersonhood` from `@getsome/host`. */
  prove(message: Uint8Array): Promise<{ proof: Uint8Array; ringIndex: number }>;
  fetchImpl?: typeof fetch;
}

const RENEW_BEFORE_EXPIRY_MS = 30_000;

const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function withHeader(init: RequestInit | undefined, name: string, value: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(name, value);
  return { ...init, headers };
}

/** For an adapter in `insecure_dev` mode, which trusts the product id header. */
export function devAdapterFetch(productId: string, fetchImpl?: typeof fetch): typeof fetch {
  return (input, init) =>
    (fetchImpl ?? fetch)(input, withHeader(init, "x-dev-product-id", productId));
}

/**
 * For an adapter in `personhood` mode. A refused handshake answers the call with the adapter's
 * refusal, so callers read it like any other.
 */
export function personhoodAdapterFetch(config: PersonhoodFetchConfig): typeof fetch {
  const doFetch: typeof fetch = (input, init) => (config.fetchImpl ?? fetch)(input, init);
  const base = config.baseUrl.replace(/\/$/, "");
  let held: Credential | undefined;
  let pending: Promise<Credential | Response> | undefined;

  const post = (path: string, body?: unknown) =>
    doFetch(`${base}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

  async function redeem(): Promise<Credential | Response> {
    const issued = await post("/api/v1/auth/challenge");
    if (!issued.ok) return issued;
    const { challenge } = (await issued.json()) as { challenge: string };
    const { proof, ringIndex } = await config.prove(fromBase64Url(challenge));
    const redeemed = await post("/api/v1/auth/redeem", {
      challenge,
      proof: toBase64Url(proof),
      ring: ringIndex,
      productId: config.productId,
    });
    return redeemed.ok ? ((await redeemed.json()) as Credential) : redeemed;
  }

  async function handshake(): Promise<Credential | Response> {
    const first = await redeem();
    // A lite ring rebuilt between the proof and the redeem refuses it once.
    return first instanceof Response && first.status === 401 ? redeem() : first;
  }

  function credential(): Promise<Credential | Response> {
    if (held && held.expiresAtMs - RENEW_BEFORE_EXPIRY_MS > Date.now()) {
      return Promise.resolve(held);
    }
    pending ??= handshake()
      .then((got) => {
        if (!(got instanceof Response)) held = got;
        return got;
      })
      .finally(() => (pending = undefined));
    return pending;
  }

  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const used = await credential();
      if (used instanceof Response) return used;
      const res = await doFetch(input, withHeader(init, "authorization", `Bearer ${used.token}`));
      if (res.status !== 401 || attempt > 0) return res;
      if (held === used) held = undefined;
    }
  };
}
