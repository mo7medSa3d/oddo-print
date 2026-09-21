# Test & CI Recertification Report

> **Historical verification record — superseded.**
>
> This document records the state of a specific repository baseline and execution environment at the time it was written. Its PASS/BLOCKED/FAIL/NOT PRODUCTION READY findings are **not a current status verdict for `main`**. Do not use the environment limitations in this report as evidence that the current repository has the same limitations. Current status must be established from the current `main` commit, current source, and current CI/release evidence.

## A. Test Inventory

The supplied repository was treated as the source of truth and compared before and after reconciliation.

| Area | Count |
|---|---:|
| Vitest `*.test.ts` files | 61 |
| PostgreSQL/DB-gated Vitest files | 24 |
| Pure/unit Vitest files | 37 |
| Go `*_test.go` files | 41 |
| Odoo Python test files | 6 |
| GitHub Actions workflows | 6 |
| GitHub Actions jobs | 9 |

DB-gated Vitest suites are now declared once in `vitest.test-groups.mts` and consumed by both the unit and integration configurations.

## B. Stale Tests Found

The previous `test:unit` script used a hand-maintained exclusion list of 12 files. The current repository had 24 DB-gated files, so 12 DB-backed suites were still being loaded by the unit configuration and silently skipped when `DATABASE_URL` was absent.

The previous integration configuration listed 15 of the 24 DB-gated test files. The following nine DB-gated suites were therefore omitted from the integration workflow entirely:

- `tests/agent-deletion.test.ts`
- `tests/dashboard-payload-projection.test.ts`
- `tests/discovery-approval.test.ts`
- `tests/job-maintenance.test.ts`
- `tests/legacy-print-authorization.test.ts`
- `tests/lifecycle-delivery.test.ts`
- `tests/manager-auth.test.ts`
- `tests/runtime-constraints.test.ts`
- `tests/tenant-isolation.test.ts`

These were classification/coverage defects in the verification system, not a reason to change production behavior.

Intentional legacy manager references remain in `manager-auth`-related tests because the repository still contains a separate manager bootstrap/authentication path. They are not used as the normal customer Email + Password authentication model.

## C. Tests Updated

### `vitest.test-groups.mts`

Created the canonical list of all database-backed Vitest files plus the existing `ci-tripwire.check.ts` integration check.

### `vitest.unit.config.mts`

Created a dedicated unit configuration that includes all `tests/**/*.test.ts` files except the canonical DB-gated integration set.

### `vitest.integration.config.mts`

Changed the integration configuration to consume the canonical DB-gated list, bringing all 24 DB-backed suites into the integration job.

### `package.json`

Changed `test:unit` from a brittle manual exclusion list to:

```text
vitest run --config vitest.unit.config.mts
```

### Regression contracts

Added:

```text
tests/test-suite-classification.contract.test.ts
tests/ci-toolchain.contract.test.ts
```

These validate test classification, current package scripts, Node runtime alignment, Go workflow alignment, workflow script references, and immutable GitHub Action pinning.

## D. Production Bugs Found Through Tests

No new production-runtime defect was exposed by this recertification pass that could be responsibly fixed without an executable Node/PostgreSQL/Go/Odoo environment.

The confirmed defects were in the verification system itself:

1. Unit tests could silently contain DB-gated suites.
2. Integration configuration omitted nine DB-gated suites.
3. `ci.yml` manually selected Go `1.27.1` while `agent/go.mod` declares Go `1.26`.
4. CI separately re-ran the migration-upgrade and multi-instance tests even though they belong to the canonical integration set.

The workflow was changed so the integration job executes the full canonical integration set with `RUN_MULTI_INSTANCE_TEST=1`.

## E. GitHub Actions Updated

### `.github/workflows/ci.yml`

Changed Go setup from a manually maintained newer version:

```yaml
go-version: '1.27.1'
```

to the repository source of truth:

```yaml
go-version-file: agent/go.mod
```

The integration job now runs the full canonical integration group once with:

```yaml
RUN_MULTI_INSTANCE_TEST: '1'
```

This removes the stale duplicate special-case test invocations.

Other workflows were reviewed and left unchanged where they already matched the current source-of-truth configuration. In particular, the Windows build and supply-chain workflows already use `go-version-file: agent/go.mod`; workflows provisioning Node already use `.nvmrc`.

All six workflow files parse successfully, and all third-party GitHub Action references remain SHA-pinned.

