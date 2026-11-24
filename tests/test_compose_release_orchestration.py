"""Exercise release sequencing with a harmless Docker CLI, no daemon or network."""
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "deploy-compose.sh"


def invoke(tmp_path, *arguments, failed_gate="", stale_gate="", failed_command="", unhealthy=False):
    docker = tmp_path / "docker"
    log = tmp_path / "commands"
    docker.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$COMMAND_LOG"
[ "$*" != "$FAILED_COMMAND" ] || exit 13
for last do :; done
case "$*" in
  *"ps --all --quiet "*) printf 'container-%s\\n' "$last" ;;
  *".State.Status"*)
    case "$*" in *"container-$FAILED_GATE") printf 'exited 1\\n' ;; *) printf 'exited 0\\n' ;; esac ;;
  *".State.Health.Status"*) printf '%s\\n' "$POSTGRES_HEALTH" ;;
  *"com.yaseir.release"*)
    case "$*" in *"container-$STALE_GATE") printf 'older-release\\n' ;; *) printf '%s\\n' "$YASEIR_DEPLOYMENT_ID" ;; esac ;;
esac
''')
    docker.chmod(0o700)
    env = dict(os.environ, PATH=str(tmp_path) + os.pathsep + os.environ["PATH"],
               COMMAND_LOG=str(log), FAILED_GATE=failed_gate, STALE_GATE=stale_gate,
               YASEIR_DEPLOYMENT_ID="reviewed-source-sha", FAILED_COMMAND=failed_command,
               POSTGRES_HEALTH="unhealthy" if unhealthy else "healthy")
    result = subprocess.run(["bash", str(SCRIPT), *arguments], env=env,
                            capture_output=True, text=True, timeout=10)
    return result, log.read_text().splitlines() if log.exists() else []


def test_release_builds_one_service_at_a_time_before_running_database_gates(tmp_path):
    result, commands = invoke(tmp_path)
    assert result.returncode == 0, result.stderr
    builds = [line for line in commands if " build " in line]
    assert len(builds) == 6
    assert all(len(line.split(" build ")[1].split()) == 1 for line in builds)
    assert not any("up -d --build" in line for line in commands)
    gates = [next(i for i, line in enumerate(commands) if "--exit-code-from " + name in line)
             for name in ("database_roles", "migrate", "database_verify")]
    assert gates == sorted(gates)
    assert commands.index(builds[-1]) < gates[0]
    assert "up -d --no-build --no-deps" in commands[-1]
    assert commands[-1].endswith("gateway caddy")


def test_resume_checks_completed_gates_without_building_or_replaying_them(tmp_path):
    result, commands = invoke(tmp_path, "--resume", "--", "--env-file", "reviewed.env")
    assert result.returncode == 0, result.stderr
    assert all(" build " not in line for line in commands)
    assert all("--exit-code-from" not in line for line in commands)
    assert all("compose --env-file reviewed.env" in line for line in commands if line.startswith("compose "))
    assert commands[-1].endswith("gateway caddy")


def test_resume_refuses_failed_migration_before_starting_gateway(tmp_path):
    result, commands = invoke(tmp_path, "--resume", failed_gate="migrate")
    assert result.returncode != 0
    assert "migrate" in result.stderr
    assert not any(line.endswith("gateway caddy") for line in commands)


def test_resume_refuses_successful_gates_from_a_different_release(tmp_path):
    result, commands = invoke(tmp_path, "--resume", stale_gate="migrate")
    assert result.returncode != 0
    assert "different release" in result.stderr
    assert not any(line.endswith("gateway caddy") for line in commands)


def test_failed_build_does_not_change_running_services(tmp_path):
    result, commands = invoke(tmp_path, failed_command="compose build gateway")
    assert result.returncode == 13
    assert not any(" up " in line for line in commands)


def test_failed_migration_does_not_start_gateway_or_run_later_gates(tmp_path):
    result, commands = invoke(tmp_path, failed_command="compose up --no-build --no-deps --exit-code-from migrate migrate")
    assert result.returncode == 13
    assert not any(line.endswith("gateway caddy") for line in commands)
    assert not any("--exit-code-from database_verify" in line for line in commands)


def test_resume_requires_healthy_postgres_before_starting_gateway(tmp_path):
    result, commands = invoke(tmp_path, "--resume", unhealthy=True)
    assert result.returncode != 0
    assert "PostgreSQL is not healthy" in result.stderr
    assert not any(line.endswith("gateway caddy") for line in commands)


def test_storage_repair_is_an_explicit_disposable_maintenance_job(tmp_path):
    result, commands = invoke(tmp_path, "--resume", "--repair-caddy-storage")
    assert result.returncode == 0, result.stderr
    repairs = [line for line in commands if " run " in line]
    assert len(repairs) == 1
    repair = repairs[0]
    assert "run --rm --no-deps --user 0:0 --cap-drop ALL" in repair
    for capability in ("CHOWN", "FOWNER", "DAC_OVERRIDE"):
        assert "--cap-add " + capability in repair
    assert "--entrypoint sh caddy" in repair
    assert "chown -hR 10001:10001 /data /config" in repair
    assert "find /data /config -type d" in repair
    assert "find /data /config -type f" in repair
    assert commands.index(repair) < len(commands) - 1
    assert not any("--cap-add" in line for line in commands if line != repair)
    assert not any(" stop " in line or " down " in line for line in commands)


def test_storage_repair_is_not_run_during_normal_resume(tmp_path):
    result, commands = invoke(tmp_path, "--resume")
    assert result.returncode == 0, result.stderr
    assert not any(" run " in line for line in commands)


def test_storage_repair_cannot_bypass_failed_migration_gate(tmp_path):
    result, commands = invoke(tmp_path, "--resume", "--repair-caddy-storage", failed_gate="migrate")
    assert result.returncode != 0
    assert "migrate" in result.stderr
    assert not any(" run " in line or line.endswith("gateway caddy") for line in commands)


def test_failed_storage_repair_aborts_before_application_startup(tmp_path):
    result, commands = invoke(tmp_path, "--resume", "--repair-caddy-storage")
    assert result.returncode == 0
    repair = next(line for line in commands if " run " in line)
    failed_path = tmp_path / "failed"
    failed_path.mkdir()
    result, commands = invoke(failed_path, "--resume", "--repair-caddy-storage", failed_command=repair)
    assert result.returncode == 13
    assert not any(line.endswith("gateway caddy") for line in commands)
