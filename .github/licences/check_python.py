"""Fails if an installed Python distribution's licence is not allowed by D75.

Run it after `pip install --require-hashes --no-deps -r <lock>`, in the same environment. It uses
only the standard library, so it adds no dependency. Each distribution's licence comes from, in
order: its PEP 639 `License-Expression`, its `License ::` classifiers, its `License` field.
allowed.json holds the D75 list, the fonts-and-data licences and the per-package entries; the
same rules are in check-npm.mjs (keep the two in step).

    python .github/licences/check_python.py
"""

import json
import re
import sys
from importlib.metadata import distributions
from pathlib import Path

POLICY = json.loads((Path(__file__).parent / "allowed.json").read_text(encoding="utf-8"))
ALLOWED = set(POLICY["allowed"])
FONTS_AND_DATA = set(POLICY["fonts_and_data"]["licences"])
ALIASES = POLICY["aliases"]
TOKEN = re.compile(r"\(|\)|[^\s()]+")


def policy_problems() -> list[str]:
    """Every package entry is a D75 font or data use, or a registered exception (Vimal, #60)."""
    problems = []
    for name, entry in POLICY["packages"].items():
        kind, licence, register = entry.get("kind"), entry.get("licence"), entry.get("register", "")
        if kind in ("font", "data"):
            if licence not in FONTS_AND_DATA or "D75" not in register:
                problems.append(f"{name}: a {kind} entry needs a fonts-and-data licence and a D75 citation")
        elif kind == "exception":
            if not licence or "licence exceptions register" not in register:
                problems.append(f"{name}: an exception must name its line in the licence exceptions register")
        else:
            problems.append(f"{name}: kind must be font, data or exception")
    return problems


def allowed_expression(expression: str, extra: frozenset[str] = frozenset()) -> bool:
    """SPDX expression: OR needs one allowed side, AND needs both, `X WITH exception` needs X."""
    expression = ALIASES.get(expression.strip(), expression)
    tokens = TOKEN.findall(expression)
    accepted = ALLOWED | extra
    position = 0

    def term() -> bool:
        nonlocal position
        if tokens[position] == "(":
            position += 1
            value = either()
            if tokens[position] != ")":
                raise IndexError
            position += 1
        elif tokens[position] == ")":
            raise IndexError
        else:
            value = ALIASES.get(tokens[position], tokens[position]) in accepted
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
    failures = policy_problems()
    seen = 0
    for dist in sorted(distributions(), key=lambda d: d.metadata["Name"].lower()):
        name = dist.metadata["Name"].lower().replace("_", "-")
        if name in ("pip", "setuptools", "wheel"):  # the installer itself, not our dependencies
            continue
        seen += 1
        entry = POLICY["packages"].get(f"pypi:{name}")
        extra = frozenset([entry["licence"]]) if entry and entry.get("licence") else frozenset()
        meta = {key: dist.metadata.get_all(key) or [] for key in dist.metadata.keys()}
        licence = licence_of(meta)
        if licence is None or not allowed_expression(licence, extra):
            failures.append(f"{name}=={dist.version}: {licence or 'no licence found'}")
    for failure in failures:
        print(f"::error::Licence not allowed by D75: {failure}")
    print(f"Python licence check: {seen} distribution(s), {len(failures)} problem(s).")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
