import { describe, expect, it } from "vitest";
import { formatWhen, journeyLabels, shortRef } from "../app/utils/journey";

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

describe("shortRef", () => {
  it("shows a long reference as its ends, ignoring separators", () => {
    expect(shortRef("a1f9c3d2-7b44-4e10-9f21-00ab9e4c2e")).toBe("a1f9-4c2e");
    // Same id unhyphenated abbreviates identically, so the two forms compare by eye.
    expect(shortRef("a1f9c3d27b444e109f2100ab9e4c2e")).toBe("a1f9-4c2e");
  });

  it("leaves a reference short enough to read in full alone", () => {
    // Shortening one that already fits would cost the reader the middle for nothing.
    expect(shortRef("a1f9-4c2e")).toBe("a1f9-4c2e");
    expect(shortRef("mock-1")).toBe("mock-1");
  });
});
