#!/usr/bin/env bash
# Pinned test-only PostgreSQL provisioner for GitHub Actions.
# GitHub-hosted "services:" images are pulled before the job starts, so an
# ECR Public 429 prevents ANY test step or fallback from running.
set -euo pipefail

readonly postgres_ecr="public.ecr.aws/docker/library/postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
readonly postgres_hub="docker.io/library/postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
readonly postgres_container="yaseir-ci-postgres"

case "${1:-}" in
  stop)
    # Clean up even if a previous step failed. Never alter production data.
    docker rm -f "$postgres_container" >/dev/null 2>&1 || true
    exit 0
    ;;
  start) ;;
  *)
    echo "Usage: bash scripts/ci-postgres.sh start|stop" >&2
    exit 2
    ;;
esac

: "${CI_PG_USER:?CI_PG_USER must be specified}"
: "${CI_PG_PASSWORD:?CI_PG_PASSWORD must be specified}"
: "${CI_PG_DATABASE:?CI_PG_DATABASE must be specified}"

pull_log="$(mktemp)"
trap 'rm -f "$pull_log"' EXIT
image="$postgres_ecr"
if docker pull "$postgres_ecr" >"$pull_log" 2>&1; then
  echo "Verified pinned CI PostgreSQL image from ECR Public."
else
  cat "$pull_log" >&2
  # Switch registries only for documented quota/throttling responses.
  # ECR Public sometimes reports quota exhaustion as `error from registry:\n  # Data limit exceeded` without HTTP 429. All digest, TLS, auth and\n  # network errors still fail closed; fallback uses the SAME pinned digest.
  if ! grep -Eqi 'toomanyrequests|rate exceeded|(^|[^0-9])429([^0-9]|$)|error from registry: Data limit exceeded' "$pull_log"; then
    echo "ECR failure was not a rate limit; refusing registry fallback." >&2
    exit 1
  fi
  echo "ECR Public throttled; retrying identical PostgreSQL digest from Docker Hub." >&2
  image="$postgres_hub"
  docker pull "$image"
fi

# Loopback-only port mapping; ephemeral, isolated GitHub Actions runner.
# Do not overwrite any pre-existing container and never use floating tags.
docker run --rm -d --name "$postgres_container" \
  --publish 127.0.0.1:5432:5432 \
  --env "POSTGRES_USER=$CI_PG_USER" \
  --env "POSTGRES_PASSWORD=$CI_PG_PASSWORD" \
  --env "POSTGRES_DB=$CI_PG_DATABASE" \
  --health-cmd "pg_isready -U $CI_PG_USER -d $CI_PG_DATABASE" \
  --health-interval 5s --health-timeout 3s --health-retries 10 \
  "$image" >/dev/null

for attempt in $(seq 1 45); do
  if docker exec "$postgres_container" pg_isready -U "$CI_PG_USER" -d "$CI_PG_DATABASE" >/dev/null 2>&1; then
    echo "CI PostgreSQL ready (attempt $attempt)."
    exit 0
  fi
  if ! docker inspect --format '{{.State.Running}}' "$postgres_container" 2>/dev/null | grep -Fxq true; then
    echo "CI PostgreSQL container stopped before becoming healthy." >&2
    docker logs "$postgres_container" >&2 || true
    exit 1
  fi
  sleep 1
done

echo "CI PostgreSQL failed to become ready within 45 seconds." >&2
docker logs "$postgres_container" >&2 || true
exit 1
