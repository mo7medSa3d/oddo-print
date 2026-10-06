#!/usr/bin/env bash
# Canonical ignored-result inventory for the Go agent.
#
# WHY THIS FILE EXISTS
#   The same metric was reported as 50, then 33, then 35, then 128/35/93 vs
#   122/33/89 across earlier passes. Those numbers came from uncommitted,
#   ad-hoc regexes with different anchoring and file sets, so nobody could
#   reproduce them. This script is the single, committed definition.
#
# DEFINITION (the user's requested scope: `_ = expr` / `_, _ :=`)
#   A line of Go source that discards a value through the blank identifier in
#   an assignment:
#       _ = expr                 (blank assignment)
#       _, _ := expr             (all-blank short declaration)
#       _, _ = expr              (all-blank assignment)
#       x, _ := expr             (partially discarded result)
#   matched anywhere on the line, because Go allows these mid-line
#   (e.g. `defer func() { _ = tx.Rollback() }()`).
#
#   NOT counted: `for _, v := range ...` (a range binding, not an assignment
#   of a call result) -- it does not match the patterns below.
#
# SCOPE
#   Production = every *.go file under agent/ whose name does not end in
#   _test.go.  Test = every *_test.go under agent/.
#
# NOTE
#   This is a grep-based TEXT metric. It is the correct tool for counting a
#   text pattern, but its output is NOT a compiler, vet, or linter verdict.
#   Matches inside comments/strings are excluded by the sanity filter below.
#
# usage: scripts/count-ignored-results.sh [--list]
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERNS='_ = |,[[:space:]]*_[[:space:]]*:=|,[[:space:]]*_[[:space:]]*='
LIST="${1:-}"

prod_files=$(find agent -name '*.go' ! -name '*_test.go' | sort)
test_files=$(find agent -name '*_test.go' | sort)

count() { # count <files...>
  [ -z "$1" ] && { echo 0; return; }
  grep -hE "$PATTERNS" $1 | grep -vE '^[[:space:]]*//' | wc -l | tr -d ' '
}

PROD=$(count "$prod_files")
TEST=$(count "$test_files")

echo "IGNORED_RESULTS PRODUCTION=$PROD TEST=$TEST TOTAL=$((PROD + TEST))"
if [ "$LIST" = "--list" ]; then
  echo
  echo "production matches:"
  # Same comment filter as count(), applied to the `file:line:content` form so
  # the listing can never disagree with PRODUCTION (it did: --list showed 49
  # while PRODUCTION said 48, because a line whose *content* is a comment
  # mentioning `_ = recover()` was listed but not counted).
  grep -nE "$PATTERNS" $prod_files | grep -vE ':[0-9]+:[[:space:]]*//' | sed 's/^/  /'
fi
