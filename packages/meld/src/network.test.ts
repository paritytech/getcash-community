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

  it("strips the web host's .li mirror, so the browser and previews resolve", () => {
    expect(networkForHostname("getcash.app.paseo.li")).toBe("paseo-next-v2");
    expect(networkForHostname("pr65-getcash.app.paseo.li")).toBe("paseo-next-v2");
    expect(networkForHostname("pr65-getcash.paseo.li")).toBe("paseo-next-v2");
    expect(networkForHostname("dot.li")).toBe("polkadot-test");
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
  it("uses the override for a host that names no network, which is how localhost names one", () => {
    expect(currentNetwork("localhost", "paseo-next-v2")).toBe("paseo-next-v2");
  });

  it("lets the hostname win over an override, so a build-baked override cannot mislabel a deployment", () => {
    expect(currentNetwork("getcash.paseo", "polkadot-test")).toBe("paseo-next-v2");
  });

  it("ignores an override that is absent, empty or whitespace", () => {
    expect(currentNetwork("getcash.paseo", undefined)).toBe("paseo-next-v2");
    expect(currentNetwork("getcash.paseo", "")).toBe("paseo-next-v2");
    expect(currentNetwork("getcash.paseo", "   ")).toBe("paseo-next-v2");
  });

  it("is undefined when neither the hostname nor the override names a network", () => {
    expect(currentNetwork("localhost", undefined)).toBeUndefined();
  });
});
