// The preview deck's list scenes: every card still running is a real record, projected by the
// package adapters.
//
// The bug this pins: the running cards used to be hand-written rows whose ids ("p1") named no
// request, so tapping one reached "Top-up unavailable" by construction. A row the adapters built
// carries the request's own id, so the id has to parse back to a record the store holds — and the
// status line has to be the progress machine's word on the stage, not a literal in the scene.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { chainflipRequestRef, projectChainflipTopUps } from "../app/funding/chainflip-top-ups";
import { meldRequestRef, projectMeldTopUps } from "../app/funding/meld-top-ups";
import type { FundingTopUp } from "../app/funding/top-ups";
import { useRequestsStore } from "../app/stores/requests";
import { directScene, SCENES } from "../app/utils/dev-preview";
import { previewTopUpScene } from "../app/utils/dev-preview-top-ups";
import { requestRefKey } from "../app/utils/request-index";

/** The rows a list scene puts on the screen, exactly as `app/pages/index.vue` assembles them:
 *  the scene's own finished rows, then whatever the adapters project from its records. */
function sceneRows(now: number): FundingTopUp[] {
  const { openTopUps } = useRequestsStore();
  return [
    ...(previewTopUpScene.value?.topUps ?? []),
    ...projectChainflipTopUps(openTopUps, now),
    ...projectMeldTopUps(openTopUps, now),
  ];
}

/** Walks the ring once, collecting the rows of every scene whose name says it is a list. */
async function listScenes(): Promise<Map<string, FundingTopUp[]>> {
  const out = new Map<string, FundingTopUp[]>();
  const now = Date.now();
  for (let n = 0; n < SCENES.length; n++) {
    const label = await directScene(1);
    const name = label.slice(label.indexOf(" ") + 1);
    if (name.startsWith("list / ")) out.set(name, sceneRows(now));
  }
  return out;
}

/** A row's status line, whatever state it is in. */
function status(row: FundingTopUp): string {
  const { state } = row;
  return state.kind === "awaiting-transfer" || state.kind === "finishing"
    ? state.status
    : state.kind;
}

describe("preview deck list scenes", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("names every running card's request, so opening one has something to open", async () => {
    const requests = useRequestsStore();
    const now = Date.now();
    let running = 0;
    // Checked as each scene is applied: the next one empties the sandbox, so a record only
    // answers for the scene that seeded it.
    for (let n = 0; n < SCENES.length; n++) {
      const label = await directScene(1);
      const name = label.slice(label.indexOf(" ") + 1);
      if (!name.startsWith("list / ")) continue;
      for (const row of sceneRows(now)) {
        if (row.state.kind === "settled" || row.state.kind === "failed") continue;
        running++;
        const ref = chainflipRequestRef(row.id) ?? meldRequestRef(row.id);
        expect(ref, `${name}: ${row.id} names no request`).not.toBeNull();
        expect(requests.has(ref!), `${name}: no record for ${requestRefKey(ref!)}`).toBe(true);
      }
    }
    // The walk has to have found some, or the assertion above never ran.
    expect(running).toBeGreaterThan(0);
  });

  it("words each stage as the progress machine does, not as the scene says", async () => {
    const scenes = await listScenes();
    const lineOf = (name: string) => scenes.get(name)!.map(status);
    expect(lineOf("list / top-up: waiting")).toEqual(["Waiting for your transfer"]);
    expect(lineOf("list / top-up: converting")).toEqual(["Converting to $CASH"]);
    expect(lineOf("list / top-up: adding")).toEqual(["Adding to your balance"]);
    // The fiat rails word their own leg, and wait on a payment rather than a transfer.
    expect(lineOf("list / top-up: retrying")).toEqual(["Confirming your payment"]);
    expect(lineOf("list / top-up: taking longer")).toEqual(["Confirming your payment"]);
  });

  it("ambers a delayed card off the record's own rail state", async () => {
    const scenes = await listScenes();
    for (const name of ["list / top-up: retrying", "list / top-up: taking longer"]) {
      expect(
        scenes.get(name)!.map((row) => row.delayed),
        name,
      ).toEqual([true]);
    }
    // Nothing else is amber: the flag comes off the rail, so a scene cannot assert it by hand.
    expect(scenes.get("list / top-up: waiting")!.map((row) => row.delayed)).toEqual([undefined]);
  });

  it("lists nothing on a scene that seeds nothing", async () => {
    const scenes = await listScenes();
    expect(scenes.get("list / history: empty")).toEqual([]);
    expect(scenes.get("list / history: loading")).toEqual([]);
  });

  it("puts the collapse past its bound, with the settled row at the end", async () => {
    const rows = (await listScenes()).get("list / top-ups: show more")!;
    expect(rows.filter((row) => row.state.kind === "settled")).toHaveLength(1);
    // Four running cards: three fit before the collapse, so Show more has to be drawn.
    expect(rows.filter((row) => row.state.kind !== "settled").length).toBeGreaterThan(3);
  });
});