## F. Runtime Versions

Repository-declared versions:

```text
Node engine: >=24.15.0
.nvmrc:      24.21.0
Docker Node: 24.21.0-alpine
Go:          1.26 (agent/go.mod)
PostgreSQL: 16 for Gateway integration workflows
Odoo:        19.0 container for Odoo workflow
```

Verification environment:

```text
Node:     v22.16.0
npm:      10.9.2
Go:       1.23.2
Python:   3.13.5
Docker:   unavailable
Rust:     unavailable
PostgreSQL: unavailable as a local executable/service
Odoo runtime: unavailable
Windows:  unavailable
```

## G. Full Verification Matrix

| Check | Result | Evidence |
|---|---|---|
| Workflow YAML parsing | PASS | All 6 workflow YAML files parsed successfully |
| Odoo XML parsing | PASS | All addon XML files parsed successfully |
| Test classification reconciliation | PASS | 24/24 DB-gated files match canonical integration list |
| Workflow → package script references | PASS | No missing `npm run` scripts found |
| Node workflow/runtime alignment | PASS | Node workflows reference `.nvmrc` |
| Go CI alignment | PASS | `ci.yml` now references `agent/go.mod` |
| GitHub Action SHA pinning | PASS | No unpinned third-party action refs found |
| package-lock root metadata | PASS | Package name/version match `package.json` |
| Go formatting (`gofmt -l .`) | PASS | No files reported |
| Odoo static test `tests/test_odoo19_printing_static.py` | PASS | Exit code 0 |
| `npm ci` with repository engine policy | BLOCKED | `engine-strict=true`; local Node 22.16.0 is below required >=24.15.0 |
| `npm ci` with engine override | BLOCKED | Local dependency installation did not complete within the execution window |
| `npm run typecheck` | BLOCKED | Incomplete dependency tree from interrupted install; local runtime is unsupported |
| `npm run lint` | BLOCKED | Local dependency installation incomplete; executable unavailable |
| `npm run test:unit` | BLOCKED | Local dependency installation incomplete; Vitest executable unavailable |
| `npm run test:integration` | BLOCKED | Requires complete Node dependency tree + PostgreSQL |
| `npm test` | BLOCKED | Requires complete Node dependency tree + supported Node runtime |
| `go vet ./...` | BLOCKED | Local Go 1.23.2 cannot execute module requiring Go >=1.26 |
| `go test ./...` | BLOCKED | Same Go toolchain constraint |
| `go test -race ./...` | BLOCKED | Same Go toolchain constraint |
| Odoo Python unit suite | BLOCKED | `odoo` Python package/runtime not installed locally |
| Odoo 19 container test | BLOCKED | Docker unavailable in this environment |
| Docker build/runtime smoke | BLOCKED | Docker unavailable in this environment |
| Rust/Tauri checks | BLOCKED | Rust/Cargo unavailable in this environment |
| Windows installer build/smoke | BLOCKED | Windows runner unavailable in this environment |
| Physical printer verification | BLOCKED | No physical printer hardware available |

## H. Remaining Issues

The remaining blockers are execution-environment limitations rather than silently skipped production checks:

1. Node 24.21.0 dependency installation and full TypeScript/Vitest execution must run on a Node 24.15+ environment.
2. Go 1.26 `vet`, tests, and race tests must run on the declared Go toolchain.
3. PostgreSQL-backed integration tests require PostgreSQL 16.
4. Odoo module tests require an Odoo 19 runtime.
5. Docker smoke/build tests require Docker.
6. Tauri/installer tests require Rust and a Windows runner.
7. Physical printer verification remains hardware-dependent.

No `.env`, secrets, `node_modules`, `.next`, coverage, temporary directories, logs, Python bytecode, or TypeScript build-info artifacts were included in the final package.

## I. Historical Final Assessment

**TEST SUITE RECERTIFIED WITH BLOCKED ENVIRONMENT CHECKS — HISTORICAL / SUPERSEDED**

The verification architecture is synchronized with the current repository: DB-backed tests are no longer silently mixed into unit execution, all current DB suites are covered by the integration configuration, CI uses declared Go/Node runtimes, duplicate integration invocations were removed, and static workflow/test contract checks pass.

The recorded environment could not honestly declare the repository fully green because the required production toolchains and services were not available at that time. This is an environment-scoped historical observation, not a current `main` status verdict.
