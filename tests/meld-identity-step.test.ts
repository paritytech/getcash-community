// The identity step over a scripted headless client: which stage each reported KYC state leads to,
// the poll while a check is open or under review, retry, and the form rules behind registration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  AdapterRefusal,
  createFakeMeldHeadlessClient,
  type CustomerView,
  type KycState,
  type MeldHeadlessClient,
} from "@getsome/meld";
import { setMeldHeadlessClientFactory } from "../lib/meld-headless";
import {
  KYC_POLL_MS,
  dateOfBirthOf,
  identityErrors,
  isAdultOn,
  isEmail,
  registrationOf,
  useMeldIdentityStep,
  type IdentityForm,
} from "../app/composables/useMeldIdentityStep";

const KYC_URL = "https://kyc.example/session";

const FORM: IdentityForm = {
  firstName: " Ada ",
  lastName: "Lovelace",
  email: "ada@example.com",
  birthDay: "15",
  birthMonth: "3",
  birthYear: "1990",
  lineOne: "1 Main St",
  city: "Berlin",
  postalCode: "10115",
};

const TODAY = new Date(2026, 9, 9);

/** A client whose customer reports `state.kyc`; null while `state.kyc` is "none". */
function scripted(state: { kyc: KycState }, overrides: Partial<MeldHeadlessClient> = {}) {
  const view = (): CustomerView => ({ kyc: state.kyc, providers: [] });
  const client = {
    ...createFakeMeldHeadlessClient(),
    getCustomer: vi.fn(async () => (state.kyc === "none" ? null : view())),
    createCustomer: vi.fn(async () => view()),
    startKyc: vi.fn(async () => ({ url: KYC_URL })),
    ...overrides,
  };
  setMeldHeadlessClientFactory(() => client);
  return client;
}

