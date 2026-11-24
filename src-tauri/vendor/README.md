# Reviewed GTK 3 dependency backports

Tauri 2.12.4 uses the GTK 3 / GLib 0.18 API on Linux. Replacing only GLib with
0.20 would introduce incompatible types across that stack. These local Cargo
patches preserve the upstream package versions and public APIs.

## Scope and origin

`PROVENANCE.json` records the original crates.io archive SHA-256 values, every
original file hash, every delivered file hash, and the exact modified paths.
The archives were checked against the original production Cargo.lock checksums
before extraction. Each package retains its upstream license. The two patch
files in `patches/` describe the complete source delta.

| Package | Upstream version | Local repair |
| --- | --- | --- |
| glib | 0.18.5 | Exact two-line `VariantStrIter` mutability fix from gtk-rs-core commit `b5a4071e439bef2b5eea76c3aa25e5ae84839e34` |
| glib-macros | 0.18.5 | Remove the abandoned `proc-macro-error` dependency; emit and propagate diagnostics with the existing `syn::Error` API |
| gtk3-macros | 0.18.2 | Remove the same dependency and propagate invalid template-child errors before emitting an implementation |

The GLib upstream repair makes the C output pointer mutable and passes `&mut p`
to `g_variant_get_child`. The optimized iterator regression crashes with the
original crate and passes with that isolated repair. Its source version remains
**0.18.5**, rather than being relabeled as a newer incompatible API.

The diagnostic migration uses no new package. An evaluated `proc-macro-error2`
replacement was rejected because its maintainer archived it in June 2026 and
the pinned Rust compiler reports a future compatibility problem. It is absent
from both final lockfiles. The original diagnostic attributes are no longer
needed for the backported diagnostic paths, which return explicit compile
errors. Other upstream paths can still panic on invalid input; multi-error
closure diagnostics are wrapped in one expression block.

## Verification

From the repository root, with the pinned Rust toolchain and GLib development
headers installed:

```sh
python3 scripts/check-native-backports.py
cargo test --manifest-path src-tauri/native-regressions/Cargo.toml --locked --release --tests
python3 scripts/test-native-macro-diagnostics.py
```

The fixture executes the unmodified upstream GLib macro integration tests,
optimized iterator/Unicode tests, and malformed-input compilation checks for
both macro packages. The malformed-input checks require the intended error
messages, reject proc-macro panics and unrelated expansion errors, and include
the two-location duplicate-watch diagnostic.

For independent archive verification, download the three `crate_url` entries
from `PROVENANCE.json` into one directory and run:

```sh
python3 scripts/check-native-backports.py --crate-cache /path/to/original-crates
```

Continue to run the ordinary RustSec scan without ignoring advisories. A
version-based scanner may still report GLib 0.18.5; a scanner that omits local
path dependencies may report nothing. Neither outcome is the verification of
this backport. The source inventory, upstream patch, optimized regression and
actual resolved dependency graph provide that evidence. Do not treat a local
path dependency as exempt from future security review.

These repairs do not claim that the entire GTK 3 stack is maintained, that all
compiler warnings have been eliminated, or that a Linux desktop bundle has
passed graphical acceptance. Upstream source emits style/lifetime warnings on
the pinned modern Rust toolchain, and some upstream test macros exercise an
attribute placement warning. Keep those diagnostics visible.

## Maintenance and removal

The release maintainer owns these three small source deltas. On each upstream
Tauri/GTK update, review the complete compatibility graph and new RustSec
findings. Do not regenerate the recorded hashes merely to make a failed check
pass. Review any new upstream bytes, produce and inspect a fresh patch, rerun
optimized behavior and diagnostic tests, and record the new provenance.

Remove all three `[patch.crates-io]` entries and the corresponding vendor trees
when a compatible upstream Tauri/GTK graph provides the GLib repair and does not
depend on an abandoned diagnostic package. Retain the regression cases through
that transition.

Primary references:

- https://rustsec.org/advisories/RUSTSEC-2024-0429.html
- https://github.com/gtk-rs/gtk-rs-core/pull/1343
- https://rustsec.org/advisories/RUSTSEC-2024-0370.html
- https://github.com/GnomedDev/proc-macro-error-2/issues/17
- https://docs.rs/syn/2.0.119/syn/struct.Error.html
