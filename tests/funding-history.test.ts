import { describe, expect, it } from "vitest";
import { formatFundingHistoryWhen } from "../app/funding/history";

describe("funding history dates", () => {
  it("formats activity from today with its time", () => {
    const now = new Date(2026, 7, 31, 18, 0).getTime();
    const at = new Date(2026, 7, 31, 9, 41).getTime();
    expect(formatFundingHistoryWhen(at, now)).toBe("Today, 9:41");
  });

  it("formats earlier activity with day and abbreviated month", () => {
    const now = new Date(2026, 7, 31).getTime();
    const at = new Date(2026, 4, 6).getTime();
    expect(formatFundingHistoryWhen(at, now)).toBe("6 May");
  });
});
