import { describe, expect, it } from "vitest";
import { formatRemaining } from "../app/utils/countdown";

describe("formatRemaining", () => {
  it("renders the full window and ticks down fixed-width", () => {
    expect(formatRemaining(86_400_000)).toBe("24:00:00");
    expect(formatRemaining(86_399_000)).toBe("23:59:59");
    expect(formatRemaining(3_601_000)).toBe("1:00:01");
    expect(formatRemaining(299_000)).toBe("0:04:59");
    expect(formatRemaining(1_000)).toBe("0:00:01");
  });

  it("clamps at zero instead of counting up after expiry", () => {
    expect(formatRemaining(0)).toBe("0:00:00");
    expect(formatRemaining(-5_000)).toBe("0:00:00");
    expect(formatRemaining(999)).toBe("0:00:00"); // sub-second remainder rounds down, not up
  });
});
