"""The payment receipt (D58, D104): a one-page PDF made with the standard library only.

A minimal PDF 1.4 file: one US Letter page of Helvetica text (the standard Type 1 fonts every
reader has, so nothing is embedded), no images, an uncompressed content stream and a correct
cross-reference table. It shows the practice, the patient's official name, when it was
collected, the amount, the method (and the check number), the note, and the receipt number,
which is the payment ID.

Text is WinAnsi (cp1252), the encoding of the standard fonts. A letter outside it loses its
accent when it has one (``ễ`` → ``e``) and becomes ``?`` otherwise. The file carries no metadata
(no title, author or dates in an Info dictionary), so nothing about the patient is in it beyond
the page itself. Synthetic data only in tests.
"""

from __future__ import annotations

import textwrap
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

CONTENT_TYPE = "application/pdf"

_METHOD_NAMES = {"cash": "Cash", "card": "Card", "check": "Check", "ach": "ACH (bank transfer)",
                 "other": "Other"}
_PAGE_WIDTH, _PAGE_HEIGHT = 612, 792  # US Letter, in points
_LEFT = 72
_WRAP = 80  # characters per line of the note at 11 pt


@dataclass(frozen=True)
class ReceiptDetails:
    practice_name: str
    patient_name: str
    payment_id: UUID
    collected_at: datetime  # aware, UTC
    amount: Decimal
    currency: str
    method: str
    check_number: str | None = None
    note: str | None = None
    time_zone: str = "UTC"  # the practice's IANA zone, for display (D40)


def format_collected_at(moment: datetime, time_zone: str) -> str:
    """``November 3, 2026, 9:53 AM EST``: in the practice's zone, UTC if the zone is unknown."""
    try:
        zone: ZoneInfo | None = ZoneInfo(time_zone)
    except (ZoneInfoNotFoundError, ValueError):
        zone = None
    local = moment.astimezone(zone or UTC)
    hour = local.hour % 12 or 12
    return (f"{local:%B} {local.day}, {local.year}, {hour}:{local:%M} {local:%p} "
            f"{local.tzname() or 'UTC'}")


def format_amount(amount: Decimal, currency: str) -> str:
    sign = "$" if currency == "USD" else ""
    return f"{sign}{amount.quantize(Decimal('0.01')):,} {currency}"


def lines(details: ReceiptDetails) -> list[tuple[str, int, str]]:
    """The receipt's lines, top to bottom: (font, size, text). Font F1 is Helvetica, F2 bold."""
    out: list[tuple[str, int, str]] = [
        ("F2", 18, details.practice_name),
        ("F1", 14, "Payment receipt"),
        ("F1", 11, ""),
        ("F1", 11, f"Receipt number: {details.payment_id}"),
        ("F1", 11, f"Patient: {details.patient_name}"),
        ("F1", 11, f"Collected: {format_collected_at(details.collected_at, details.time_zone)}"),
        ("F2", 11, f"Amount paid: {format_amount(details.amount, details.currency)}"),
        ("F1", 11, f"Method: {_METHOD_NAMES.get(details.method, details.method)}"),
    ]
    if details.check_number:
        out.append(("F1", 11, f"Check number: {details.check_number}"))
    if details.note:
        wrapped = textwrap.wrap(" ".join(details.note.split()), _WRAP) or [""]
        out.append(("F1", 11, f"Note: {wrapped[0]}"))
        out.extend(("F1", 11, f"      {more}") for more in wrapped[1:])
    out.extend([("F1", 11, ""), ("F1", 9, "Thank you. Keep this receipt for your records.")])
    return out


def _winansi(value: str) -> bytes:
    out = bytearray()
    for char in value:
        try:
            out += char.encode("cp1252")
            continue
        except UnicodeEncodeError:
            pass
        bare = "".join(c for c in unicodedata.normalize("NFKD", char)
                       if not unicodedata.combining(c))
        out += bare.encode("cp1252", errors="replace") if bare else b"?"
    return bytes(out)


def _literal(value: str) -> bytes:
    """A PDF literal string: backslash, parentheses and line breaks escaped."""
    raw = _winansi(value)
    escaped = (raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
               .replace(b"\r", b" ").replace(b"\n", b" "))
    return b"(" + escaped + b")"


def _content(details: ReceiptDetails) -> bytes:
    parts = [b"BT"]
    y = _PAGE_HEIGHT - 72
    for font, size, value in lines(details):
        y -= int(size * 1.5)
        parts.append(f"/{font} {size} Tf 1 0 0 1 {_LEFT} {y} Tm".encode() + b" "
                     + _literal(value) + b" Tj")
    parts.append(b"ET")
    return b"\n".join(parts) + b"\n"


def render(details: ReceiptDetails) -> bytes:
    """The receipt as PDF bytes. The same details always give the same bytes."""
    content = _content(details)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {_PAGE_WIDTH} {_PAGE_HEIGHT}] "
         "/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>").encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"endstream",
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f\r\n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n\r\n".encode()
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_at}\n%%EOF\n").encode()
    return bytes(out)