/** Lets the scripted client's answers land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function start() {
  const scope = effectScope();
  const step = scope.run(() => useMeldIdentityStep());
  if (!step) throw new Error("the step did not start");
  return { step, scope };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setMeldHeadlessClientFactory(null);
  vi.restoreAllMocks();
});

describe("useMeldIdentityStep", () => {
  it("asks for the form when the key has no customer", async () => {
    scripted({ kyc: "none" });
    const { step, scope } = start();
    expect(step.stage.value).toBe("loading");
    await flush();
    expect(step.stage.value).toBe("form");
    expect(step.kycUrl.value).toBeNull();
    scope.stop();
  });

  it("registers, opens the hosted check, and waits on it once the buyer leaves it", async () => {
    const state = { kyc: "none" as KycState };
    const client = scripted(state);
    const { step, scope } = start();
    await flush();
    const details = registrationOf(FORM, "DE", TODAY);
    if (details === null) throw new Error("the form should be valid");

    state.kyc = "pending";
    await step.register(details);
    expect(client.createCustomer).toHaveBeenCalledWith(details);
    expect(client.startKyc).toHaveBeenCalledTimes(1);
    expect(step.stage.value).toBe("kyc");
    expect(step.kycUrl.value).toBe(KYC_URL);

    // Still open: a pending answer leaves the hosted page up.
    await vi.advanceTimersByTimeAsync(KYC_POLL_MS);
    expect(step.stage.value).toBe("kyc");

    await step.leaveKyc();
    expect(step.stage.value).toBe("checking");
    expect(step.kycUrl.value).toBeNull();

    // Leaving reads at once and keeps one poll going, not two.
    const reads = client.getCustomer.mock.calls.length;
    await vi.advanceTimersByTimeAsync(KYC_POLL_MS);
    expect(client.getCustomer).toHaveBeenCalledTimes(reads + 1);
    scope.stop();
  });

  it("keeps the form with the adapter's reason when registration is refused", async () => {
    scripted(
      { kyc: "none" },
      {
        createCustomer: async () => {
          throw new AdapterRefusal("Check your details. (BAD_REQUEST)", 400, "BAD_REQUEST");
        },
      },
    );
    const { step, scope } = start();
    await flush();
    const details = registrationOf(FORM, "DE", TODAY);
    if (details === null) throw new Error("the form should be valid");
    await step.register(details);
    expect(step.stage.value).toBe("form");
    expect(step.error.value).toBe("Check your details. (BAD_REQUEST)");
    scope.stop();
  });

  it("polls a pending check until it is approved, then stops", async () => {
    const state = { kyc: "pending" as KycState };
    const client = scripted(state);
    const { step, scope } = start();
    await flush();
    expect(step.stage.value).toBe("checking");

    await vi.advanceTimersByTimeAsync(KYC_POLL_MS);
    expect(client.getCustomer).toHaveBeenCalledTimes(2);
    expect(step.stage.value).toBe("checking");

    state.kyc = "approved";
    await vi.advanceTimersByTimeAsync(KYC_POLL_MS);
    expect(step.stage.value).toBe("approved");
    expect(step.approved.value).toBe(true);

    await vi.advanceTimersByTimeAsync(KYC_POLL_MS * 3);
    expect(client.getCustomer).toHaveBeenCalledTimes(3);
    scope.stop();
  });

  it("reopens the check from the wait, for a check that was left unfinished", async () => {
    const client = scripted({ kyc: "pending" });
    const { step, scope } = start();
    await flush();
    expect(step.stage.value).toBe("checking");

    await step.retry();
    expect(client.startKyc).toHaveBeenCalledTimes(1);
    expect(step.stage.value).toBe("kyc");
    expect(step.kycUrl.value).toBe(KYC_URL);

    await vi.advanceTimersByTimeAsync(KYC_POLL_MS);
    expect(step.stage.value).toBe("kyc");
    expect(client.getCustomer).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it("is approved at once for an approved customer", async () => {
    scripted({ kyc: "approved" });
    const { step, scope } = start();
    await flush();
    expect(step.approved.value).toBe(true);
    scope.stop();
  });

  it("starts the check again after a rejection", async () => {
    const client = scripted({ kyc: "rejected" });
    const { step, scope } = start();
    await flush();
    expect(step.stage.value).toBe("rejected");

    await step.retry();
    expect(client.startKyc).toHaveBeenCalledTimes(1);
    expect(step.stage.value).toBe("kyc");
    expect(step.kycUrl.value).toBe(KYC_URL);
    scope.stop();
  });

  it("moves an open check to expired, and starts it again on retry", async () => {
    const state = { kyc: "pending" as KycState };
    scripted(state);
    const { step, scope } = start();
    await flush();
    state.kyc = "expired";
    await vi.advanceTimersByTimeAsync(KYC_POLL_MS);
    expect(step.stage.value).toBe("expired");

    await step.retry();
    expect(step.stage.value).toBe("kyc");
    scope.stop();
  });

  it("stops polling when its scope is disposed", async () => {
    const client = scripted({ kyc: "pending" });
    const { step, scope } = start();
    await flush();
    expect(step.stage.value).toBe("checking");

    scope.stop();
    await vi.advanceTimersByTimeAsync(KYC_POLL_MS * 4);
    expect(client.getCustomer).toHaveBeenCalledTimes(1);
  });

  it("shows a failed lookup as an error and repeats it on retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let reachable = false;
    scripted(
      { kyc: "none" },
      {
        getCustomer: async () => {
          if (!reachable) throw new TypeError("Failed to fetch");
          return null;
        },
      },
    );
    const { step, scope } = start();
    await flush();
    expect(step.stage.value).toBe("error");
    expect(step.error.value).toBe("Couldn't reach the payment service. Please try again.");

    reachable = true;
    await step.retry();
    expect(step.stage.value).toBe("form");
    scope.stop();
  });
});

describe("identity form rules", () => {
  it("reads three fields as a calendar date", () => {
    expect(dateOfBirthOf("1", "3", "1990")).toBe("1990-03-01");
    expect(dateOfBirthOf("29", "02", "2024")).toBe("2024-02-29");
    expect(dateOfBirthOf("29", "02", "2023")).toBeNull();
    expect(dateOfBirthOf("31", "04", "2000")).toBeNull();
    expect(dateOfBirthOf("12", "13", "2000")).toBeNull();
    expect(dateOfBirthOf("1", "1", "90")).toBeNull();
  });

  it("comes of age on the 18th birthday, and on 1 March for 29 February", () => {
    expect(isAdultOn("2008-10-09", TODAY)).toBe(true);
    expect(isAdultOn("2008-10-10", TODAY)).toBe(false);
    expect(isAdultOn("2008-02-29", new Date(2026, 1, 28))).toBe(false);
    expect(isAdultOn("2008-02-29", new Date(2026, 2, 1))).toBe(true);
  });

  it("refuses an under-18, an impossible or future date, a bad email and a missing city", () => {
    expect(identityErrors(FORM, TODAY)).toEqual({});
    expect(identityErrors({ ...FORM, birthYear: "2010" }, TODAY).dateOfBirth).toBe(
      "You need to be 18 or older.",
    );
    expect(identityErrors({ ...FORM, birthDay: "30", birthMonth: "2" }, TODAY).dateOfBirth).toBe(
      "Enter a real date of birth.",
    );
    expect(identityErrors({ ...FORM, birthYear: "2030" }, TODAY).dateOfBirth).toBe(
      "Enter a real date of birth.",
    );
    expect(isEmail("ada@example")).toBe(false);
    expect(identityErrors({ ...FORM, email: "ada@" }, TODAY).email).toBeDefined();
    expect(identityErrors({ ...FORM, city: "  " }, TODAY)).toEqual({ city: "Enter your city." });
    expect(registrationOf({ ...FORM, city: "" }, "DE", TODAY)).toBeNull();
  });

  it("builds the registration trimmed, without an empty second line or region", () => {
    expect(registrationOf({ ...FORM, lineTwo: "  ", region: "" }, "de", TODAY)).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      dateOfBirth: "1990-03-15",
      address: { lineOne: "1 Main St", city: "Berlin", postalCode: "10115", countryCode: "DE" },
    });
    expect(
      registrationOf({ ...FORM, lineTwo: "Apt 2", region: "BE" }, "DE", TODAY)?.address,
    ).toEqual({
      lineOne: "1 Main St",
      lineTwo: "Apt 2",
      city: "Berlin",
      region: "BE",
      postalCode: "10115",
      countryCode: "DE",
    });
  });
});
