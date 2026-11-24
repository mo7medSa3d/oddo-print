#!/usr/bin/env python3
"""Fast source-level guard for the Direct Odoo printing & License-Only Gateway contract.

This intentionally checks architecture boundaries only. It does not probe
physical printers, certify hardware, or gate a real print job.
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "agent"
ODOO = ROOT / "odoo_addons" / "print_gateway"

checks = []


def check(name, condition, detail):
    checks.append((name, bool(condition), detail))


def read(path):
    return path.read_text(encoding="utf-8") if path.exists() else ""


agent_go = "\n".join(read(path) for path in AGENT.rglob("*.go") if not path.name.endswith("_test.go"))
go_mod = read(AGENT / "go.mod")
print_job = read(ODOO / "models" / "print_job.py")
agent_api = read(ODOO / "controllers" / "agent_api.py")
agent_ws = read(ODOO / "controllers" / "agent_ws.py")
odoo_controllers = "\n".join(read(path) for path in (ODOO / "controllers").glob("*.py"))
odoo_models = "\n".join(read(path) for path in (ODOO / "models").glob("*.py"))
binding = read(ODOO / "models" / "binding.py")
runtime_printers = read(ODOO / "controllers" / "runtime_printers.py")
config = read(ODOO / "models" / "print_config.py")
router = read(ODOO / "models" / "print_router.py")
license_signer = read(ROOT / "src" / "lib" / "license-signer.ts")
license_refresh_route = ROOT / "src" / "app" / "api" / "license" / "refresh" / "route.ts"
license_verify_route = ROOT / "src" / "app" / "api" / "license" / "verify" / "route.ts"

check(
    "Direct Odoo <-> Agent WebSocket + HTTP fallback",
    "gorilla/websocket" not in go_mod
    and "/api/agent/ws" in agent_go
    and all(x in agent_go for x in ("/api/agent/heartbeat", "/api/agent/jobs", "/api/agent/ack")),
    "Agent uses zero-dependency RFC 6455 WebSocket (/api/agent/ws) with authenticated HTTP polling fallback",
)
check(
    "Agent uses Odoo endpoints",
    all(x in agent_go for x in ("/api/agent/heartbeat", "/api/agent/jobs", "/api/agent/ack")),
    "heartbeat, claim and ACK all target Odoo",
)
check(
    "Odoo exposes matching Agent endpoints",
    all(x in agent_api for x in ("/api/agent/heartbeat", "/api/agent/jobs", "/api/agent/ack")),
    "Odoo owns register, heartbeat, claim and ACK",
)
check(
    "Odoo exposes /api/agent/ws and pg_notify wakeups",
    "/api/agent/ws" in (agent_ws + odoo_controllers)
    and (
        "pg_notify('print_gateway_job_ready'" in odoo_models
        or 'pg_notify("print_gateway_job_ready"' in odoo_models
    ),
    "Odoo serves /api/agent/ws and emits pg_notify('print_gateway_job_ready', ...) on job creation",
)
check(
    "Gateway has no legacy /api/printers routes or /platform/operations page",
    not (ROOT / "src" / "app" / "api" / "printers").exists()
    and not (ROOT / "src" / "app" / "platform" / "operations" / "page.tsx").exists(),
    "Gateway is strictly a License-Only control plane with no printer data-plane routes or legacy operations UI",
)
check(
    "Gateway exposes Ed25519 v2 license endpoints",
    license_refresh_route.exists()
    and license_verify_route.exists()
    and all(x in license_signer for x in ("rev", "status", "version")),
    "Gateway exposes /api/license/refresh and /api/license/verify backed by Ed25519 v2 signing (rev, status)",
)
check(
    "Go Agent enforces runtime license checking and RFC 6455 WebSocket",
    "CheckPrintAllowed" in agent_go
    and "PinnedPublicKeyB64" in agent_go
    and "/api/agent/ws" in agent_go,
    "Agent enforces CheckPrintAllowed with PinnedPublicKeyB64 and connects to /api/agent/ws",
)
check(
    "No Cloud print submission in Odoo job creation",
    all(x not in print_job for x in ("gateway_job_id", "gateway_wire_idempotency_key", "deployment_proof", "_cloud_base", "requests.post")),
    "Creating an Odoo outbox row must not call Yaseir Cloud",
)
check(
    "No remote printer lookup in binding validation",
    "requests." not in binding and "_cloud_base" not in binding,
    "Binding validation resolves the Odoo-local Agent and printer records",
)
check(
    "Runtime inventory is Odoo-local",
    "requests." not in runtime_printers and "_cloud_base" not in runtime_printers,
    "Agent and printer lists come from this Odoo database",
)
check(
    "Cloud integration is limited to licence refresh in config model",
    "/api/license/refresh" in config and all(x not in config for x in ("/api/agents", "/api/printers", "/api/jobs", "/api/print-jobs")),
    "Cloud is a subscription/licensing control plane, not a print data plane",
)
check(
    "No Gateway job dispatch in router",
    "requests." not in router and "gateway_job_id" not in router,
    "Print router resolves and stores Odoo jobs only",
)
check(
    "Operator-ambiguous outcomes remain terminal",
    '"unknown"' in print_job and "UNKNOWN_PARTIAL_DELIVERY" in print_job,
    "Unknown outcomes are not automatically retried",
)
check(
    "Legacy schema migration quarantines old remote jobs",
    "LEGACY_CLOUD_JOB_REQUIRES_MANUAL_REVIEW" in read(ODOO / "migrations" / "19.0.2.37.0" / "pre-migrate.py"),
    "Old Cloud job IDs are converted to unknown, never re-queued",
)

failed = [item for item in checks if not item[1]]
for name, ok, detail in checks:
    print(f"{'PASS' if ok else 'FAIL'}: {name} — {detail}")
print(f"\n{len(checks)-len(failed)}/{len(checks)} architecture checks passed")
if failed:
    sys.exit(1)
