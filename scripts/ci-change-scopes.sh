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
if [[ "${1:-}" == "--paths" ]]; then
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
        if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
          git fetch --no-tags --depth=1 origin "$base" >/dev/null 2>&1 || true
        fi
        if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
          full=true
        else
          paths_file="$(mktemp)"
          trap 'rm -f "$paths_file"' EXIT
          if git diff --name-only -z "$base" "$head" > "$paths_file"; then
            mapfile -d '' -t files < "$paths_file"
          else
            full=true
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
      .github/workflows/*|scripts/ci-change-scopes.sh|tests/test_ci_change_scopes.py)
        mark_all ;;
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
      Dockerfile*|docker-compose*|.dockerignore|deploy/*)
        mark docker docker_scan supply
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

output="${GITHUB_OUTPUT:-/dev/stdout}"
for scope in "${scopes[@]}"; do
  printf '%s=%s\n' "$scope" "${changed[$scope]}" >> "$output"
done
echo "CI scopes (${#files[@]} changed paths; full=$full): ${scopes[*]}" >&2
for scope in "${scopes[@]}"; do
  printf '  %s=%s\n' "$scope" "${changed[$scope]}" >&2
done
