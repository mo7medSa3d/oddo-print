#!/usr/bin/env python3
"""Verify the shipped public denylist against its hash-pinned upstream corpus.

Download the exact source URL in security/common-passwords-provenance.json,
then pass its local file path. The verifier never sends passwords anywhere.
"""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("corpus", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    metadata = json.loads((root / "security/common-passwords-provenance.json").read_text())
    raw = args.corpus.read_bytes()
    if hashlib.sha256(raw).hexdigest() != metadata["source_sha256"]:
        raise SystemExit("Upstream corpus hash mismatch")
    passwords = []
    seen = set()
    for candidate in raw.decode("utf-8").splitlines():
        if 12 <= len(candidate) <= 4096 and candidate not in seen:
            passwords.append(candidate)
            seen.add(candidate)
            if len(passwords) == 3000:
                break
    hashes = sorted(hashlib.sha256(value.encode("utf-8")).hexdigest() for value in passwords)
    shipped = json.loads((root / "src/lib/common-password-hashes.json").read_text())
    if len(hashes) != 3000 or shipped != hashes:
        raise SystemExit("Shipped password denylist does not match the pinned corpus selection")
    print(json.dumps({"status": "PASS", "entries": len(hashes), "minimum_characters": min(map(len, passwords)), "source_sha256": metadata["source_sha256"]}))


if __name__ == "__main__":
    main()
