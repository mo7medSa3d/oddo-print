#!/usr/bin/env python3
"""Cross-language runtime source inventory: blockers versus manual dead-code leads.

Do not delete code solely on this report. Framework routes, Odoo registries,
reflection and external client protocols can be used without explicit imports.
"""
import argparse
import ast
import json
import os
import posixpath
import re
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree

ROOTS = ("src", "agent", "src-tauri/src", "odoo_addons/print_gateway", "scripts")
SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".mts", ".go", ".rs", ".py"}
IGNORED = {"node_modules", ".git", ".next", "target", "__pycache__", "vendor"}
FLAGS = {
    "todo_or_fixme": re.compile(r"\b(?:TODO|FIXME|HACK|XXX)\b"),
    "tls_bypass": re.compile(r"rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|InsecureSkipVerify\s*:\s*true"),
    "retired_capture": re.compile(r"\b(?:CaptureTestDocument|TestCenter|e2e_capture_runs)\b|/api/e2e-capture", re.I),
}
FLAG_NEEDLES = {
    "todo_or_fixme": ("TODO", "FIXME", "HACK", "XXX"),
    "tls_bypass": ("rejectUnauthorized", "NODE_TLS_REJECT_UNAUTHORIZED", "InsecureSkipVerify"),
    "retired_capture": ("capturetestdocument", "testcenter", "e2e_capture_runs", "/api/e2e-capture"),
}
IMPORTS = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)['"]([^'"]+)['"]""")
ALIAS_RESOLVE = re.compile(r"""path\.resolve\([^,]+,\s*['"](src/[^'"]+)['"]\)""")
INIT_IMPORT = re.compile(r"\s*from\s+\.\s+import\s+(.*)")
IDENT = re.compile(r"[A-Za-z_]\w*")
CONVENTION = re.compile(r"(?:^src/app/|^src/desktop/main\.|^src/desktop/ui\.|^src/desktop/preview/main\.|^src/db/schema\.|^src/i18n/messages/)")
IMPORT_EXTS = (".ts", ".tsx", ".js", ".mjs", ".mts")
INDEX_EXTS = ("/index.ts", "/index.tsx", "/index.js")


def scan(root: Path):
    errors, warnings, sources = [], [], {}
    counts = Counter()
    root_str = str(root)
    for area in ROOTS:
        directory = root / area
        if not directory.is_dir():
            errors.append({"path": area, "error": "missing expected source directory"})
            continue
        for dirpath, dirnames, filenames in os.walk(directory):
            dirnames[:] = [d for d in dirnames if d not in IGNORED]
            rel_dir = os.path.relpath(dirpath, root_str).replace(os.sep, "/")
            for filename in filenames:
                rel = f"{rel_dir}/{filename}" if rel_dir != "." else filename
                counts[area] += 1
                dot = filename.rfind(".")
                suffix = filename[dot:] if dot != -1 else ""
                if suffix not in SUFFIXES:
                    continue
                full_path = os.path.join(dirpath, filename)
                with open(full_path, "r", encoding="utf-8", errors="replace") as fh:
                    content = fh.read()
                sources[rel] = content
                is_test_file = "/tests/" in rel or ".test." in rel or rel.endswith("_test.go")
                lower_content = None
                for kind, pattern in FLAGS.items():
                    if kind == "retired_capture":
                        if is_test_file:
                            continue
                        if lower_content is None:
                            lower_content = content.lower()
                        if not any(tok in lower_content for tok in FLAG_NEEDLES[kind]):
                            continue
                    elif not any(tok in content for tok in FLAG_NEEDLES[kind]):
                        continue
                    for idx, m in enumerate(pattern.finditer(content)):
                        if idx >= 15:
                            break
                        warnings.append({"kind": kind, "path": rel, "line": content.count("\n", 0, m.start()) + 1})
                if suffix == ".py":
                    try:
                        ast.parse(content, filename=rel)
                    except SyntaxError as exc:
                        errors.append({"path": rel, "error": "Python syntax", "line": exc.lineno})

    # Include custom root entrypoints so their imports are not falsely marked unused.
    for root_file in ("server.ts", "proxy.ts", "vite.desktop.config.mts"):
        target = root / root_file
        if target.is_file():
            sources[root_file] = target.read_text(encoding="utf-8")
            counts["root_entrypoints"] += 1

    addon = root / "odoo_addons/print_gateway"
    manifest = addon / "__manifest__.py"
    if manifest.is_file():
        try:
            manifest_text = sources.get("odoo_addons/print_gateway/__manifest__.py") or manifest.read_text(encoding="utf-8")
            data = ast.literal_eval(ast.parse(manifest_text).body[0].value)
            refs = list(data.get("data", []))
            for asset_group in data.get("assets", {}).values():
                refs.extend(asset_group)
            for ref in refs:
                if not isinstance(ref, str) or "*" in ref:
                    continue
                target = root / "odoo_addons" / ref if ref.startswith("print_gateway/") else addon / ref
                if not target.is_file():
                    errors.append({"path": "__manifest__.py", "error": "missing asset", "asset": ref})
        except (SyntaxError, ValueError, AttributeError, IndexError) as exc:
            errors.append({"path": "__manifest__.py", "error": f"manifest invalid: {exc}"})

    for dirpath, dirnames, filenames in os.walk(addon):
        dirnames[:] = [d for d in dirnames if d not in IGNORED]
        for filename in filenames:
            if not filename.endswith(".xml"):
                continue
            path = Path(dirpath) / filename
            try:
                ElementTree.parse(path)
            except ElementTree.ParseError as exc:
                errors.append({"path": path.relative_to(root).as_posix(), "error": f"XML syntax: {exc}"})

    for rel, content in sources.items():
        if not (rel.startswith("odoo_addons/print_gateway/") and rel.endswith("/__init__.py")):
            continue
        init_dir = (root / rel).parent
        for line in content.splitlines():
            match = INIT_IMPORT.match(line)
            if not match:
                continue
            for item in match.group(1).split(","):
                name = item.strip().split(" as ")[0].strip()
                if IDENT.fullmatch(name):
                    if not (init_dir / (name + ".py")).exists() and not (init_dir / name / "__init__.py").exists():
                        errors.append({"path": rel, "error": "missing local module", "module": name})

    package_file = root / "package.json"
    if package_file.is_file():
        package = json.loads(package_file.read_text(encoding="utf-8"))
        runtime_texts = [
            text for path, text in sources.items()
            if (path.startswith("src/") or path.startswith("scripts/"))
            and "/tests/" not in path and ".test." not in path
        ]
        # Convention-only packages and tsx runtime CLI do not need imports.
        exceptions = {"next", "react", "react-dom", "tsx"}
        for dep in package.get("dependencies", {}):
            if dep in exceptions:
                continue
            dep_re = re.compile(r"(?<![\w/-])" + re.escape(dep) + r"""(?:/|['"])""")
            if not any(dep in text and dep_re.search(text) for text in runtime_texts):
                warnings.append({"kind": "unused_runtime_dependency_candidate", "path": "package.json", "package": dep})

    imported = set()
    for rel, content in sources.items():
        if "/tests/" in rel or ".test." in rel or rel.endswith("_test.go"):
            continue
        if "path.resolve(" in content:
            for alias_match in ALIAS_RESOLVE.finditer(content):
                cand = posixpath.normpath(alias_match.group(1))
                if cand in sources:
                    imported.add(cand)
        parent = posixpath.dirname(rel)
        for match in IMPORTS.finditer(content):
            name = match.group(1)
            if not name.startswith("."):
                continue
            base = posixpath.normpath(f"{parent}/{name}" if parent else name)
            if base in sources:
                imported.add(base)
            for ext in IMPORT_EXTS:
                cand = base + ext
                if cand in sources:
                    imported.add(cand)
            for ext in INDEX_EXTS:
                cand = base + ext
                if cand in sources:
                    imported.add(cand)

    for rel in sorted(sources):
        if not rel.startswith("src/") or not rel.endswith((".ts", ".tsx")) or CONVENTION.match(rel):
            continue
        if rel not in imported:
            warnings.append({"kind": "unreferenced_ts_file_candidate", "path": rel})

    return {
        "source_files_scanned": len(sources),
        "total_files_by_area": dict(sorted(counts.items())),
        "errors": errors,
        "candidate_counts": dict(sorted(Counter(x["kind"] for x in warnings).items())),
        "candidates": warnings,
        "limitations": "Candidates are not proof of unused code. Check dynamic imports, native commands, Odoo module registration and external clients before deletion.",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = scan(args.root.resolve())
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Source audit:", report["source_files_scanned"], "source files;", report["total_files_by_area"])
    print("Structural blockers:", len(report["errors"]), "; candidates:", report["candidate_counts"])
    for entry in report["errors"][:30]:
        print("ERROR", json.dumps(entry))
    for entry in report["candidates"][:85]:
        print("CANDIDATE", json.dumps(entry))
    if report["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
