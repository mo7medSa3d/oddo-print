import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: resolve(rootDir, "src") },
      // The Yasser addon's pos_print_router.js imports Odoo POS modules that
      // are not installed here. Resolve every @point_of_sale/* and @web/*
      // import to the shared mock module so the real renderReceiptImage()
      // can be driven in isolation by tests/pos-receipt-font.test.ts.
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
