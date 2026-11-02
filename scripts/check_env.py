#!/usr/bin/env python3
"""Lists the keys infra/compose/example.env has and your infra/compose/.env lacks.

    python3 scripts/check_env.py                   # infra/compose/.env against example.env
    python3 scripts/check_env.py ENV_FILE EXAMPLE  # any two files

Prints key names only, never a value. Exit 1 when a key is missing (or the .env file is),
0 otherwise. Keys only in .env are listed as a note: they may be stale. Standard library only.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / "infra" / "compose" / ".env"
EXAMPLE = ROOT / "infra" / "compose" / "example.env"


def keys(path: Path) -> list[str]:
    """The keys of KEY=value lines, in file order; comments and blank lines skipped."""
    found = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key = line.split("=", 1)[0].removeprefix("export ").strip()
        if key and key not in found:
            found.append(key)
    return found


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) not in (0, 2):
        print(__doc__, file=sys.stderr)
        return 2
    env, example = (Path(args[0]), Path(args[1])) if args else (ENV, EXAMPLE)
    if not env.is_file():
        print(f"{env} does not exist: copy {example} to it and fill it in", file=sys.stderr)
        return 1
    have, want = keys(env), keys(example)
    missing = [key for key in want if key not in have]
    extra = [key for key in have if key not in want]
    if extra:
        print(f"Note: in {env.name} but not in {example.name} (stale?): {', '.join(extra)}")
    if missing:
        print(f"Missing from {env}:", file=sys.stderr)
        for key in missing:
            print(f"  {key}", file=sys.stderr)
        return 1
    print(f"{env.name} has every key in {example.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
