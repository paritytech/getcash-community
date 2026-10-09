// The build flag that picks the Meld on-ramp flow: the widget unless the build names native, and a
// clear refusal of anything else.

import { afterEach, describe, expect, it, vi } from "vitest";
import { meldMode, parseMeldMode } from "../lib/meld-mode";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseMeldMode", () => {
  it("is the widget when the build names no mode", () => {
    expect(parseMeldMode(undefined)).toBe("iframe");
    expect(parseMeldMode("")).toBe("iframe");
  });

  it("takes either mode by name", () => {
    expect(parseMeldMode("iframe")).toBe("iframe");
    expect(parseMeldMode("native")).toBe("native");
  });

  it("refuses any other value, naming the variable and the value", () => {
    for (const value of ["Native", " native", "headless", "widget"]) {
      expect(() => parseMeldMode(value)).toThrow(`VITE_MELD_MODE must be "native" or "iframe"`);
    }
    expect(() => parseMeldMode("headless")).toThrow(`not "headless"`);
  });
});

describe("meldMode", () => {
  it("reads the build's VITE_MELD_MODE", () => {
    vi.stubEnv("VITE_MELD_MODE", undefined);
    expect(meldMode()).toBe("iframe");
    vi.stubEnv("VITE_MELD_MODE", "native");
    expect(meldMode()).toBe("native");
    vi.stubEnv("VITE_MELD_MODE", "embedded");
    expect(() => meldMode()).toThrow("VITE_MELD_MODE");
  });
});
