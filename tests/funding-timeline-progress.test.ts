import { describe, expect, it } from "vitest";

import { stepLine } from "../app/funding/timeline/progress";

describe("step line", () => {
  it("names the step in progress, one past those done", () => {
    expect(stepLine("Swap", 0, 4)).toBe("Swap 1 of 4");
    expect(stepLine("Swap", 1, 4)).toBe("Swap 2 of 4");
  });

  it("stays on the last step once all are done", () => {
    expect(stepLine("Confirmation", 3, 3)).toBe("Confirmation 3 of 3");
    expect(stepLine("Confirmation", 5, 3)).toBe("Confirmation 3 of 3");
  });
});
