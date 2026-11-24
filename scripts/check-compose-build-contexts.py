#!/usr/bin/env python3
"""Check resolved local Compose build inputs without exposing resolved secrets."""
import json
from pathlib import Path
import subprocess
import sys


def validate_builds(config):
    errors = []
    for name, service in config.get("services", {}).items():
        build = service.get("build")
        if not build:
            continue
        if isinstance(build, str):
            build = {"context": build}
        context = Path(build.get("context", "."))
        if not context.is_dir():
            errors.append(f"{name}: local build context is missing")
            continue
        if build.get("dockerfile_inline") is not None:
            continue
        dockerfile = context / build.get("dockerfile", "Dockerfile")
        if not dockerfile.is_file():
            errors.append(f"{name}: Dockerfile is missing from resolved build context")
    return errors


def main():
    # The resolved model can contain secrets: capture it privately and print
    # only service names/errors, never the model, environment or stderr.
    result = subprocess.run(["docker", "compose", *sys.argv[1:], "config", "--format", "json"],
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        print("ERROR: Compose configuration could not be resolved", file=sys.stderr)
        return 1
    errors = validate_builds(json.loads(result.stdout))
    for error in errors:
        print("ERROR: " + error, file=sys.stderr)
    if not errors:
        print("Resolved Compose build contexts and Dockerfiles exist")
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
