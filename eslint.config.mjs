import { defineConfig, globalIgnores } from "eslint/config";
import { fixupConfigRules } from "@eslint/compat";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...fixupConfigRules(nextCoreWebVitals),
  {
    files: ["odoo_addons/**/*.js"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
      "react/no-direct-mutation-state": "off",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "dist-desktop/**", "src-tauri/**"]),
]);
