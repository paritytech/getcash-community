import { afterEach, describe, expect, it, vi } from "vitest";
import { addLogSink, devLog, type LogEntry } from "./log";

describe("the debug log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("As a developer reading the console, I see a transaction hash and its explorer link whole, while what can leave the device has them cut", () => {
    // Given
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line));
    const sunk: LogEntry[] = [];
    const remove = addLogSink((entry) => void sunk.push(entry));
    const hash = `0x${"ab".repeat(32)}`;
    const link = "https://polkadot.js.org/apps/?rpc=wss#/explorer/query/5";

    // When
    devLog("coinage", `funding tx: transfer ${hash} @ block 5 ${link}`, { hash });
    remove();

    // Then
    expect(printed[0]).toBe(
      `[coinage] funding tx: transfer ${hash} @ block 5 ${link} {"hash":"${hash}"}`,
    );
    expect(sunk[0]).toMatchObject({
      message: "funding tx: transfer [redacted: hash] @ block 5 https://polkadot.js.org/apps/",
      data: '{"hash":"[redacted: hash]"}',
    });
  });

  it("As a developer reading Sentry, I never receive half of a key: a long payload is scrubbed whole before it is cut", () => {
    // Given: a 32-byte value straddling the point where the payload is cut
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sunk: LogEntry[] = [];
    const remove = addLogSink((entry) => void sunk.push(entry));
    const key = `0x${"cd".repeat(32)}`;
    // the JSON quote, 3979 characters and a space put the key across character 4000
    const payload = `${"x".repeat(3_979)} ${key}`;

    // When
    devLog("coinage", "dump", payload);
    remove();

    // Then
    expect(sunk[0]!.data).not.toContain("cdcdcdcd");
  });
});
