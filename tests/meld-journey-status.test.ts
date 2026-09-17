import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { migrateRecord } from "../app/funding/requests/migrate";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore } from "../app/stores/session";
import { useMeldJourneyStatus } from "../app/composables/useMeldJourneyStatus";
import { requestRefOf } from "../app/utils/request-index";
import { FIXTURE_NOW, submittedCardRecord } from "./fixtures/requests";

/** A Meld request on screen whose rail failed with `code`; the stage and the ending the composable
 *  reads both come off the record. */
async function failedMeldRequest(code?: string): Promise<void> {
  const requests = useRequestsStore();
  requests.enterSandbox();
  const ref = requestRefOf("meld-card", 2);
  const record = migrateRecord(submittedCardRecord, ref, FIXTURE_NOW);
  if (record === null) throw new Error("fixture did not migrate");
  await requests.create(ref, {
    ...record,
    rail: {
      ...record.rail,
      status: "failed",
      stage: "failed",
      failure: {
        kind: "deposit-rejected",
        message: "The payment ended",
        ...(code === undefined ? {} : { code }),
      },
      updatedAt: FIXTURE_NOW,
    },
  });
  requests.setForeground(ref);
}

describe("useMeldJourneyStatus", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("says the top-up was refunded rather than that it could not be completed", async () => {
    const store = useSessionStore();
    store.setMethod("card");
    const status = useMeldJourneyStatus();
    await failedMeldRequest("refunded");

    expect(status.value).toEqual({ text: "Top-up refunded", tone: "failed" });
  });

  it("names the rail on a decline, which returned no money", async () => {
    const store = useSessionStore();
    store.setMethod("card");
    const status = useMeldJourneyStatus();
    await failedMeldRequest("declined");

    expect(status.value).toEqual({ text: "Card payment could not be completed", tone: "failed" });
  });

  it("names the bank rail on a bank-transfer failure", async () => {
    const store = useSessionStore();
    store.setMethod("bank");
    const status = useMeldJourneyStatus();
    await failedMeldRequest();

    expect(status.value).toEqual({ text: "Bank transfer could not be completed", tone: "failed" });
  });

  it("adds nothing on the crypto route", () => {
    const store = useSessionStore();
    store.setMethod("crypto");
    expect(useMeldJourneyStatus().value).toBeNull();
  });
});
