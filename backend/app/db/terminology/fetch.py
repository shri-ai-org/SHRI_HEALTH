"""Fetching the pinned code releases (``python -m app.db.terminology all``): ICD-10-CM and RxNorm
in one step, for after a demo reset, when diagnosis and drug search are empty.

Each release is pinned by its official URL and SHA-256, checked when the file is first fetched.
A file is downloaded once into a local cache folder (``SHRI_TERMINOLOGY_CACHE``, or
``~/.cache/shri-terminology``) and reused while its checksum still matches; a download that
doesn't match is refused and never cached. The loads are re-runnable, so running it again
changes nothing. A new release means a new pin here, in a reviewed PR.

Only public releases, with no licence and no sign-in: CMS's ICD-10-CM (public domain) and NLM's
RxNorm Current Prescribable Content (no licence, D75).
"""
from __future__ import annotations

import hashlib
import os
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import httpx

from app.db.terminology import icd10cm, rxnorm

#: No release is near this; a download that grows past it is refused.
MAX_BYTES = 200 * 1024 * 1024
CACHE_ENV = "SHRI_TERMINOLOGY_CACHE"


@dataclass(frozen=True)
class Pinned:
    url: str
    file_name: str
    sha256: str


#: ICD-10-CM FY2026 (CMS, the code descriptions in tabular order; in effect from 1 Oct 2025).
ICD10CM = Pinned("https://www.cms.gov/files/zip/2026-code-descriptions-tabular-order.zip",
                 "2026-code-descriptions-tabular-order.zip",
                 "55a9124a27ca78a4a5c41e1101eda064ec2e08d105ff9e78d1fbd1a83298ef11")
ICD10CM_MEMBER = "icd10cm_order_2026.txt"
#: RxNorm Current Prescribable Content, the 2 Nov 2026 release (NLM keeps each dated file).
RXNORM = Pinned("https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_11022026.zip",
                "RxNorm_full_prescribe_11022026.zip",
                "c742a6c4b2995194aa3479400e08a7c1ad707178bfc80fe9c8cd7afa693ae987")
RXNORM_VERSION = date(2026, 11, 2)


class ChecksumMismatch(Exception):
    """The file isn't the pinned release: never cached, never loaded."""


def cache_dir() -> Path:
    return Path(os.environ.get(CACHE_ENV) or Path.home() / ".cache" / "shri-terminology")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(pinned: Pinned, cache: Path, transport: httpx.BaseTransport | None = None) -> Path:
    """The cached release, downloaded first if it isn't cached with the pinned checksum."""
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / pinned.file_name
    if target.exists() and _sha256(target) == pinned.sha256:
        return target
    part = target.with_name(target.name + ".part")
    try:
        with httpx.Client(transport=transport, follow_redirects=True, timeout=120) as client, \
                client.stream("GET", pinned.url) as r, part.open("wb") as out:
            r.raise_for_status()
            size = 0
            for block in r.iter_bytes(1 << 20):
                size += len(block)
                if size > MAX_BYTES:
                    raise ChecksumMismatch(f"{pinned.file_name}: larger than any release")
                out.write(block)
        got = _sha256(part)
        if got != pinned.sha256:
            raise ChecksumMismatch(f"{pinned.file_name}: SHA-256 {got}, pinned {pinned.sha256}")
        part.replace(target)
    finally:
        part.unlink(missing_ok=True)
    return target


def icd10cm_codes(release: Path, member: str = ICD10CM_MEMBER) -> tuple[int, list[icd10cm.Code]]:
    """The fiscal year and the codes of the order file inside CMS's zip."""
    with zipfile.ZipFile(release) as z:
        text = z.read(member).decode("latin-1")
    return icd10cm.release_year(Path(member)), list(icd10cm.read_order_file(text.splitlines()))


def rxnorm_release(release: Path, version: date = RXNORM_VERSION) -> rxnorm.Release:
    return rxnorm.read_release(release, version)
