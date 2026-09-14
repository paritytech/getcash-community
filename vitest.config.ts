import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Nuxt's rootDir alias for app modules under test.
      "~~": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    // The Meld tests run against the offline fake client; a real adapter URL in .env must not
    // leak into them (it would turn them into hanging network calls).
    env: { VITE_MELD_BASE_URL: "" },
  },
});
