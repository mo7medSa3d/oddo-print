#!/usr/bin/env python3
"""Backport the upstream CVE-2026-82560 fix to Ubuntu's bundled Pod::Text."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import tempfile

UPSTREAM_COMMIT = "70510174f69eb54aa6d617bde4e1402cd9b7c61f"
CHECK = """    # Pathological margins make wrapping impossible. In this case, complain
    # to the user and reset the margin to 0.
    if ($width <= 0) {
        my $error = 'Margin is wider than the output width';
        $self->whine($self->line_count(), $error);
        $spaces = q{};
        $width = $self->{opt_width};
    }
"""

PATCHES = {
    "Text.pm": (
        """    my $spaces = ' ' x $$self{MARGIN};
    my $width = $$self{opt_width} - $$self{MARGIN};
""",
        """    my $spaces = ' ' x $$self{MARGIN};
    my $width = $$self{opt_width} - $$self{MARGIN};

""" + CHECK + "\n    # Perform the wrapping.\n",
    ),
    "Text/Color.pm": (
        """    my $spaces = ' ' x $$self{MARGIN};
    my $width = $$self{opt_width} - $$self{MARGIN};

    # $codes matches a single special sequence.""",
        """    my $spaces = ' ' x $$self{MARGIN};
    my $width = $$self{opt_width} - $$self{MARGIN};

""" + CHECK + "\n    # $codes matches a single special sequence.",
    ),
    "Text/Overstrike.pm": (
        """    my $spaces = ' ' x $$self{MARGIN};
    my $width = $$self{opt_width} - $$self{MARGIN};
    while (length > $width) {""",
        """    my $spaces = ' ' x $$self{MARGIN};
    my $width = $$self{opt_width} - $$self{MARGIN};

""" + CHECK + "\n    while (length > $width) {",
    ),
    "Text/Termcap.pm": (
        """    if ($self->{BOLD} eq q{} && $self->{UNDL} eq q{} && $self->{NORM} eq q{}) {
        return $self->SUPER::wrap($_);
    }

    # $code matches a single special sequence.""",
        """    if ($self->{BOLD} eq q{} && $self->{UNDL} eq q{} && $self->{NORM} eq q{}) {
        return $self->SUPER::wrap($_);
    }

""" + CHECK + "\n    # $code matches a single special sequence.",
    ),
}


def apply(root: Path) -> None:
    root = Path(root)
    staged: list[tuple[Path, str, int]] = []
    for relative, (before, after) in PATCHES.items():
        path = root / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Expected regular installed Perl module: {path}")
        original = path.read_text(encoding="utf-8")
        before_count = original.count(before)
        after_count = original.count(after)
        if after_count == 1:
            continue  # Exact upstream fix is already present; safe to re-run.
        if before_count != 1:
            raise ValueError(f"Unexpected or ambiguous Pod::Text source: {path}")
        staged.append((path, original.replace(before, after, 1), path.stat().st_mode & 0o777))

    # Validate all four source files before changing any, then atomically replace.
    for path, updated, mode in staged:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f".{path.name}.", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)

    for relative, (_, after) in PATCHES.items():
        path = root / relative
        if path.is_symlink() or path.read_text(encoding="utf-8").count(after) != 1:
            raise ValueError(f"Upstream Pod::Text patch verification failed: {path}")

    print(f"Applied/verified upstream podlators fix {UPSTREAM_COMMIT} in all {len(PATCHES)} implementations")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--module-root", type=Path, default=Path("/usr/share/perl/5.38.2/Pod"))
    args = parser.parse_args()
    apply(args.module_root)
