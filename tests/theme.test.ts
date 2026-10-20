import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTheme, setTheme, themeBootScript, themeFromHost } from "../app/theme/theme";

describe("themeFromHost", () => {
  it("a recognised custom name wins, whatever the host calls it", () => {
    expect(themeFromHost({ name: { tag: "Custom", value: "lisbon" }, variant: "Light" })).toBe(
      "lisbon",
    );
    expect(themeFromHost({ name: { tag: "Custom", value: "Berlin Night" }, variant: "Dark" })).toBe(
      "berlin-night",
    );
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

function fakeRoot(initial: [string, string][] = []) {
  const attributes = new Map<string, string>(initial);
  const root = {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    hasAttribute: (name: string) => attributes.has(name),
  };
  return { attributes, root };
}

function frameQueue() {
  const frames: (() => void)[] = [];
  return {
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    flushFrame: () => frames.splice(0).forEach((callback) => callback()),
  };
}

describe("setTheme", () => {
  const g = globalThis as Record<string, unknown>;
  const keys = ["document", "requestAnimationFrame", "__THEME_PENDING_TIMER__"];
  let saved: Record<string, unknown>;
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((key) => [key, g[key]]));
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete g[key];
      else g[key] = saved[key];
    }
  });

  it("reveals a page held back for the host's theme two frames after applying it", () => {
    const { attributes, root } = fakeRoot([["data-theme-pending", ""]]);
    const frames = frameQueue();
    const fallback = vi.fn();
    g.document = { documentElement: root };
    g.requestAnimationFrame = frames.requestAnimationFrame;
    g.__THEME_PENDING_TIMER__ = setTimeout(fallback, 0);

    setTheme("lisbon");
    expect(attributes.get("data-theme")).toBe("lisbon");
    expect(attributes.has("data-theme-pending")).toBe(true);
    frames.flushFrame();
    expect(attributes.has("data-theme-pending")).toBe(true);
    frames.flushFrame();
    expect(attributes.has("data-theme-pending")).toBe(false);

    return new Promise((resolve) => setTimeout(resolve, 5)).then(() =>
      expect(fallback).not.toHaveBeenCalled(),
    );
  });

  it("reveals at once where there are no frames", () => {
    const { attributes, root } = fakeRoot([["data-theme-pending", ""]]);
    g.document = { documentElement: root };
    delete g.requestAnimationFrame;

    setTheme("berlin-day");
    expect(attributes.has("data-theme-pending")).toBe(false);
  });
});

describe("themeBootScript", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function boot(world: { hosted?: boolean; framed?: boolean; stored: string | null }) {
    const { attributes, root } = fakeRoot();
    const frames = frameQueue();
    const win: Record<string, unknown> = { __HOST_WEBVIEW_MARK__: world.hosted };
    win.self = win;
    win.top = world.framed ? {} : win;
    const storage = { getItem: () => world.stored };
    new Function("window", "document", "localStorage", "requestAnimationFrame", themeBootScript())(
      win,
      { documentElement: root },
      storage,
      frames.requestAnimationFrame,
    );
    return { attributes, flushFrame: frames.flushFrame };
  }

  it("standalone applies the stored theme at once and holds nothing back", () => {
    const { attributes } = boot({ stored: "lisbon" });
    expect(attributes.get("data-theme")).toBe("lisbon");
    expect(attributes.has("data-theme-pending")).toBe(false);
  });

  it("standalone falls back to the default for an unknown stored value", () => {
    expect(boot({ stored: "midnight" }).attributes.get("data-theme")).toBe("berlin-night");
  });

  it("in-host holds the page back without applying the stored theme", () => {
    for (const world of [{ hosted: true }, { framed: true }]) {
      const { attributes } = boot({ ...world, stored: "lisbon" });
      expect(attributes.has("data-theme-pending")).toBe(true);
      expect(attributes.has("data-theme")).toBe(false);
    }
  });

  it("in-host falls back to the stored theme when the host never answers", () => {
    const { attributes, flushFrame } = boot({ hosted: true, stored: "lisbon" });
    vi.advanceTimersByTime(1500);
    expect(attributes.get("data-theme")).toBe("lisbon");
    expect(attributes.has("data-theme-pending")).toBe(true);
    flushFrame();
    flushFrame();
    expect(attributes.has("data-theme-pending")).toBe(false);
  });
});
