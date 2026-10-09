// The Meld customer store over an injected headless client: the customer's identity check, the
// provider's requirements as known or not yet known, and verification refusals as buyer copy.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  AdapterRefusal,
  createFakeMeldHeadlessClient,
  type MeldHeadlessClient,
  type RequirementsQuery,
  type RequirementsView,
} from "@getsome/meld";
import { setMeldHeadlessClientFactory } from "../lib/meld-headless";
import { requirementsStateOf, useMeldCustomerStore } from "../app/stores/meld-customer";

const QUERY: RequirementsQuery = {
  provider: "TRANSAK",
  paymentMethodType: "CREDIT_DEBIT_CARD",
  country: "DE",
  fiat: "EUR",
  sourceAmount: "101.20",
  destinationCurrencyCode: "DOT_ASSETHUB",
};

const NOTHING_LISTED: RequirementsView = {
  agreements: [{ type: "TERMS_OF_USE", url: "https://provider.example/terms" }],
  verifications: [],
  missingFields: [],
  pending: false,
  blocked: false,
  ready: false,
};

/** The offline fake with the given routes replaced. */
function clientWith(overrides: Partial<MeldHeadlessClient> = {}): MeldHeadlessClient {
  return { ...createFakeMeldHeadlessClient(), ...overrides };
}

function inject(client: MeldHeadlessClient): void {
  setMeldHeadlessClientFactory(() => client);
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  setMeldHeadlessClientFactory(null);
  vi.restoreAllMocks();
});

describe("useMeldCustomerStore", () => {
  it("knows nothing before the adapter answers, and 'none' when it has no customer", async () => {
    inject(clientWith({ getCustomer: async () => null }));
    const store = useMeldCustomerStore();
    expect(store.kyc).toBe("unknown");

    const refreshing = store.refresh();
    expect(store.loading).toBe(true);
    await refreshing;
    expect(store.loading).toBe(false);
    expect(store.kyc).toBe("none");
    expect(store.providers).toEqual([]);
    expect(store.error).toBeNull();
  });

  it("takes an approved customer's state and providers", async () => {
    inject(createFakeMeldHeadlessClient({ providers: ["TRANSAK"] }));
    const store = useMeldCustomerStore();
    await store.refresh();
    expect(store.kyc).toBe("approved");
    expect(store.providers).toEqual([{ provider: "TRANSAK", kyc: "approved" }]);
  });

  it("registers to a pending check and keeps none of the details", async () => {
    const createCustomer = vi.fn(createFakeMeldHeadlessClient({ kyc: "pending" }).createCustomer);
    inject(clientWith({ getCustomer: async () => null, createCustomer }));
    const store = useMeldCustomerStore();
    await store.refresh();
    const details = {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      dateOfBirth: "1990-03-15",
    };

    await store.register(details);
    expect(createCustomer).toHaveBeenCalledWith(details);
    expect(store.kyc).toBe("pending");
    const kept = JSON.stringify(store.$state);
    for (const value of Object.values(details)) expect(kept).not.toContain(value);
  });

  it("reads back a customer that is registered already", async () => {
    inject(
      clientWith({
        createCustomer: async () => {
          throw new AdapterRefusal("Already registered. (CUSTOMER_EXISTS)", 409, "CUSTOMER_EXISTS");
        },
      }),
    );
    const store = useMeldCustomerStore();
    await store.register({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      dateOfBirth: "1990-03-15",
    });
    expect(store.error).toBeNull();
    expect(store.kyc).toBe("approved");
  });

  it("starts the identity check and holds its URL", async () => {
    inject(clientWith({ startKyc: async () => ({ url: "https://kyc.example/session" }) }));
    const store = useMeldCustomerStore();
    await store.startKyc();
    expect(store.kycUrl).toBe("https://kyc.example/session");
  });

  it("reads requirements as ready, outstanding, or not known yet", async () => {
    let answer: RequirementsView = NOTHING_LISTED;
    inject(clientWith({ getRequirements: async () => answer }));
    const store = useMeldCustomerStore();
    expect(store.requirementsState).toBe("unknown");

    await store.loadRequirements(QUERY);
    expect(store.requirements?.agreements).toHaveLength(1);
    expect(store.requirementsState).toBe("unknown");

    answer = { ...NOTHING_LISTED, verifications: [{ channel: "PHONE", reason: "MISSING" }] };
    await store.loadRequirements(QUERY);
    expect(store.requirementsState).toBe("outstanding");

    answer = { ...NOTHING_LISTED, ready: true };
    await store.loadRequirements({ ...QUERY, sourceAmount: "50.00" });
    expect(store.requirementsState).toBe("ready");
  });

  it("counts any listed requirement as outstanding", () => {
    expect(requirementsStateOf(null)).toBe("unknown");
    expect(requirementsStateOf({ ...NOTHING_LISTED, missingFields: ["taxId"] })).toBe(
      "outstanding",
    );
    expect(requirementsStateOf({ ...NOTHING_LISTED, pending: true })).toBe("outstanding");
    expect(requirementsStateOf({ ...NOTHING_LISTED, blocked: true })).toBe("outstanding");
  });

  it("surfaces a verification cooldown as the adapter's copy and when to resend", async () => {
    inject(
      clientWith({
        startVerification: async () => {
          throw new AdapterRefusal(
            "Wait before asking for another code. (VERIFICATION_COOLDOWN)",
            429,
            "VERIFICATION_COOLDOWN",
            undefined,
            undefined,
            undefined,
            "2026-10-09T10:01:00Z",
          );
        },
      }),
    );
    const store = useMeldCustomerStore();
    const started = await store.startVerification({ channel: "PHONE", target: "+4915112345678" });
    expect(started).toBeNull();
    expect(store.error).toBe("Wait before asking for another code. (VERIFICATION_COOLDOWN)");
    expect(store.resendAvailableAt).toBe("2026-10-09T10:01:00Z");
    expect(JSON.stringify(store.$state)).not.toContain("+4915112345678");
  });

  it("reloads the requirements once a code is verified", async () => {
    const getRequirements = vi.fn(async () => NOTHING_LISTED);
    inject(
      clientWith({
        getRequirements,
        startVerification: async () => ({
          verificationId: "v-1",
          expiresAt: "2026-10-09T10:10:00Z",
          resendAvailableAt: "2026-10-09T10:01:00Z",
        }),
      }),
    );
    const store = useMeldCustomerStore();
    await store.loadRequirements(QUERY);
    const started = await store.startVerification({ channel: "EMAIL", target: "a@example.com" });
    expect(started?.verificationId).toBe("v-1");
    expect(store.resendAvailableAt).toBe("2026-10-09T10:01:00Z");

    expect(await store.confirmVerification({ verificationId: "v-1", code: "123456" })).toEqual({
      status: "VERIFIED",
    });
    expect(getRequirements).toHaveBeenCalledTimes(2);
    expect(getRequirements).toHaveBeenLastCalledWith(QUERY);
  });

  it("shows generic copy for a failure that is no adapter refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    inject(
      clientWith({
        getCustomer: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    );
    const store = useMeldCustomerStore();
    await store.refresh();
    expect(store.kyc).toBe("unknown");
    expect(store.error).toBe("Couldn't reach the payment service. Please try again.");
  });
});
