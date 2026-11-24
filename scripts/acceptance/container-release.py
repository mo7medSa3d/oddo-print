#!/usr/bin/env python3
"""Exact-image build/scan and disposable CA-verified Compose acceptance.

No deployment or production service is touched. Requires Docker+Compose and
Trivy already installed. Exit is nonzero if any gate, including cleanup, fails.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import secrets
import base64
import shutil
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--trivy", default="trivy")
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[2]
    output = pathlib.Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {"startedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "syntheticOnly": True, "steps": [], "images": {}, "scope": "Four exact images and scans; final-image Odoo PDF guard; disposable PostgreSQL/migrations/Gateway/Caddy CA-verified HTTPS readiness and unauthenticated WSS boundary. Authenticated tenant workflows, Windows and physical printing remain separate gates."}
    environment = os.environ.copy()
    project = "yaseir-acceptance-" + secrets.token_hex(5)
    report["project"] = project
    compose = ["docker", "compose", "--project-directory", str(root), "--project-name", project, "-f", str(root / "docker-compose.yml"), "-f", str(root / "docker-compose.acceptance.yml")]
    failed = False
    staging_started = False

    def run(name, argv, timeout=900, required=True):
        nonlocal failed
        started = time.monotonic()
        try:
            process = subprocess.run(argv, cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, text=True)
            code, text = process.returncode, process.stdout
        except (OSError, subprocess.TimeoutExpired) as error:
            code, text = 124 if isinstance(error, subprocess.TimeoutExpired) else 127, str(error)
        (output / (name + ".log")).write_text(text)
        report["steps"].append({"name": name, "argv": argv, "exitCode": code, "elapsedSeconds": round(time.monotonic() - started, 3)})
        if code and required:
            failed = True
        print(json.dumps(report["steps"][-1]), flush=True)
        return code, text

    def free_port():
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            return candidate.getsockname()[1]

    try:
        for tool in ("docker", args.trivy):
            if not shutil.which(tool):
                raise RuntimeError("Required acceptance tool is unavailable: " + tool)
        report["revision"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
        delta = hashlib.sha256(subprocess.check_output(["git", "diff", "--binary", "HEAD"], cwd=root))
        untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=root)
        for name in sorted(value for value in untracked.split(b"\0") if value):
            delta.update(name)
            delta.update((root / os.fsdecode(name)).read_bytes())
        report["workingDeltaSha256"] = delta.hexdigest()
        run("docker-version", ["docker", "version"], timeout=30)
        run("compose-version", ["docker", "compose", "version"], timeout=30)
        for name, dockerfile, target in (("gateway", "Dockerfile", None), ("postgres", "Dockerfile.secure-images", "postgres"), ("caddy", "Dockerfile.secure-images", "caddy"), ("odoo", "Dockerfile.odoo-hardened", None)):
            iid = output / (name + ".image-id")
            command = ["docker", "build", "--pull", "--platform=linux/amd64", "--iidfile", str(iid), "--file", dockerfile, "--tag", project + "/" + name]
            if target:
                command += ["--target", target]
            command += ["."]
            code, _ = run("build-" + name, command, timeout=1800)
            if code:
                raise RuntimeError("Exact image build failed: " + name)
            image = iid.read_text().strip()
            if not image.startswith("sha256:"):
                raise RuntimeError("Build omitted an immutable image identity")
            report["images"][name] = image
            code, inspection = run("inspect-" + name, ["docker", "image", "inspect", image], timeout=30)
            if code:
                raise RuntimeError("Exact image inspection failed: " + name)
            image_config = json.loads(inspection)[0]["Config"]
            if not image_config.get("Healthcheck", {}).get("Test") or image_config["Healthcheck"]["Test"][0] == "NONE":
                raise RuntimeError("Image omits its executable healthcheck: " + name)
            if name in ("gateway", "caddy", "odoo") and image_config.get("User", "").split(":")[0] in ("", "root", "0"):
                raise RuntimeError("Application image defaults to root: " + name)
            if name == "caddy" and image_config.get("User") != "10001:10001":
                raise RuntimeError("Caddy image does not use its dedicated UID/GID")
            run("sbom-" + name, [args.trivy, "image", "--format", "cyclonedx", "--output", str(output / (name + ".cdx.json")), image])
            # Preserve every severity, including unfixed findings. This exact
            # final-image gate has no advisory exceptions or accepted baseline.
            run("scan-" + name, [args.trivy, "image", "--scanners", "vuln", "--severity", "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL", "--ignore-unfixed=false", "--exit-code", "1", "--format", "json", "--output", str(output / (name + ".vulnerabilities.json")), image])
        run("odoo-final-image-pdf", ["docker", "run", "--rm", "--network=none", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--memory=512m", "--cpus=1", "--pids-limit=128", "--entrypoint", "/opt/yaseir-venv/bin/python", report["images"]["odoo"], "/opt/yaseir-runtime-profile/verify-odoo19-pdf-bounds.py", "/opt/odoo"], timeout=90)
        http_port, https_port = free_port(), free_port()
        while http_port == https_port:
            https_port = free_port()
        environment.update({"GATEWAY_DOMAIN": "localhost", "APP_BASE_URL": "https://localhost:" + str(https_port),
            "GATEWAY_HTTP_PORT": "127.0.0.1:" + str(http_port), "GATEWAY_HTTPS_PORT": "127.0.0.1:" + str(https_port),
            "POSTGRES_DB": "yaseir_synthetic_acceptance", "POSTGRES_USER": "yaseir_synthetic", "POSTGRES_PASSWORD": secrets.token_hex(32),
            "POSTGRES_OWNER_USER": "yaseir_owner", "POSTGRES_OWNER_PASSWORD": secrets.token_hex(32),
            "POSTGRES_RUNTIME_USER": "yaseir_runtime", "POSTGRES_RUNTIME_PASSWORD": secrets.token_hex(32),
            "GATEWAY_JWT_SECRET": secrets.token_hex(32), "TRUST_PROXY_SECRET": secrets.token_hex(32),
            "MANAGER_PASSWORD_HASH": "synthetic-disabled-legacy-login-" + secrets.token_hex(32), "PLATFORM_TENANT_ID": "synthetic-platform-only",
            "TRUST_PROXY": "1", "COOKIE_SECURE": "1", "RESEND_API_KEY": "", "LICENSE_SIGNING_PRIVATE_KEY_PEM": "",
            "YASEIR_ACCEPTANCE_GATEWAY_IMAGE": report["images"]["gateway"], "YASEIR_ACCEPTANCE_POSTGRES_IMAGE": report["images"]["postgres"], "YASEIR_ACCEPTANCE_CADDY_IMAGE": report["images"]["caddy"]})
        code, _ = run("compose-config", compose + ["config", "--quiet"], timeout=30)
        if code:
            raise RuntimeError("Compose acceptance configuration failed")
        staging_started = True
        code, _ = run("compose-start", compose + ["up", "--detach", "--no-build", "--wait", "--wait-timeout", "180"], timeout=210)
        if code:
            raise RuntimeError("Disposable Compose startup failed")
        _, container = run("caddy-identity", compose + ["ps", "--quiet", "caddy"], timeout=30)
        code, _ = run("caddy-runtime-privileges", ["docker", "exec", container.strip(), "sh", "-eu", "-c",
            'test "$(id -u)" = 10001 && test "$(id -g)" = 10001 && test -w /data && test -w /config '
            '&& test "$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start)" = 0 '
            '&& awk \'/^CapEff:/ {if ($2 != "0000000000000000") exit 1; caps=1} /^NoNewPrivs:/ {if ($2 != "1") exit 1; nnp=1} END {if (!caps || !nnp) exit 1}\' /proc/1/status'], timeout=30)
        if code:
            raise RuntimeError("Caddy runtime UID, capabilities, storage or port policy failed")
        code, health = run("caddy-runtime-health", ["docker", "inspect", "--format", "{{.State.Health.Status}}", container.strip()], timeout=30)
        if code or health.strip() != "healthy":
            raise RuntimeError("Caddy healthcheck did not become healthy")
        report["caddyRuntime"] = {"uid": 10001, "gid": 10001, "effectiveCapabilities": 0, "noNewPrivileges": True, "privateStorageWritable": True, "unprivilegedPortStart": 0, "health": "healthy"}
        ca = output / "staging-public-ca.pem"
        code, _ = run("caddy-public-ca", ["docker", "cp", container.strip() + ":/data/caddy/pki/authorities/local/root.crt", str(ca)], timeout=30)
        if code:
            raise RuntimeError("Caddy's public CA certificate was unavailable")
        origin = "https://localhost:" + str(https_port)
        context = ssl.create_default_context(cafile=str(ca))
        response = urllib.request.urlopen(origin + "/api/health", context=context, timeout=15)
        if response.status != 200:
            raise RuntimeError("CA-verified readiness failed")
        report["https"] = {"origin": origin, "readinessStatus": response.status}
        try:
            urllib.request.urlopen(origin + "/api/health", timeout=15)
            raise RuntimeError("Untrusted staging CA unexpectedly accepted")
        except urllib.error.URLError as error:
            if not isinstance(error.reason, ssl.SSLCertVerificationError):
                raise
            report["https"]["untrustedCARejected"] = True
        websocket_nonce = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        request = urllib.request.Request(origin + "/api/agent/ws", headers={"Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Key": websocket_nonce, "Sec-WebSocket-Version": "13"})
        try:
            urllib.request.urlopen(request, context=context, timeout=15)
            raise RuntimeError("Unauthenticated WebSocket unexpectedly accepted")
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise RuntimeError("Unexpected WebSocket rejection status: " + str(error.code)) from error
            report["https"]["unauthenticatedWssStatus"] = error.code
    except Exception as error:
        failed = True
        report["error"] = str(error)
    finally:
        if staging_started:
            run("compose-logs", compose + ["logs", "--no-color"], timeout=30)
            code, _ = run("compose-cleanup", compose + ["down", "--volumes", "--remove-orphans"], timeout=60)
            report["disposableVolumesRemoved"] = code == 0
        report["status"] = "FAIL" if failed else "PASS"
        report["finishedUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "output": str(output)}), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
