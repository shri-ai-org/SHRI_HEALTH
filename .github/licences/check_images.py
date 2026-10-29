"""Licence check for third-party container images (D75; the packages' checks are check_python.py
and check-npm.mjs).

Every image we run that we don't build ourselves must be listed under `images` in allowed.json,
with a licence D75 allows (`allowed`, after `aliases`), a version, and the digest it's pinned to.
Each reference in the compose file and the workflows must carry exactly that tag and digest, so a
moved tag or an unlisted image fails CI. Our own images (`shri-health/…`, built from a pinned
Dockerfile) are skipped.

Standard library only. Run from anywhere:  python .github/licences/check_images.py
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POLICY = json.loads((ROOT / ".github/licences/allowed.json").read_text(encoding="utf-8"))
ALLOWED = set(POLICY["allowed"])
ALIASES = POLICY["aliases"]
IMAGES: dict[str, dict[str, str]] = POLICY.get("images", {})
# D75's scope: a separate program may use any OSI-approved licence, so an image entry marked
# "scope": "separate-program" may also use these.
SEPARATE = set(POLICY.get("separate_programs", {}).get("licences", []))

FILES = [ROOT / "infra/compose/docker-compose.yml", *sorted((ROOT / ".github/workflows").glob("*.yml"))]
OWN = "shri-health/"
# An image reference: `image:` lines in compose, and any registry-qualified reference elsewhere.
COMPOSE_IMAGE = re.compile(r"^\s*image:\s*['\"]?([^\s'\"#]+)", re.MULTILINE)
QUALIFIED = re.compile(r"\b((?:quay\.io|ghcr\.io|docker\.io|registry\.[\w.-]+)/[\w./-]+"
                       r"(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?)")
REFERENCE = re.compile(r"^(?P<name>[^:@]+)(?::(?P<tag>[\w.-]+))?(?:@(?P<digest>sha256:[0-9a-f]{64}))?$")


def references() -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for path in FILES:
        text = path.read_text(encoding="utf-8")
        refs = set(QUALIFIED.findall(text))
        if path.name == "docker-compose.yml":
            refs |= set(COMPOSE_IMAGE.findall(text))
        found += [(path.relative_to(ROOT).as_posix(), ref) for ref in sorted(refs)
                  if not ref.startswith(OWN)]
    return found


def problems() -> list[str]:
    found: list[str] = []
    for name, entry in IMAGES.items():
        licence = ALIASES.get(entry.get("licence", ""), entry.get("licence", ""))
        separate = entry.get("scope") == "separate-program"
        if licence not in ALLOWED and not (separate and licence in SEPARATE):
            found.append(f"images[{name}]: licence {entry.get('licence')!r} is not allowed by D75")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", entry.get("digest", "")):
            found.append(f"images[{name}]: needs the sha256 digest it is pinned to")
    for where, ref in references():
        match = REFERENCE.match(ref)
        name = match.group("name") if match else ref
        entry = IMAGES.get(name)
        if entry is None:
            found.append(f"{where}: {ref} is not listed under images in allowed.json")
            continue
        if not match or match.group("digest") != entry["digest"] or match.group("tag") != entry["version"]:
            found.append(f"{where}: {ref} must be {name}:{entry['version']}@{entry['digest']}")
    return found


def main() -> int:
    found = problems()
    for problem in found:
        print(f"::error::Images (D75): {problem}")
    print(f"Image licence check: {len(references())} references, {len(found)} problem(s).")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
