// Where the pages for developers show: the preview of a pull request under each name a host or
// the web serves it by, and a developer's copy. Never a released app.

import { describe, expect, it } from "vitest";
import { isPreviewOrLocal } from "../app/utils/pr-preview";

describe("isPreviewOrLocal", () => {
  it.each<[string, string, string]>([
    ["the preview's own name", "pr185-getcash.paseo", "https:"],
    ["the name a host serves a product by", "app.pr185-getcash.paseo", "https:"],
    ["the same under the host's own scheme", "app.pr185-getcash.paseo", "polkadot:"],
    ["the web mirror", "pr185-getcash.paseo.li", "https:"],
    ["the web mirror of a product", "pr185-getcash.app.paseo.li", "https:"],
    ["a preview with a short number", "pr7-getcash.paseo", "https:"],
    ["a developer's server", "localhost", "http:"],
    ["a developer's server by its address", "127.0.0.1", "http:"],
  ])("shows on %s", (_name, hostname, protocol) => {
    expect(isPreviewOrLocal({ hostname, protocol })).toBe(true);
  });

  it.each<[string, string, string]>([
    ["the released app on the test network", "getcash.paseo", "https:"],
    ["the released app as a host serves it", "app.getcash.paseo", "https:"],
    ["the released app under the host's own scheme", "app.getcash.paseo", "polkadot:"],
    ["the released app on its web mirror", "getcash.paseo.li", "https:"],
    ["the released app on the main network", "getcash.dot", "https:"],
    ["a name that starts with pr and has no number", "prices-getcash.paseo", "https:"],
    ["a name with pr and a dash only", "pr-getcash.paseo", "https:"],
    ["a name that holds a preview's name further in", "getcash-pr185-x.paseo", "https:"],
    ["a host with no known name", "example.com", "https:"],
  ])("does not show on %s", (_name, hostname, protocol) => {
    expect(isPreviewOrLocal({ hostname, protocol })).toBe(false);
  });
});
