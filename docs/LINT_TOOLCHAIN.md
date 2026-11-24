# Supported lint and installation toolchain

## Installation

Use Node 24.22.1 (or a supported newer Node release) and npm 12.2.1 or newer. The exact CLI used in CI and Docker is pinned:

```sh
npx --yes npm@12.2.1 ci
npm run lint
```

The project requires strict engine and peer checks. npm 12 enforces `min-release-age=7` when resolving new versions; npm 11 ignored that previously configured option. The committed lockfile supplies exact reviewed versions and integrity digests. Do not use `--force` or `--legacy-peer-deps` to install this project.

## Why the lint stack changed

ESLint 10.13.0 is retained. The three legacy plugins bundled by eslint-config-next 16.4.2 publish peer ranges that exclude ESLint 10, while ESLint 9 is end of life. The V3 configuration imports the supported Next plugin and React Hooks plugin directly; their original Core Web Vitals/recommended rule implementations and severities are unchanged. TypeScript parsing remains on @typescript-eslint/parser. Oxlint 1.87.0 supplies the following equivalent React, accessibility and import rules, explicitly selected rather than taking a different recommended preset.

| V2 rule | V3 provider | Severity |
|---|---|---|
| `react/display-name` | Oxlint same rule | `error` |
| `react/jsx-key` | Oxlint same rule | `error` |
| `react/jsx-no-comment-textnodes` | Oxlint same rule | `error` |
| `react/jsx-no-duplicate-props` | Oxlint same rule | `error` |
| `react/jsx-no-undef` | Oxlint same rule | `error` |
| `react/no-children-prop` | Oxlint same rule | `error` |
| `react/no-danger-with-children` | Oxlint same rule | `error` |
| `react/no-direct-mutation-state` | Oxlint same rule | `error` |
| `react/no-find-dom-node` | Oxlint same rule | `error` |
| `react/no-is-mounted` | Oxlint same rule | `error` |
| `react/no-render-return-value` | Oxlint same rule | `error` |
| `react/no-string-refs` | Oxlint same rule | `error` |
| `react/no-unescaped-entities` | Oxlint same rule | `error` |
| `react/require-render-return` | Oxlint same rule | `error` |
| `import/no-anonymous-default-export` | Oxlint same rule | `warn` |
| `jsx-a11y/alt-text` | Oxlint same rule | `warn` |
| `jsx-a11y/aria-props` | Oxlint same rule | `warn` |
| `jsx-a11y/aria-proptypes` | Oxlint same rule | `warn` |
| `jsx-a11y/aria-unsupported-elements` | Oxlint same rule | `warn` |
| `jsx-a11y/role-has-required-aria-props` | Oxlint same rule | `warn` |
| `jsx-a11y/role-supports-aria-props` | Oxlint same rule | `warn` |
| `react/no-deprecated` | `yaseir/react-no-deprecated` on ESLint 10 | `error` |
| `react/jsx-uses-react`, `react/jsx-uses-vars` | ESLint 10 / TypeScript parser JSX scope tracking | Scope bookkeeping, no standalone diagnostic |

The React 19 deprecation check preserves all active deprecated API names from eslint-plugin-react 7.37.5, including named imports, destructuring, file/configured JSX pragmas, explicit component annotations, and legacy class/createClass lifecycle methods. It also recognizes imported aliases and computed literal members. It uses the current ESLint API without editing upstream peer metadata or installing an unsupported ESLint version. The API inventory is documented in the source; no package version is spoofed.

The old disabled React rules remain disabled. Odoo OWL retains its intentional exceptions for React Hooks and direct state mutation; its `no-undef` and `no-unused-vars` checks remain ESLint errors. Next Image is mapped to img for alt-text enforcement. Existing generated/build/vendor ignores remain identical.

## Regression verification

```sh
node tests/lint-react-deprecations.node.test.mjs
node tests/lint-coverage.node.test.mjs
npm run lint
```

The first executes 50 deprecated/allowed API fixtures. The second proves each of 21 migrated rules produces an actual diagnostic, checks both img and Next Image alt text, accepts a valid component, and compares every original Next/Hook rule severity, and exercises the original global Next coverage for CommonJS files. The complete lint command must run both engines. A renamed/new lint configuration triggers the app CI scope.

## Upstream references

- ESLint support: https://eslint.org/version-support/
- Next direct plugin configuration: https://nextjs.org/docs/app/api-reference/config/eslint
- Oxlint rule definitions: https://oxc.rs/docs/guide/usage/linter/rules.html
- React 7.37.5 rule inventory: https://github.com/jsx-eslint/eslint-plugin-react/blob/v7.37.5/lib/rules/no-deprecated.js
