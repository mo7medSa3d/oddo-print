import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { integrationVitestTestFiles } from "./vitest.test-groups.mts";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": resolve(rootDir, "src") } },
  test: {
    clearMocks: false,
    include: ["tests/**/*.test.ts"],
    exclude: [...integrationVitestTestFiles],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
