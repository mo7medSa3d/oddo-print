# Test Results Log

## Summary of All Executed Validation Suites

| Suite Name | Execution Command | Result | Pass Count | Failure Count | Skipped Count | Execution Time |
|------------|-------------------|--------|------------|---------------|---------------|----------------|
| **Vitest Node Unit Suite** | `npx vitest run --config vitest.unit.config.mts` | **PASS** | 300 | 0 | 5 (E2E acceptance) | 4.66s |
| **Go Agent Unit Suite** | `cd agent && go test -count=1 -p 2 ./...` | **PASS** | 100% passing | 0 | 0 | 25.21s |
| **Go Race Detector** | `cd agent && go test -race ./...` | **PASS** | 100% passing | 0 | 0 | 38.14s |
| **Go Vet Analysis** | `cd agent && go vet ./...` | **PASS** | 0 warnings | 0 | 0 | 0.85s |
| **Go Code Formatting** | `cd agent && gofmt -l .` | **PASS** | 0 files | 0 | 0 | 0.12s |
| **TypeScript Compiler** | `npx tsc --noEmit` | **PASS** | 0 errors | 0 | 0 | 3.20s |
| **ESLint Static Linter** | `npx eslint .` | **PASS** | 0 errors | 0 | 0 | 2.45s |
| **UI Smoke Test** | `npx vitest run tests/desktop-ui-smoke.test.ts` | **PASS** | 1 | 0 | 0 | 1.45s |
| **DoS Hardening Contract** | `npx vitest run tests/dos-hardening-contract.test.ts` | **PASS** | 6 | 0 | 0 | 0.80s |
