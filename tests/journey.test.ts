import { describe, expect, it } from "vitest";
import { formatWhen, journeyLabels } from "../app/utils/journey";

describe("journeyLabels", () => {
  it("names what arrived when the asset is known", () => {
    expect(journeyLabels("BTC")[1]!.done).toBe("We received your BTC");
    expect(journeyLabels(null)[1]!.done).toBe("We received your payment");
    expect(journeyLabels("BTC")).toHaveLength(5);
  });
});

describe("formatWhen", () => {
  it("reads like the design: weekday, month, day, time", () => {
    // 2025-05-06 was a Tuesday. Parsed as local time.
    const ms = Date.parse("2025-05-06T17:53:00");
    expect(formatWhen(ms, "en-US")).toMatch(/^Tuesday, May 6 at 5:53\s?PM$/);
  });
});
