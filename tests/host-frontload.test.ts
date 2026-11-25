// The network grant the launch prompt asks the host for: the geo lookup's host and the build's
// Meld adapter, and nothing else.

import { afterEach, expect, it, vi } from "vitest";

const asked = vi.hoisted(() => [] as { tag: string; value: unknown }[]);

vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/coinage", () => ({ readPurseBalance: vi.fn() }));
vi.mock("@parity/product-sdk-host", () => ({
  requestPermission: async (request: { tag: string; value: unknown }) => {
    asked.push(request);
    return { ok: true, value: true };
  },
  getPaymentManager: async () => null,
}));

import { frontloadHostPermissions } from "../lib/host-frontload";

afterEach(() => vi.unstubAllEnvs());

it("asks for the geo and Meld hosts only", async () => {
  vi.stubEnv("VITE_MELD_BASE_URL", "https://adapter.example/v1");

  await frontloadHostPermissions();

  expect(asked.find((request) => request.tag === "Remote")?.value).toEqual({
    domains: ["get.geojs.io", "adapter.example"],
  });
});
