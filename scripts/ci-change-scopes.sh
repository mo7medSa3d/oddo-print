#!/usr/bin/env bash
# Fail-open, source-aware GitHub Actions gates. Missing base SHA or an
# unfamiliar path always enables all checks instead of silently skipping CI.
set -euo pipefail

scopes=(
  app agent odoo docker docker_scan supply postgres
  codeql_js codeql_py codeql_go
)
declare -A changed
for scope in "${scopes[@]}"; do changed["$scope"]=false; done

mark() {
  local scope
  for scope in "$@"; do changed["$scope"]=true; done
}
mark_all() { mark "${scopes[@]}"; }

files=()
full=false
paths_mode=false
if [[ "${1:-}" == "--paths" ]]; then
  paths_mode=true
  # Pure classification mode, used by offline regression tests.
  shift
  files=("$@")
else
  case "${GITHUB_EVENT_NAME:-}" in
    workflow_dispatch|merge_group)
      # Manual and merge-queue release gates stay exhaustive.
      full=true
      ;;
    schedule)
      # Re-scan unchanged dependencies and base images for *new* advisories,
      # without wasting weekly minutes on unchanged Docker/DB test builds.
      mark supply docker_scan codeql_js codeql_py codeql_go
      ;;
    push|pull_request)
      base="${BEFORE_SHA:-}"
      if [[ "$GITHUB_EVENT_NAME" == "pull_request" ]]; then
        base="${PR_BASE_SHA:-}"
      fi
      head="${GITHUB_SHA:-}"
      if [[ ! "$base" =~ ^[0-9a-fA-F]{40}$ ]] ||
         [[ "$base" =~ ^0{40}$ ]] ||
         [[ ! "$head" =~ ^[0-9a-fA-F]{40}$ ]]; then
        full=true
      else
        # Force-with-lease rewrites and multi-commit pushes must validate the
        # new commit against its actual parent. Comparing two superseded
        # HEADs can hide runtime changes behind a docs-only diff.
        # Read the raw commit object: shallow clones retain parent headers.
        if [[ "${GITHUB_EVENT_NAME:-}" == "push" ]]; then
          first_parent="$(git cat-file -p "$head" 2>/dev/null | awk '$1 == "parent" && !found { print $2; found = 1 }')" || first_parent=""
          if [[ "$first_parent" != "$base" ]]; then
            full=true
          fi
        fi
        if [[ "$full" == false ]]; then
          if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
            git fetch --no-tags --depth=1 origin "$base" >/dev/null 2>&1 || true
          fi
          if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
            full=true
          else
            paths_file="$(mktemp)"
            trap 'rm -f "$paths_file"' EXIT
            # Classify both sides of a rename. A runtime file moved under
            # docs must still run the checks for its deleted source path.
            if git diff --no-renames --name-only -z "$base" "$head" > "$paths_file"; then
              mapfile -d '' -t files < "$paths_file"
            else
              full=true
            fi
          fi
        fi
      fi
      ;;
    *)
      full=true
      ;;
  esac
fi

if [[ "$full" == true ]]; then
  mark_all
