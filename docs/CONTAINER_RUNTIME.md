# Container identities and health checks

The Gateway image runs as `node`; the hardened Odoo image runs as `odoo`.
The final Caddy image and Compose service run as UID/GID `10001:10001`.
PostgreSQL retains the official root entrypoint because it must initialize or
repair ownership of its data volume before `gosu` starts PostgreSQL as its
unprivileged database account. The Gateway receives only its restricted
runtime database credential; see [database roles](DATABASE_ROLES.md).

Caddy's `/data` and `/config` directories belong to its dedicated UID and have
mode `0700`. Compose drops every capability and enables `no-new-privileges`.
The container network namespace sets `net.ipv4.ip_unprivileged_port_start=0`,
which allows that UID to bind 80/443 without root or `CAP_NET_BIND_SERVICE`.
It does not change the host namespace. Caddy's administration listener is
explicitly bound to `127.0.0.1:2019` and is not published. The application
secrets are mounted read-only by Compose; no database owner or bootstrap
credential is mounted into Caddy or the Gateway.

## Existing Caddy data volumes

Fresh named volumes inherit the image directory ownership. Existing volumes
written by the previous root Caddy process require a maintenance conversion.
Back up the existing `/data` and `/config` volumes with their permissions first;
they include certificate private keys. Stop the edge before changing ownership:

```sh
docker compose stop caddy
docker compose run --rm --no-deps --user 0:0 \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --entrypoint sh caddy -eu -c \
  'chown -R -h 10001:10001 /data /config && chmod 0700 /data /config'
docker compose up -d --no-deps caddy
docker compose ps caddy
```

This explicit one-shot maintenance process receives only the two mounted Caddy
volumes and the service's ordinary read-only configuration/secret mounts. It
does not change the running service's UID or capability policy. If conversion
or startup fails, keep the edge stopped and restore the recorded volume
backup/permissions and prior reviewed image before resuming service. Do not
work around a failed conversion by running the new Caddy service as root.

## Health semantics and acceptance

| Image | Executed probe | Meaning |
|---|---|---|
| PostgreSQL | `pg_isready` using the configured database/user | Server is accepting connections; role grants and migrations are separate startup gates |
| Gateway | Bounded HTTP GET to `/api/health` | Gateway readiness endpoint returned a successful HTTP status |
| Caddy | Bounded loopback GET to `/config/apps/http/servers/` | Administration HTTP server is responding and the HTTP application configuration exists |
| Hardened Odoo | Bounded loopback GET to `/web/health`, status 200 and JSON `status=pass` | Odoo HTTP worker responds; this endpoint alone does not assert addon or database readiness |

Odoo's probe defaults to port 8069. If a reviewed `ODOO_CONFIG_FILE` or command
changes the HTTP port, set `ODOO_HTTP_PORT` to the same port for its health
probe. The probe ignores environment HTTP proxies, caps the response at 4096
bytes, and has a three-second socket timeout. Addon installation, exact test
execution and report rendering remain separate acceptance requirements.

`scripts/acceptance/container-release.py` inspects each exact built image for
its healthcheck and application UID. After disposable Compose startup it
checks Caddy's actual UID/GID, writable private directories, zero effective
capabilities, `NoNewPrivs`, network sysctl and healthy state. It then verifies
Gateway readiness through Caddy using its local CA and rejects an untrusted
certificate and unauthenticated WebSocket connection.

These image-level assertions must execute on a container-capable host. The
local namespace restriction (`unshare: operation not permitted`) prevented
the image build in this workspace; native probes and configuration tests do
not substitute for the pending image execution and scan.

## Primary references

- [Caddy administration API and default loopback listener](https://caddyserver.com/docs/api)
- [Linux network-namespace privileged-port setting](https://www.kernel.org/doc/html/next/networking/ip-sysctl.html#ip-unprivileged-port-start-integer)
- [Pinned Odoo HTTP health controller](https://github.com/odoo/odoo/blob/14f9b8149d5260d92fb74404df09483fb42dd820/addons/web/controllers/home.py)
