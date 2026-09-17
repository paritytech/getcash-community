// The preview deck's container contract: every scene names the shell container it wants, and the
// ring is symmetric. A scene with no stage is the bug the user saw — cycling wrote store state
// that the container on screen never reads, so the deck looked stuck.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { directScene } from "../app/utils/dev-preview";
import { previewStage, type PreviewStage } from "../app/utils/dev-preview-stage";

/** Walks the whole ring once from wherever it starts, collecting each scene's label and stage. */
function walk(delta: 1 | -1): { label: string; stage: PreviewStage | null }[] {
  const first = directScene(delta);
  const total = Number(first.split("/")[1]!.split(" ")[0]);
  const seen = [{ label: first, stage: previewStage.value }];
  for (let n = 1; n < total; n++) {
    const label = directScene(delta);
    seen.push({ label, stage: previewStage.value });
  }
  return seen;
}

describe("preview deck staging", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("stages every scene", () => {
    const scenes = walk(1);
    expect(scenes.length).toBeGreaterThan(1);
    for (const { label, stage } of scenes) {
      expect(stage, `${label} has no stage`).not.toBeNull();
    }
  });

  it("puts a scene on the container its name belongs to", () => {
    for (const { label, stage } of walk(1)) {
      const name = label.slice(label.indexOf(" ") + 1);
      if (name.startsWith("list / ")) expect(stage, name).toEqual({ kind: "shell" });
      else if (name.startsWith("card / ")) expect(stage?.kind, name).toBe("journey");
      else if (name.startsWith("crypto / ")) expect(stage?.route, name).toBe("crypto");
    }
  });

  it("gives a scene the same stage whichever way it was reached", () => {
    const forward = new Map(walk(1).map(({ label, stage }) => [label, stage]));
    for (const { label, stage } of walk(-1)) {
      expect(stage, label).toEqual(forward.get(label));
    }
  });
});
