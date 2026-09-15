import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSessionStore } from "../app/stores/session";
import { useMeldJourneyStatus } from "../app/composables/useMeldJourneyStatus";

describe("useMeldJourneyStatus", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("says the top-up was refunded rather than that it could not be completed", () => {
    const store = useSessionStore();
    store.setMethod("card");
    const status = useMeldJourneyStatus();
    store.meldStage = "failed";

    store.meldRefunded = true;
    expect(status.value).toEqual({ text: "Top-up refunded", tone: "failed" });

    // A plain decline still reads as a failure, named after the rail.
    store.meldRefunded = false;
    expect(status.value).toEqual({ text: "Card payment could not be completed", tone: "failed" });
  });

  it("names the bank rail on a bank-transfer failure", () => {
    const store = useSessionStore();
    store.setMethod("bank");
    const status = useMeldJourneyStatus();
    store.meldStage = "failed";
    expect(status.value).toEqual({ text: "Bank transfer could not be completed", tone: "failed" });
  });

  it("adds nothing on the crypto route", () => {
    const store = useSessionStore();
    store.setMethod("crypto");
    expect(useMeldJourneyStatus().value).toBeNull();
  });
});
