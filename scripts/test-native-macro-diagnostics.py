#!/usr/bin/env python3
"""Compile invalid inputs against the actual patched macro libraries.

The assertions require the intended diagnostic and forbid proc-macro panics.
No GTK display, printer, or external service is used.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "src-tauri/native-regressions/Cargo.toml"
CASES = [
    ("enum_shape", "#[derive(glib_macros::Enum)] struct Invalid;", "only supports enums"),
    ("enum_name", "#[derive(glib_macros::Enum)] enum Invalid { One }", "requires #[enum_type"),
    ("boxed_name", "#[derive(glib_macros::Boxed)] struct Invalid(String);", "requires #[boxed_type"),
    ("error_domain_shape", "#[derive(glib_macros::ErrorDomain)] struct Invalid;", "only supports enums"),
    ("shared_boxed_shape", "#[derive(glib_macros::SharedBoxed)] struct Invalid;", "requires struct MyStruct"),
    ("flags_shape", '#[glib_macros::flags(name = "InvalidFlags")] struct Invalid;', "only supports enums"),
    ("subclass_shape", "#[glib_macros::object_subclass] struct Invalid;", "ObjectSubclass"),
    ("interface_shape", "#[glib_macros::object_interface] struct Invalid;", "ObjectInterface"),
    ("variant_unknown_mode", "#[derive(glib_macros::Variant)] #[variant_enum(unknown)] enum Invalid { One }", "unknown type in #[variant_enum]"),
    ("variant_missing_repr", "#[derive(glib_macros::Variant)] #[variant_enum(repr)] enum Invalid { One }", "Must have #[repr]"),
    ("variant_enum_data", "#[derive(glib_macros::Variant)] #[variant_enum(enum)] enum Invalid { One(u32) }", "only allowed with C-style enums"),
    ("variant_flags_data", "#[derive(glib_macros::Variant)] #[variant_enum(flags)] enum Invalid { One(u32) }", "only allowed with bitflags"),
    ("closure_keyword", "fn invalid() { let _ = glib_macros::closure!(@unknown x => move || {}); }", "Unknown keyword"),
    ("closure_self_capture", "fn invalid() { let _ = glib_macros::closure!(@strong self => move || {}); }", "Can't use `self`"),
    ("closure_field_capture", "fn invalid() { let _ = glib_macros::closure!(@strong x.field => move || {}); }", "Field accesses are not allowed"),
    ("closure_duplicate_watch", "fn invalid() { let _ = glib_macros::closure!(@watch x, @watch y => move || {}); }", "Only one `@watch`"),
    ("closure_async", "fn invalid() { let _ = glib_macros::closure!(async || {}); }", "Async closure not allowed"),
    ("closure_move", "fn invalid() { let _ = glib_macros::closure!(@strong x => || {}); }", "Closure with captures needs"),
    ("gtk_template_missing", "#[derive(gtk3_macros::CompositeTemplate)] struct Invalid;", "requires #[template"),
    ("gtk_template_shape", '#[derive(gtk3_macros::CompositeTemplate)] #[template(string = "<interface/>")] enum Invalid { One }', "only supports structs"),
    ("gtk_child_attribute", '#[derive(gtk3_macros::CompositeTemplate)] #[template(string = "<interface/>")] struct Invalid { #[template_child(id = 7)] field: () }', "expected string literal"),
]


def main():
    build = subprocess.run(
        ["cargo", "build", "--manifest-path", str(MANIFEST), "--locked", "--offline", "--release", "--message-format=json"],
        cwd=ROOT, text=True, stdout=subprocess.PIPE, check=True,
    )
    libraries = {}
    for line in build.stdout.splitlines():
        message = json.loads(line)
        if message.get("reason") != "compiler-artifact":
            continue
        name = message["target"]["name"]
        if name in {"glib_macros", "gtk3_macros"}:
            libraries[name] = next(path for path in message["filenames"] if path.endswith((".so", ".dylib", ".dll")))
    if set(libraries) != {"glib_macros", "gtk3_macros"}:
        raise RuntimeError("Cargo did not identify both actual macro libraries")
    results = []
    with tempfile.TemporaryDirectory(prefix="yaseir-native-diagnostics-") as temporary:
        temporary = Path(temporary)
        (temporary / "Cargo.toml").write_text(
            '[package]\nname="native-macro-diagnostics"\nversion="0.0.0"\n'
            '[dependencies]\nglib="0.18"\ngtk="0.18"\n', encoding="utf-8"
        )
        environment = dict(os.environ, CARGO_MANIFEST_DIR=str(temporary), CARGO_PKG_NAME="native-macro-diagnostics")
        for name, source, expected in CASES:
            fixture = temporary / (name + ".rs")
            fixture.write_text(source + "\nfn main() {}\n", encoding="utf-8")
            command = ["rustc", "--edition=2021", "--emit=metadata", "--out-dir", str(temporary), str(fixture)]
            for library, path in libraries.items():
                command.extend(["--extern", f"{library}={path}"])
            outcome = subprocess.run(command, cwd=temporary, env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            unexpected = ("panicked", "macro expansion ignores", "missing angle brackets", "cannot find module or crate")
            passed = outcome.returncode != 0 and expected in outcome.stdout and not any(message in outcome.stdout for message in unexpected)
            if name == "closure_duplicate_watch":
                passed = passed and "Previous `@watch` found here" in outcome.stdout
            print(json.dumps({"case": name, "passed": passed, "exit": outcome.returncode, "diagnostic": outcome.stdout}, ensure_ascii=False))
            results.append(passed)
    print(json.dumps({"checks": len(results), "passed": sum(results), "failed": len(results) - sum(results)}))
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
