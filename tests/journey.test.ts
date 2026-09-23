import { describe, expect, it } from "vitest";
import { formatWhen, formatWhenShort, journeyLabels, shortRef } from "../app/utils/journey";

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

describe("formatWhenShort", () => {
  const now = Date.parse("2025-05-06T17:53:00");

  it("names today and yesterday, and dates anything older", () => {
    expect(formatWhenShort(Date.parse("2025-05-06T08:25:00"), "en-US", now)).toMatch(
      /^Today at 8:25\s?AM$/,
    );
    expect(formatWhenShort(Date.parse("2025-05-05T12:45:00"), "en-US", now)).toMatch(
      /^Yesterday at 12:45\s?PM$/,
    );
    expect(formatWhenShort(Date.parse("2025-05-04T12:45:00"), "en-US", now)).toMatch(
      /^May 4 at 12:45\s?PM$/,
    );
    // The list abbreviates the month, as the history frames do ("Jun 12 at 16:40").
    expect(
      formatWhenShort(
        Date.parse("2025-06-12T16:40:00"),
        "en-US",
        Date.parse("2025-06-20T09:00:00"),
      ),
    ).toMatch(/^Jun 12 at 4:40\s?PM$/);
  });

  it("counts yesterday by the calendar, not by 24 hours", () => {
    // Just after midnight: 23 hours earlier is still the day before.
    const midnight = Date.parse("2025-05-06T00:30:00");
    expect(formatWhenShort(Date.parse("2025-05-05T23:45:00"), "en-US", midnight)).toMatch(
      /^Yesterday at 11:45\s?PM$/,
    );
  });

  it("rolls back across a month boundary", () => {
    const firstOfMay = Date.parse("2025-05-01T09:00:00");
    expect(formatWhenShort(Date.parse("2025-04-30T09:00:00"), "en-US", firstOfMay)).toMatch(
      /^Yesterday at 9:00\s?AM$/,
    );
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
