import { describe, expect, it } from "vitest";

import { currentNetwork, networkForHostname } from "./network";

/**
 * The mapping is the load-bearing part: the adapter matches these ids exactly against
 * `auth.personhood.networks[].id`, so a name that drifts here is a 401 that reads as "you are not
 * a person" rather than "this page did not know where it was".
 */
describe("networkForHostname", () => {
  it("maps each deployed TLD to its networks.json id", () => {
    expect(networkForHostname("getcash.testnet")).toBe("previewnet");
    expect(networkForHostname("getcash.paseo")).toBe("paseo-next-v2");
    expect(networkForHostname("getcash.dot")).toBe("polkadot-test");
  });

  it("reads the last label, so a subdomain does not change the answer", () => {
    expect(networkForHostname("app.getcash.paseo")).toBe("paseo-next-v2");
  });

  // The deploy matrix calls previewnet `preview`, and `networks.json` calls it `previewnet`. The
  // adapter only knows the latter, so the former must never be what reaches it.
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

  // An unset env var arrives as "" or whitespace far more often than as undefined, and treating
  // either as a real answer would pin every deployment to a network named by the empty string.
  it("ignores an override that is absent, empty or whitespace", () => {
    expect(currentNetwork("getcash.paseo", undefined)).toBe("paseo-next-v2");
    expect(currentNetwork("getcash.paseo", "")).toBe("paseo-next-v2");
    expect(currentNetwork("getcash.paseo", "   ")).toBe("paseo-next-v2");
  });

  it("is undefined when neither the override nor the hostname names a network", () => {
    expect(currentNetwork("localhost", undefined)).toBeUndefined();
  });
});
