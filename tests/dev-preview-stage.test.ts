// The preview deck's container contract: every scene names the shell container it wants, and the
// ring is symmetric. A scene with no stage is the bug the user saw — cycling wrote store state
// that the container on screen never reads, so the deck looked stuck.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { TimelineView } from "../app/funding/timeline/types";
import { directScene, SCENES } from "../app/utils/dev-preview";
import { previewStage, type PreviewStage } from "../app/utils/dev-preview-stage";
import { previewTopUpScene } from "../app/utils/dev-preview-top-ups";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore } from "../app/stores/session";

/**
 * The store state a scene is responsible for setting. Compared between the two directions of
 * travel: a field a scene leaves set is read by the next one as if it belonged to it.
 */
function sceneState(): string {
  const s = useSessionStore();
  // The record on screen owns the payment now, the rail's own ids included; only the method is
  // still the session's.
  const r = useRequestsStore();
  return JSON.stringify({
    method: s.method,
    meldServiceProvider: r.foregroundRecord?.meldServiceProvider ?? null,
    meldReference: r.foregroundRecord?.meldFundingRequestId ?? null,
    meldStage: r.meldStage,
    meldFailureCode: r.meldFailureCode,
    meldFailureMessage: r.meldFailureMessage,
    meldRefunded: r.meldRefunded,
    fundingError: r.fundingError,
    fundingNotice: r.fundingNotice,
    claimStage: r.claimStage,
    fundsSeen: r.fundsSeen,
    phase: r.phase,
  });
}

/** The timeline the journey draws for the scene on stage: the live record's, else its row's. */
function journeyView(): TimelineView | undefined {
  const requests = useRequestsStore();
  const withdrawal = requests.foregroundWithdrawal;
  if (withdrawal !== null) return requests.withdrawalTimelineOf(withdrawal, Date.now()).view;
  if (requests.foregroundRecord !== null) return requests.foregroundTimeline(Date.now())?.view;
  const stage = previewStage.value;
  const id = stage?.kind === "journey" ? stage.topUpId : undefined;
  return previewTopUpScene.value?.topUps?.find((topUp) => topUp.id === id)?.timeline?.view;
}

/** Walks the whole ring once from wherever it starts, collecting what each scene leaves behind. */
async function walk(
  delta: 1 | -1,
): Promise<{ label: string; stage: PreviewStage | null; state: string }[]> {
  const first = await directScene(delta);
  const total = Number(first.split("/")[1]!.split(" ")[0]);
  const seen = [{ label: first, stage: previewStage.value, state: sceneState() }];
  for (let n = 1; n < total; n++) {
    const label = await directScene(delta);
    seen.push({ label, stage: previewStage.value, state: sceneState() });
  }
  return seen;
}

describe("preview deck staging", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("stages every scene", async () => {
    const scenes = await walk(1);
    expect(scenes.length).toBeGreaterThan(1);
    for (const { label, stage } of scenes) {
      expect(stage, `${label} has no stage`).not.toBeNull();
    }
  });

  it("puts a scene on the container its name belongs to", async () => {
    for (const { label, stage } of await walk(1)) {
      const name = label.slice(label.indexOf(" ") + 1);
      if (name.startsWith("top-up / list") || name.startsWith("top-up / history")) {
        expect(stage, name).toEqual({ kind: "shell" });
      } else if (/^top-up \/ (card|bank) \/ (summary|picker)/.test(name))
        expect(stage, name).toEqual({ kind: "package", route: name.split(" / ")[1] });
      else if (name.startsWith("top-up / card / ")) expect(stage?.kind, name).toBe("journey");
      else if (name.startsWith("top-up / crypto / ")) expect(stage?.route, name).toBe("crypto");
      else if (name.startsWith("withdrawal / ")) expect(stage?.kind, name).toBe("withdraw-package");
    }
  });

  it("gives a scene the same stage whichever way it was reached", async () => {
    const forward = new Map((await walk(1)).map(({ label, stage }) => [label, stage]));
    for (const { label, stage } of await walk(-1)) {
      expect(stage, label).toEqual(forward.get(label));
    }
  });

  it("draws the failed milestone on the journeys that failed", async () => {
    // Started fails where nothing was paid; a card that failed after the payment fails Accepted.
    const expected: Record<string, number> = {
      "top-up / crypto / deposit: expired": 0,
      "top-up / card / journey: payment failed": 1,
      "top-up / crypto / expired: from history": 0,
      "top-up / card / expired: from history": 0,
      "top-up / card / journey: unconfirmed": 0,
      // A withdrawal fails the milestone after the last the record evidences.
      "withdrawal / crypto / journey: payment failed": 0,
      "withdrawal / crypto / journey: expired": 0,
      "withdrawal / crypto / journey: cancelled": 0,
      "withdrawal / crypto / journey: refunded": 4,
      // The XCM left People, so a hold fails the arrival on Asset Hub.
      "withdrawal / crypto / journey: held": 2,
      "withdrawal / card / journey: sale ended": 0,
      // The sale rail reports every ending as unknown, so a decline fails the hand-off's next.
      "withdrawal / card / journey: provider cancelled": 4,
      "withdrawal / card / journey: declined": 4,
      "withdrawal / bank / journey: declined": 4,
    };
    const failed: Record<string, number | undefined> = {};
    for (let n = 0; n < SCENES.length; n++) {
      const label = await directScene(1);
      const name = label.slice(label.indexOf(" ") + 1);
      if (!(name in expected)) continue;
      const view = journeyView();
      failed[name] = view?.state === "failed" ? view.failed : undefined;
    }
    expect(failed).toEqual(expected);
  });

  it("leaves no state behind for the next scene to read as its own", async () => {
    // Each direction reaches a scene from a different neighbour, so anything a scene fails to
    // reset shows up here as two different readings of the same scene. Two record-driven card
    // scenes once looked identical this way, both showing the previous scene's live payment.
    const forward = new Map((await walk(1)).map(({ label, state }) => [label, state]));
    for (const { label, state } of await walk(-1)) {
      expect(JSON.parse(state), label).toEqual(JSON.parse(forward.get(label)!));
    }
  });
});
