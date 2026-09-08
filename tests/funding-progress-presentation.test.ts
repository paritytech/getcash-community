import { describe, expect, it } from "vitest";
import { formatFundingProgressElapsed } from "../app/funding/progress";

describe("funding progress presentation", () => {
  it("formats elapsed stage time without noisy precision", () => {
    expect(formatFundingProgressElapsed(0)).toBe("just now");
    expect(formatFundingProgressElapsed(42_900)).toBe("42s");
    expect(formatFundingProgressElapsed(128_900)).toBe("2m 08s");
    expect(formatFundingProgressElapsed(3_905_000)).toBe("1h 05m");
  });

  it("clamps future stage timestamps to the present", () => {
    expect(formatFundingProgressElapsed(-5_000)).toBe("just now");
  });
});
