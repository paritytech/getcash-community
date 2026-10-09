// Continue on a native card quote over a scripted headless client: the identity and requirements
// steps it shows only when needed, the order it places once they are done, the time the terms were
// accepted, a step left without an order, and the provider terms shown above Continue.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  createFakeMeldHeadlessClient,
  type CustomerView,
  type KycState,
  type MeldHeadlessClient,
  type RequirementsQuery,
  type RequirementsView,
} from "@getsome/meld";
import { setMeldHeadlessClientFactory } from "../lib/meld-headless";
import { useMeldNativeCheckout } from "../app/composables/useMeldNativeCheckout";

const QUERY: RequirementsQuery = {
  provider: "BANXA",
  paymentMethodType: "CREDIT_DEBIT_CARD",
  country: "DE",
  fiat: "EUR",
  sourceAmount: "101.20",
  destinationCurrencyCode: "DOT_ASSETHUB",
};

const TERMS = { type: "TERMS_OF_SERVICE", url: "https://provider.example/terms" };
const PRESSED = new Date("2026-10-09T10:00:00.000Z");

function view(patch: Partial<RequirementsView> = {}): RequirementsView {
  return {
    agreements: [TERMS],
    verifications: [],
    missingFields: [],
    pending: false,
    blocked: false,
    ready: false,
    ...patch,
  };
}

const READY = view({ ready: true });
const EMAIL = view({ verifications: [{ channel: "EMAIL", reason: "MISSING" }] });

interface Script {
  kyc: KycState;
  requirements: RequirementsView;
}

function scripted(state: Script, overrides: Partial<MeldHeadlessClient> = {}) {
  const customer = (): CustomerView => ({ kyc: state.kyc, providers: [] });
  const client = {
    ...createFakeMeldHeadlessClient(),
    getCustomer: vi.fn(async () => (state.kyc === "none" ? null : customer())),
    getRequirements: vi.fn(async () => state.requirements),
    ...overrides,
  };
  setMeldHeadlessClientFactory(() => client);
  return client;
}

/** Lets the scripted client's answers land. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A checkout for `order`, once its terms have been read. */
async function checkout(order: RequirementsQuery | null = QUERY) {
  const query = shallowRef<RequirementsQuery | null>(order);
  const start = vi.fn(async (_acceptedAt: string) => {});
  const scope = effectScope();
  const flow = scope.run(() =>
    useMeldNativeCheckout({ query: () => query.value, start, now: () => PRESSED }),
  );
  if (!flow) throw new Error("the checkout did not start");
  await flush();
  return { flow, start, query, scope };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  setMeldHeadlessClientFactory(null);
  vi.restoreAllMocks();
});