else
  for file in "${files[@]}"; do
    case "$file" in
      # The shared CI dispatcher and classifier must always test every gate.
      # Other workflow-only changes run the affected safety and runtime gates.
      .github/workflows/ci.yml|scripts/ci-change-scopes.sh|tests/test_ci_change_scopes.py)
        mark_all ;;
      .github/workflows/build-windows.yml)
        mark app supply ;;
      .github/workflows/docker.yml)
        mark app docker docker_scan supply ;;
      .github/workflows/security-supply-chain.yml)
        mark app supply postgres ;;
      .github/workflows/static-security.yml)
        mark app supply codeql_js codeql_py codeql_go ;;
      .github/workflows/*)
        mark_all ;;
      # This directory contains executable runtime patches and hash-locked
      # dependency inputs, so it cannot take the ordinary docs-only shortcut.
      docs/runtime-hardening/gosu/*|docs/runtime-hardening/caddy/*|docs/runtime-hardening/alpine-security-artifacts.json)
        # These inputs also rebuild PostgreSQL/Caddy, so run their Compose
        # behavior gates as well as image scanning and the carried Odoo profile.
        mark app odoo docker docker_scan supply codeql_py codeql_go ;;
      Dockerfile.odoo-hardened|scripts/odoo-hardened-entrypoint.py|scripts/odoo-healthcheck.py|scripts/verify-odoo-test-results.py|scripts/package-pillow-wheel-as-deb.py|docs/runtime-hardening/*)
        mark app odoo docker_scan supply codeql_py ;;
      *.md|docs/*|LICENSE|LICENSE.*|CHANGELOG*|.github/ISSUE_TEMPLATE/*)
        ;;
      src/*)
        mark app docker codeql_js
        case "$file" in
          src/db/*|src/server/db/*|src/lib/*database*|src/lib/*postgres*|src/lib/*pg-notify*|src/lib/*notify*|src/lib/*drizzle*)
            mark postgres ;;
        esac
        ;;
      public/*|src-tauri/*|vite.desktop.config.mts|postcss.config.*|tsconfig.json|.nvmrc)
        mark app docker
        case "$file" in
          src-tauri/Cargo.toml|src-tauri/Cargo.lock)
            mark supply ;;
        esac
        ;;
      agent/*)
        mark app agent
        case "$file" in
          *.go) mark codeql_go supply ;;
          agent/go.mod|agent/go.sum) mark codeql_go supply ;;
        esac
        ;;
      odoo_addons/*)
        mark app odoo
        case "$file" in
          *.py) mark codeql_py ;;
          *.js|*.ts|*.mjs) mark codeql_js ;;
        esac
        ;;
      tests/ci-image-mirror-current-run.node.test.mjs)
        # This contract controls the native Odoo image/security gate and must
        # not let a passing generic app check mask a cancelled Odoo scan.
        mark app odoo docker_scan supply codeql_js codeql_py ;;
      scripts/check-proxy-boundary.py|tests/test_ci_proxy_boundary.py)
        mark app docker codeql_py ;;
      scripts/deploy-compose.sh|tests/test_compose_release_orchestration.py|scripts/check-compose-build-contexts.py|tests/test_compose_build_contexts.py)
        mark app docker supply codeql_py ;;
      tests/test_ci_audit_fixture.py)
        mark app supply codeql_py ;;
      tests/*)
        mark app
        case "$file" in
          *.py) mark odoo codeql_py ;;
          *.ts|*.tsx|*.js|*.mjs) mark codeql_js ;;
        esac
        ;;
      drizzle/*|db/*)
        mark app docker postgres codeql_js
        ;;
      package.json|package-lock.json|npm-shrinkwrap.json)
        mark app docker supply postgres codeql_js
        ;;
      Dockerfile*|docker-compose*|Caddyfile|.dockerignore|deploy/*)
        mark docker docker_scan supply
        ;;
      security/image-vulnerability-baseline.json)
        # Includes the pinned Odoo image's reviewed vulnerability inventory.
        # Always re-run actual native image tests and its SARIF review.
        mark odoo docker_scan supply
        ;;
      eslint.config.mjs|.oxlintrc.json|vitest*.mts|.npmrc|typography/*)
        mark app codeql_js
        ;;
      contracts/*)
        mark app agent odoo docker codeql_js codeql_py codeql_go
        ;;
      scripts/*)
        mark app
        case "$file" in
          *.py) mark codeql_py ;;
          *.ts|*.tsx|*.js|*.mjs) mark codeql_js docker ;;
        esac
        case "$file" in
          scripts/ci-postgres.sh|scripts/pg-*|scripts/*postgres*|scripts/*migration*)
            mark docker postgres ;;
        esac
        case "$file" in
          scripts/check-trivy-baseline.py|scripts/*trivy*|scripts/*docker*)
            mark docker_scan ;;
        esac
        case "$file" in
          scripts/*security*|scripts/*audit*|scripts/*vuln*|scripts/*supply*|scripts/*lockfile*|scripts/check-codeql-sarif.py)
            mark supply ;;
        esac
        ;;
      *)
        echo "Unclassified changed path: $file; running all checks." >&2
        mark_all ;;
    esac
  done
fi

# Main is the release baseline. A docs-only push can otherwise finish green
# while cancelling the previous code commit's in-flight checks. Keep
# path-based PR/weekly optimizations, but never report main CI as green
# without executing the Gateway, Go and Odoo suites on that exact SHA.
# Offline --paths regression mode remains a pure path classifier.
if [[ "$paths_mode" == false && "${GITHUB_EVENT_NAME:-}" == "push" && "${GITHUB_REF:-}" == "refs/heads/main" ]]; then
  mark app agent odoo
fi

output="${GITHUB_OUTPUT:-/dev/stdout}"
for scope in "${scopes[@]}"; do
  printf '%s=%s\n' "$scope" "${changed[$scope]}" >> "$output"
done
echo "CI scopes (${#files[@]} changed paths; full=$full): ${scopes[*]}" >&2
for scope in "${scopes[@]}"; do
  printf '  %s=%s\n' "$scope" "${changed[$scope]}" >&2
done
