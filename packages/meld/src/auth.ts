// Fetches that carry the caller's credential to the adapter's gated routes.

interface Credential {
  token: string;
  expiresAtMs: number;
}

/** Product storage every runtime of the product shares, e.g. the Host's local storage. */
export interface CredentialStorage {
  readJSON(key: string): Promise<unknown>;
  writeJSON(key: string, value: unknown): Promise<unknown>;
}

export interface PersonhoodFetchConfig {
  /** Base URL of the onramp adapter service. */
  baseUrl: string;
  productId: string;
  /** Proves the challenge bytes as a person, e.g. `proveLitePersonhood` from `@getsome/host`. */
  prove(message: Uint8Array): Promise<{ proof: Uint8Array; ringIndex: number }>;
  /** Keeps the token across runs, so the page and the worker share one handshake. */
  storage?: CredentialStorage;
  fetchImpl?: typeof fetch;
}

const RENEW_BEFORE_EXPIRY_MS = 30_000;
const STORAGE_KEY = "getsome.adapter.token";
const ADAPTER_TIMEOUT_MS = 10_000;
/** Long enough for the account-access prompt a first proof waits on. */
const PROVE_TIMEOUT_MS = 25_000;
/** How long a failed proof answers calls before the Host is asked again, so calls do not each
 *  prompt it. */
const UNPROVEN_HOLD_MS = 30_000;

/** The Host refused the proof, or gave none in time. */
class PersonhoodUnavailable extends Error {
  constructor(cause: unknown) {
    super("The Host did not prove personhood.", { cause });
    this.name = "PersonhoodUnavailable";
  }
}

export function isPersonhoodUnavailable(error: unknown): boolean {
  return error instanceof PersonhoodUnavailable;
}

const isFresh = (value: unknown): value is Credential =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Credential).token === "string" &&
  typeof (value as Credential).expiresAtMs === "number" &&
  (value as Credential).expiresAtMs - RENEW_BEFORE_EXPIRY_MS > Date.now();

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

/** `work`, or the signal's reason once it aborts. `work` itself carries on. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** For an adapter in `insecure_dev` mode, which trusts the product id header. */
export function devAdapterFetch(productId: string, fetchImpl?: typeof fetch): typeof fetch {
  return (input, init) =>
    (fetchImpl ?? fetch)(input, withHeader(init, "x-dev-product-id", productId));
}

/**
 * For an adapter in `personhood` mode. A refused handshake answers the call with the adapter's
 * refusal, so callers read it like any other. A proof the Host refuses or does not give rejects
 * the call with `PersonhoodUnavailable`.
 */
export function personhoodAdapterFetch(config: PersonhoodFetchConfig): typeof fetch {
  const doFetch: typeof fetch = (input, init) => (config.fetchImpl ?? fetch)(input, init);
  const base = config.baseUrl.replace(/\/$/, "");
  let held: Credential | undefined;
  let refused: string | undefined;
  let pending: Promise<Credential | Response> | undefined;
  let unproven: { error: PersonhoodUnavailable; untilMs: number } | undefined;

  const post = (path: string, body?: unknown) =>
    doFetch(`${base}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS),
    });

  async function prove(message: Uint8Array): Promise<{ proof: Uint8Array; ringIndex: number }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no proof within ${PROVE_TIMEOUT_MS / 1000}s`)),
        PROVE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([config.prove(message), late]);
    } catch (cause) {
      const error = new PersonhoodUnavailable(cause);
      unproven = { error, untilMs: Date.now() + UNPROVEN_HOLD_MS };
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function redeem(): Promise<Credential | Response> {
    const issued = await post("/api/v1/auth/challenge");
    if (!issued.ok) return issued;
    const { challenge } = (await issued.json()) as { challenge: string };
    const { proof, ringIndex } = await prove(fromBase64Url(challenge));
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

  // Storage only saves a handshake, so failing to read or write it must not fail the call.
  async function obtain(): Promise<Credential | Response> {
    const stored = await config.storage?.readJSON(STORAGE_KEY).catch(() => undefined);
    if (isFresh(stored) && stored.token !== refused) return (held = stored);
    if (unproven !== undefined && unproven.untilMs > Date.now()) throw unproven.error;
    const got = await handshake();
    if (got instanceof Response) return got;
    held = got;
    await config.storage?.writeJSON(STORAGE_KEY, got).catch(() => undefined);
    return got;
  }

  function credential(): Promise<Credential | Response> {
    if (isFresh(held)) return Promise.resolve(held);
    pending ??= obtain().finally(() => (pending = undefined));
    return pending;
  }

  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const used = await untilAborted(credential(), init?.signal);
      if (used instanceof Response) return used;
      const res = await doFetch(input, withHeader(init, "authorization", `Bearer ${used.token}`));
      if (res.status !== 401 || attempt > 0) return res;
      refused = used.token;
      if (held === used) held = undefined;
    }
  };
}
