import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";
import reactDeprecations from "./scripts/lint/react-deprecations.mjs";

export default defineConfig([
  // React, accessibility and import rules are retained by .oxlintrc.json.
  // Keep the original Next/Hooks implementations on supported ESLint 10 APIs.
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    plugins: { "react-hooks": reactHooks, yaseir: { rules: { "react-no-deprecated": reactDeprecations } } },
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module", ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "yaseir/react-no-deprecated": "error",
    },
  },
  // Next's original Core Web Vitals config is global, including CommonJS.
  nextPlugin.configs["core-web-vitals"],
  {
    files: ["odoo_addons/**/*.js"],
    languageOptions: {
      globals: Object.fromEntries([
        "window", "document", "console", "crypto", "luxon", "XMLHttpRequest",
        "CustomEvent", "setTimeout", "clearTimeout",
      ].map((name) => [name, "readonly"])),
    },
    rules: {
      // These plain JS assets are not covered by the Gateway's TS typecheck.
      // A missing scope (e.g. kitchen route.raster_width) must fail CI.
      "no-undef": "error",
      "no-unused-vars": ["error", {
        args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none",
        ignoreRestSiblings: true,
      }],
      // Odoo POS assets use OWL, not React; these React rules are semantically inapplicable here.
      "react-hooks/rules-of-hooks": "off",
      // OWL's useEffect takes a dependency *function* (re-evaluated on each
      // patch), so the React rule cannot statically verify the dependency list.
      "react-hooks/exhaustive-deps": "off",
    },
  },
  globalIgnores([".audit/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "dist-desktop/**", "src-tauri/**"]),
]);