describe("useMeldNativeCheckout", () => {
  it("places the order at once for an approved customer with nothing outstanding", async () => {
    scripted({ kyc: "approved", requirements: READY });
    const { flow, start } = await checkout();

    await flow.continueAction();

    expect(start).toHaveBeenCalledExactlyOnceWith(PRESSED.toISOString());
    expect(flow.step.value).toBe("pay");
  });

  it("runs the identity step, then the requirements, then places the order", async () => {
    const state: Script = { kyc: "none", requirements: EMAIL };
    scripted(state);
    const { flow, start } = await checkout();

    const done = flow.continueAction();
    await flush();
    expect(flow.step.value).toBe("identity");
    expect(start).not.toHaveBeenCalled();

    state.kyc = "approved";
    flow.ready();
    await flush();
    expect(flow.step.value).toBe("requirements");
    expect(flow.query.value).toBe(QUERY);
    expect(start).not.toHaveBeenCalled();

    flow.ready();
    await done;
    // The terms were accepted when Continue was pressed, not when the steps were done.
    expect(start).toHaveBeenCalledExactlyOnceWith(PRESSED.toISOString());
    expect(flow.step.value).toBe("pay");
    expect(flow.query.value).toBeNull();
  });

  it("skips the identity step for an approved customer with requirements outstanding", async () => {
    scripted({ kyc: "approved", requirements: EMAIL });
    const { flow, start } = await checkout();

    const done = flow.continueAction();
    await flush();
    expect(flow.step.value).toBe("requirements");

    flow.ready();
    await done;
    expect(start).toHaveBeenCalledOnce();
  });

  it("shows the identity step when the customer cannot be read, for it to retry", async () => {
    scripted(
      { kyc: "approved", requirements: READY },
      { getCustomer: vi.fn(async () => Promise.reject(new Error("offline"))) },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { flow } = await checkout();

    void flow.continueAction();
    await flush();
    expect(flow.step.value).toBe("identity");
  });

  it("shows the requirements step when they cannot be read, for it to retry", async () => {
    scripted(
      { kyc: "approved", requirements: READY },
      {
        getRequirements: vi
          .fn(async () => Promise.reject<RequirementsView>(new Error("offline")))
          .mockResolvedValueOnce(READY),
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { flow } = await checkout();

    void flow.continueAction();
    await flush();
    expect(flow.step.value).toBe("requirements");
  });

  it("places no order when a step is left, and shows the pay screen afresh", async () => {
    scripted({ kyc: "pending", requirements: READY });
    const { flow, start } = await checkout();

    const done = flow.continueAction();
    await flush();
    expect(flow.step.value).toBe("identity");

    flow.leave();
    await expect(done).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    expect(flow.step.value).toBe("pay");
    expect(flow.left.value).toBe(1);
  });

  it("passes on why the order could not be placed", async () => {
    scripted({ kyc: "approved", requirements: EMAIL });
    const { flow, start } = await checkout();
    start.mockRejectedValueOnce(new Error("The provider refused the order."));

    const done = flow.continueAction();
    await flush();
    flow.ready();
    await expect(done).rejects.toThrow("The provider refused the order.");
    expect(flow.step.value).toBe("pay");
  });

  it("places no order until the terms it accepts are known", async () => {
    scripted({ kyc: "approved", requirements: READY });
    const { flow, start } = await checkout(null);

    expect(flow.termsStatus.value).toBe("loading");
    await expect(flow.continueAction()).rejects.toThrow("terms");
    expect(start).not.toHaveBeenCalled();
  });

  it("counts a provider that lists no agreements as terms known", async () => {
    scripted({ kyc: "approved", requirements: view({ agreements: [], ready: true }) });
    const { flow, start } = await checkout();

    expect(flow.termsStatus.value).toBe("ready");
    expect(flow.terms.value).toEqual({ provider: "Banxa", agreements: [] });
    await flow.continueAction();
    expect(start).toHaveBeenCalledOnce();
  });

  it("holds Continue after a failed terms read until a retry reads them", async () => {
    const client = scripted(
      { kyc: "approved", requirements: READY },
      {
        getRequirements: vi.fn(async () => READY).mockRejectedValueOnce(new Error("offline")),
      },
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { flow, start } = await checkout();

    expect(flow.termsStatus.value).toBe("failed");
    await expect(flow.continueAction()).rejects.toThrow("terms");
    expect(start).not.toHaveBeenCalled();

    flow.retryTerms();
    expect(flow.termsStatus.value).toBe("loading");
    await flush();
    expect(client.getRequirements).toHaveBeenCalledTimes(2);
    expect(flow.termsStatus.value).toBe("ready");
    await flow.continueAction();
    expect(start).toHaveBeenCalledOnce();
  });

  it("ends a step left open when its scope is disposed", async () => {
    scripted({ kyc: "none", requirements: READY });
    const { flow, start, scope } = await checkout();

    const done = flow.continueAction();
    await flush();
    scope.stop();
    await expect(done).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it("loads the quoted provider's terms for the notice, and again for a new quote", async () => {
    const client = scripted({ kyc: "approved", requirements: view() });
    const { flow, query } = await checkout();
    expect(client.getRequirements).toHaveBeenCalledWith(QUERY);
    expect(flow.terms.value).toEqual({ provider: "Banxa", agreements: [TERMS] });

    query.value = null;
    await flush();
    expect(flow.terms.value).toBeUndefined();

    const next = { ...QUERY, provider: "TRANSAK" };
    query.value = next;
    await flush();
    expect(client.getRequirements).toHaveBeenLastCalledWith(next);
    expect(flow.terms.value).toEqual({ provider: "Transak", agreements: [TERMS] });
  });

  it("shows no terms when they cannot be read", async () => {
    scripted(
      { kyc: "approved", requirements: READY },
      { getRequirements: vi.fn(async () => Promise.reject(new Error("offline"))) },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { flow } = await checkout();
    expect(flow.terms.value).toBeUndefined();
    expect(flow.termsStatus.value).toBe("failed");
    expect(warn).toHaveBeenCalledOnce();
  });
});
