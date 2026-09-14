// The parity oracle for the request state machine: how today's records project into list rows,
// and what the journey and deposit screens see per preview scene. Milestones 2, 5 and 8 must
// reproduce these snapshots; nothing edits them except where a milestone says so.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { projectChainflipTopUps } from "../app/funding/chainflip-top-ups";
import { projectMeldTopUps } from "../app/funding/meld-top-ups";
import { migrateRecord } from "../app/funding/requests/migrate";
import type { Observation, WorkerJobView } from "../app/funding/requests/model";
import { reduce } from "../app/funding/requests/reducer";
import { useFlowStore } from "../app/stores/flow";
import { useSessionStore } from "../app/stores/session";
import { directScene, SCENES } from "../app/utils/dev-preview";
import { requestRefKey, requestRefOf } from "../app/utils/request-index";
import { FIXTURE_NOW, fixtureRecords } from "./fixtures/requests";

// The preview deck parses its milestone origin as local time; the snapshot must not depend on the
// machine's zone.
process.env.TZ = "UTC";

/** The instant the scenes are applied at: every `Date.now()` the deck reads. */
const PREVIEW_NOW = Date.UTC(2025, 4, 6, 18, 0, 0);

/** The fixtures as the store holds them: migrated under their own keys at the fixture instant. */
const migratedFixtures = fixtureRecords.map((record) => {
  const migrated = migrateRecord(
    record,
    requestRefOf(record.sourceId, record.tradeN!),
    FIXTURE_NOW,
  );
  if (migrated === null) throw new Error("fixture did not migrate");
  return migrated;
});

/** The worker's job at the fixture instant, its deposit in hand. */
const worker = (job: Partial<WorkerJobView> & { phase: string }): Observation => ({
  source: "worker",
  at: FIXTURE_NOW,
  job: { done: false, fundsSeenAt: FIXTURE_NOW, lastTickAt: FIXTURE_NOW, claim: null, ...job },
});

describe("request list projection", () => {
  it("projects the fixture records exactly as today", () => {
    expect({
      chainflip: projectChainflipTopUps(migratedFixtures, FIXTURE_NOW),
      meld: projectMeldTopUps(migratedFixtures, FIXTURE_NOW),
    }).toMatchSnapshot();
  });

  it("projects the fixture records with live statuses exactly as today", () => {
    const live: Record<string, Observation> = {
      "dot-assethub#3": worker({ phase: "swap" }),
      "dot-assethub#4": worker({
        phase: "failed",
        failure: "shortfall",
        lastError: "funding failed in the background",
      }),
      "meld-card#2": worker({ phase: "await-arrival" }),
    };
    const records = migratedFixtures.map((record) => {
      const observation = live[requestRefKey(record.ref)];
      return observation === undefined ? record : reduce(record, observation);
    });
    expect({
      chainflip: projectChainflipTopUps(records, FIXTURE_NOW),
      meld: projectMeldTopUps(records, FIXTURE_NOW),
    }).toMatchSnapshot();
  });
});

describe("preview scenes", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PREVIEW_NOW);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("foreground views per preview scene match the snapshot", async () => {
    setActivePinia(createPinia());
    const session = useSessionStore();
    const flow = useFlowStore();
    const views = [];
    for (let n = 0; n < SCENES.length; n++) {
      const scene = await directScene(session, flow, 1);
      await nextTick();
      views.push({
        scene,
        phase: session.phase,
        fundsSeen: session.fundsSeen,
        fundingStep: session.fundingStep,
        fundingError: session.fundingError,
        fundingNotice: session.fundingNotice,
        claimStage: session.claimStage,
        claimedBase: session.claimedBase,
        journeyDone: session.journeyDone,
        milestones: { ...session.milestones },
        meldStage: session.meldStage,
        meldDelayed: session.meldDelayed,
        meldFailureMessage: session.meldFailureMessage,
        meldSubmitted: session.meldSubmitted,
        meldHandedOff: session.meldHandedOff,
        foregroundSnapshot: session.foregroundProgress?.snapshot,
      });
    }
    expect(views).toMatchSnapshot();
  });
});
