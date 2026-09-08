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
  },
});
