import { describe, expect, it } from "vitest";
import { getTheme, themeFromHost } from "../app/theme/theme";

describe("themeFromHost", () => {
  it("a recognised custom name wins, whatever the host calls it", () => {
    expect(themeFromHost({ name: { tag: "Custom", value: "lisbon" }, variant: "Light" })).toBe(
      "lisbon",
    );
    expect(
      themeFromHost({ name: { tag: "Custom", value: "Berlin Night" }, variant: "Dark" }),
    ).toBe("berlin-night");
    expect(themeFromHost({ name: { tag: "Custom", value: "  Tokyo " }, variant: "Light" })).toBe(
      "tokyo",
    );
  });

  it("an unrecognised name falls back to the variant", () => {
    expect(themeFromHost({ name: { tag: "Custom", value: "midnight" }, variant: "Dark" })).toBe(
      "berlin-night",
    );
    expect(themeFromHost({ name: { tag: "Custom", value: "midnight" }, variant: "Light" })).toBe(
      "berlin-day",
    );
  });

  it("the default host theme maps by variant", () => {
    expect(themeFromHost({ name: { tag: "Default" }, variant: "Dark" })).toBe("berlin-night");
    expect(themeFromHost({ name: { tag: "Default" }, variant: "Light" })).toBe("berlin-day");
  });
});

describe("getTheme", () => {
  it("survives storage that throws on access (partitioned iframe)", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    try {
      expect(getTheme()).toBe("berlin-night");
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
