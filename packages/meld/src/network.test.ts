import { describe, expect, it } from "vitest";

import { currentNetwork, networkForHostname } from "./network";

describe("networkForHostname", () => {
  it("maps each deployed TLD to its networks.json id", () => {
    expect(networkForHostname("getcash.testnet")).toBe("previewnet");
    expect(networkForHostname("getcash.paseo")).toBe("paseo-next-v2");
    expect(networkForHostname("getcash.dot")).toBe("polkadot-test");
  });

  it("reads the last label, so a subdomain does not change the answer", () => {
    expect(networkForHostname("app.getcash.paseo")).toBe("paseo-next-v2");
  });

  // The deploy matrix calls previewnet `preview`; the adapter only knows `previewnet`.
  it("does not answer for the deploy workflow's own env names", () => {
    expect(networkForHostname("getcash.preview")).toBeUndefined();
  });

  it("returns undefined for a hostname naming no network, rather than guessing one", () => {
    expect(networkForHostname("localhost")).toBeUndefined();
    expect(networkForHostname("getcash.example.com")).toBeUndefined();
    expect(networkForHostname("")).toBeUndefined();
  });
});

describe("currentNetwork", () => {
  it("prefers an explicit override, which is how localhost names a network at all", () => {
    expect(currentNetwork("localhost", "paseo-next-v2")).toBe("paseo-next-v2");
  });

  it("lets the override win over a hostname that also names one", () => {
    expect(currentNetwork("getcash.paseo", "polkadot-test")).toBe("polkadot-test");
  });

  it("ignores an override that is absent, empty or whitespace", () => {
    expect(currentNetwork("getcash.paseo", undefined)).toBe("paseo-next-v2");
    expect(currentNetwork("getcash.paseo", "")).toBe("paseo-next-v2");
    expect(currentNetwork("getcash.paseo", "   ")).toBe("paseo-next-v2");
  });

  it("is undefined when neither the override nor the hostname names a network", () => {
    expect(currentNetwork("localhost", undefined)).toBeUndefined();
  });
});
