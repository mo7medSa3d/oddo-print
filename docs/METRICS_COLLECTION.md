# Unattended metrics collection

## Access and limits

`GET /api/metrics` exposes global operational counters and fleet gauges. A current password-authenticated platform owner can read it through the normal owner cookie or Bearer session. For an unattended collector, explicitly configure the independent `METRICS_SCRAPE_TOKEN_FILE` credential described here. Machine access is disabled when this variable is unset or empty. Tenant membership and workspace sessions do not grant access.

The collector credential authorizes only exact `GET /api/metrics` without a query string. It cannot authorize another read, a write, a platform login, a workspace session, an Agent heartbeat, or an Odoo request. Use the `Authorization: Bearer …` header; URL parameters and cookies never supply collector credentials. An explicit malformed or incorrect Authorization header does not fall back to an ambient owner cookie. The owner path remains available when no machine credential is configured.

Successful scrapes and authentication/collection failures use `Cache-Control: no-store`. Missing or incorrect credentials return 401. A configured unreadable or malformed credential returns 503, including for owner requests, and prevents the custom server's next startup. An incomplete database scrape returns 503 instead of a successful partial result. A missing file does not silently disable an explicitly configured collector.

This feature supplies authentication for collection. It does not install a collector, set alert thresholds, deliver notifications, or prove external TLS/image deployment. Record those separately using [the operations acceptance procedure](OPERATIONS_ACCEPTANCE.md).

## Generate and protect the credential

Create a new cryptographically random 32-byte value encoded as exactly 64 hexadecimal characters. One terminal LF or CRLF is accepted. Spaces, additional lines, nonhex data, symlinks, directories, pipes and oversized files are rejected. Do not reuse the Gateway JWT or trusted-proxy key; equivalent hexadecimal values with different letter case are rejected too. There is no inline `METRICS_SCRAPE_TOKEN` environment fallback.

This example creates a new file without overwriting an existing one or printing its contents:

```sh
umask 077
install -d -m 0700 /srv/yaseir-secrets
python3 - /srv/yaseir-secrets/metrics-scrape-token <<'PY'
import os, secrets, sys
descriptor = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, 'w') as output:
    output.write(secrets.token_hex(32) + '\n')
PY
```

Keep the authoritative copy in the deployment's protected secret store. Deliver separate readable copies to the Gateway and authorized collector through the established secret-distribution channel. Record who can read them and the rotation/revocation owner. Exclude their values from source control, support bundles, screenshots, command arguments, URLs, request logs and evidence archives. This credential can be replaced independently of the database and Gateway signing key; database restore does not require preserving an old metrics token.

The Gateway runs as the image's `node` user. Resolve its actual UID/GID from the exact approved image before setting mount ownership; do not assume a numeric UID or a user-namespace mapping:

```sh
docker run --rm --network none --entrypoint id "$APPROVED_GATEWAY_IMAGE"
```

Use a regular local file readable by that runtime identity and by no unnecessary host users. For example, assign the file to the mapped runtime owner with mode 0400, or an explicitly approved dedicated group with mode 0440. Apply equivalent custody to the collector's own file. Protect the parent directory and account for directory traversal on a native deployment. File-backed Compose secrets may retain host ownership and permissions; do not assume Compose remaps them. Verify readability using the exact running image/user before rollout. The reader rejects symlink-based projected secrets; materialize a protected regular file through the secret-distribution mechanism instead.

## Opt in with Compose

The base profile leaves machine access disabled. Append `docker-compose.metrics.yml` to the deployment's established Compose file list, preserving any approved-image overlays already in use. Set `METRICS_SCRAPE_TOKEN_FILE` on the operator side to the protected host file. The overlay mounts it only in the Gateway at `/run/secrets/metrics_scrape_token`; PostgreSQL, migration jobs, Caddy and Odoo do not receive it.

For an existing approved base deployment:

```sh
export METRICS_SCRAPE_TOKEN_FILE=/srv/yaseir-secrets/metrics-scrape-token
docker compose -f docker-compose.yml -f docker-compose.metrics.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.metrics.yml up -d --no-deps --no-build --force-recreate gateway
```

For a native Gateway, set the same variable to the readable regular file before startup. Do not publish the application port to bypass the HTTPS edge. The collector must not possess the trusted-proxy secret; Caddy supplies its own upstream authentication.

## Collector and TLS configuration

Use the approved public HTTPS hostname and normal certificate-chain/hostname validation. For a private issuer, install the approved CA bundle in the collector and configure its trust file; do not disable verification. Keep redirects disabled for this fixed endpoint, and restrict access to collector configuration and logs.

Example Prometheus scrape configuration, with the hostname and collector-local file path replaced by approved values:

```yaml
scrape_configs:
  - job_name: yaseir_gateway
    scheme: https
    metrics_path: /api/metrics
    scrape_interval: 30s
    scrape_timeout: 10s
    follow_redirects: false
    authorization:
      type: Bearer
      credentials_file: /run/secrets/yaseir_metrics_scrape_token
    tls_config:
      insecure_skip_verify: false
    static_configs:
      - targets: ['print.example.com:443']
```

These field names are defined in the [official Prometheus HTTP and TLS configuration reference](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#http_config), checked 2026-10-24. Validate the configuration with the actual installed collector version. This repository does not pin or deploy Prometheus. Protect the collector's stored telemetry and administrative interface independently of the Gateway credential.

## Rotation and revocation

The Gateway opens, verifies, reads at most 257 bytes and closes the configured file on every scrape. It has no cached-token grace: replacing a visible regular file, even with the same size and mtime, makes the old token fail on the next request. Deletion, truncation or unreadability returns 503 immediately. This strict behavior is local to metrics; the existing shared runtime-secret cache used by other settings is unchanged.

Prepare a new independent random token in a separate protected file. Coordinate its installation on the collector and every Gateway replica. There is one accepted token per process, so plan for a brief scrape failure during cutover. Use atomic regular-file replacement where the runtime sees the new inode. An immutable or file-bound Docker secret mount may continue to refer to the original inode: recreate/remount every affected Gateway and collector container. Verify the actual mounted value by successful authentication, without displaying it. A symlink swap is not supported.

After cutover, prove HTTP 200 with the new token and HTTP 401 with the old token against every replica's approved TLS routing path, then remove the old secret from mounts and the active secret store. Do not infer complete revocation from a single load-balanced request. If a rollback restores the previous token, treat that as explicit restoration of the old reader's authority and record the decision.

To revoke unattended access entirely, remove the opt-in variable/overlay and recreate all affected Gateway instances. Old collector tokens then receive 401 and normal verified-owner access remains. Deleting a still-configured file is a fail-closed emergency action that produces 503 and refuses the next startup; complete the configuration change before restarting. Revoke or delete the collector-side copies as well.

## Acceptance evidence

Retain the exact Gateway image ID/source revision, collector version and sanitized configuration, mount ownership/mode checks, certificate issuer/SAN/expiry and successful hostname/chain verification. Record authenticated HTTP 200 with expected gauge names, absent/wrong/duplicate credential HTTP 401, query-string rejection, a non-metrics read/write denial, malformed/missing-file HTTP 503, actual database-collector failure HTTP 503, immediate old/new-token rotation, complete revocation and cleanup. Use generated synthetic credentials for drills and never retain header values.

Also prove that a failed scrape reaches the authorized alert receiver, is acknowledged and clears after recovery. An endpoint returning 200 does not prove alert delivery. The local route/filesystem/startup tests verify software behavior; actual Docker secret mounting, public HTTPS collection and receiver delivery require their own environment acceptance.
