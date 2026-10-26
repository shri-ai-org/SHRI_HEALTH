"""Fails if an installed Python distribution's licence is not allowed by D75.

Run it after `pip install --require-hashes --no-deps -r <lock>`, in the same environment. It uses
only the standard library, so it adds no dependency. Each distribution's licence comes from, in
order: its PEP 639 `License-Expression`, its `License ::` classifiers, its `License` field.
Allowed licences, aliases and package exceptions are in allowed.json (DECISIONS.md D75).

    python .github/licences/check_python.py
"""

import json
import re
import sys
from importlib.metadata import distributions
from pathlib import Path

POLICY = json.loads((Path(__file__).parent / "allowed.json").read_text(encoding="utf-8"))
ALLOWED = set(POLICY["allowed"])
ALIASES = POLICY["aliases"]
TOKEN = re.compile(r"\(|\)|[^\s()]+")


def allowed_expression(expression: str) -> bool:
    """SPDX expression: OR needs one allowed side, AND needs both, `X WITH exception` needs X."""
    tokens = TOKEN.findall(expression)
    position = 0

    def term() -> bool:
        nonlocal position
        if tokens[position] == "(":
            position += 1
            value = either()
            position += 1  # ")"
        else:
            value = ALIASES.get(tokens[position], tokens[position]) in ALLOWED
            position += 1
        if position < len(tokens) and tokens[position].upper() == "WITH":
            position += 2  # the exception only narrows the licence
        return value

    def both() -> bool:
        nonlocal position
        value = term()
        while position < len(tokens) and tokens[position].upper() == "AND":
            position += 1
            value = term() and value
        return value

    def either() -> bool:
        nonlocal position
        value = both()
        while position < len(tokens) and tokens[position].upper() == "OR":
            position += 1
            value = both() or value
        return value

    try:
        result = either()
    except IndexError:
        return False
    return result and position == len(tokens)


def licence_of(meta: dict[str, list[str]]) -> str | None:
    if meta.get("License-Expression"):
        return meta["License-Expression"][0].strip()
    classifiers = [
        c.rsplit("::", 1)[1].strip()
        for c in meta.get("Classifier", [])
        if c.startswith("License ::") and c.count("::") >= 2
    ]
    if classifiers:
        return " OR ".join(f"({ALIASES.get(c, c)})" for c in classifiers)
    text = (meta.get("License") or [""])[0].strip()
    if text and "\n" not in text and len(text) < 100:
        return ALIASES.get(text, text)
    return None


def main() -> int:
    failures = []
    seen = 0
    for dist in sorted(distributions(), key=lambda d: d.metadata["Name"].lower()):
        name = dist.metadata["Name"].lower().replace("_", "-")
        if name in ("pip", "setuptools", "wheel"):  # the installer itself, not our dependencies
            continue
        seen += 1
        exception = POLICY["packages"].get(f"pypi:{name}")
        meta = {key: dist.metadata.get_all(key) or [] for key in dist.metadata.keys()}
        licence = exception["licence"] if exception else licence_of(meta)
        ok = licence is not None and allowed_expression(
            " ".join(ALIASES.get(t, t) for t in TOKEN.findall(licence))
        )
        if not ok:
            failures.append(f"{name}=={dist.version}: {licence or 'no licence found'}")
    for failure in failures:
        print(f"::error::Licence not allowed by D75: {failure}")
    print(f"Python licence check: {seen} distribution(s), {len(failures)} not allowed.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
