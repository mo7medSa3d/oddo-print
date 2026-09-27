import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: resolve(rootDir, "src") },
      { find: /^@point_of_sale\/.*$/, replacement: resolve(rootDir, "tests/__mocks__/odoo") },
      { find: /^@web\/.*$/, replacement: resolve(rootDir, "tests/__mocks__/odoo") },
    ],
  },
  test: {
    clearMocks: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
