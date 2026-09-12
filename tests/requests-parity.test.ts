// The parity oracle for the request state machine: how today's records project into list rows,
// and what the journey and deposit screens see per preview scene. Milestones 2, 5 and 8 must
// reproduce these snapshots; nothing edits them except where a milestone says so.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { projectChainflipTopUps } from "../app/funding/chainflip-top-ups";
import { projectMeldTopUps } from "../app/funding/meld-top-ups";
import { useFlowStore } from "../app/stores/flow";
import { useSessionStore, type RequestStatus } from "../app/stores/session";
import { directScene, SCENES } from "../app/utils/dev-preview";
import { FIXTURE_NOW, fixtureRecords } from "./fixtures/requests";

// The preview deck parses its milestone origin as local time; the snapshot must not depend on the
// machine's zone.
process.env.TZ = "UTC";

/** The instant the scenes are applied at: every `Date.now()` the deck reads. */
const PREVIEW_NOW = Date.UTC(2025, 4, 6, 18, 0, 0);

describe("request list projection", () => {
  it("projects the fixture records exactly as today", () => {
    expect({
      chainflip: projectChainflipTopUps(fixtureRecords, {}, FIXTURE_NOW),
      meld: projectMeldTopUps(fixtureRecords, {}, FIXTURE_NOW),
    }).toMatchSnapshot();
  });

  it("projects the fixture records with live statuses exactly as today", () => {
    const statuses = {
      "dot-assethub#3": { kind: "converting", step: "swap" },
      "dot-assethub#4": { kind: "failed", reason: "funding failed in the background" },
      "meld-card#2": { kind: "converting", step: "await-arrival" },
    } satisfies Record<string, RequestStatus>;
    expect({
      chainflip: projectChainflipTopUps(fixtureRecords, statuses, FIXTURE_NOW),
      meld: projectMeldTopUps(fixtureRecords, statuses, FIXTURE_NOW),
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
