"""A plain text PDF with the standard library only, over as many pages as the text needs.

The same minimal PDF 1.4 as the payment receipt (billing/receipt.py): US Letter pages of
Helvetica and Helvetica-Bold (standard Type 1 fonts every reader has, so nothing is embedded),
uncompressed content streams and a correct cross-reference table, and no metadata (no Info
dictionary), so nothing about the patient is in the file beyond its pages.

Text is WinAnsi (cp1252): a letter outside it loses its accent when it has one (``ễ`` → ``e``)
and becomes ``?`` otherwise.
"""

from __future__ import annotations

import unicodedata

CONTENT_TYPE = "application/pdf"
PAGE_WIDTH, PAGE_HEIGHT = 612, 792  # US Letter, in points
MARGIN = 72

#: One line: (font, size, text). Font F1 is Helvetica, F2 Helvetica-Bold.
Line = tuple[str, int, str]


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


def paginate(lines: list[Line]) -> list[list[tuple[Line, int]]]:
    """The lines with their baseline, split into pages at the bottom margin."""
    pages: list[list[tuple[Line, int]]] = [[]]
    y = PAGE_HEIGHT - MARGIN
    for line in lines:
        step = int(line[1] * 1.5)
        if y - step < MARGIN and pages[-1]:
            pages.append([])
            y = PAGE_HEIGHT - MARGIN
        y -= step
        pages[-1].append((line, y))
    return pages


def _content(page: list[tuple[Line, int]], number: int, total: int) -> bytes:
    parts = [b"BT"]
    for (font, size, value), y in page:
        parts.append(f"/{font} {size} Tf 1 0 0 1 {MARGIN} {y} Tm".encode() + b" "
                     + _literal(value) + b" Tj")
    if total > 1:
        parts.append(f"/F1 9 Tf 1 0 0 1 {MARGIN} {MARGIN // 2} Tm".encode() + b" "
                     + _literal(f"Page {number} of {total}") + b" Tj")
    parts.append(b"ET")
    return b"\n".join(parts) + b"\n"


def render(lines: list[Line]) -> bytes:
    """The lines as PDF bytes. The same lines always give the same bytes."""
    pages = paginate(lines)
    fonts = 3 + len(pages) * 2  # catalog, pages, then a page and its content per page
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        (f"<< /Type /Pages /Kids [{' '.join(f'{3 + 2 * i} 0 R' for i in range(len(pages)))}] "
         f"/Count {len(pages)} >>").encode(),
    ]
    for i, page in enumerate(pages):
        content = _content(page, i + 1, len(pages))
        objects.append(
            (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] "
             f"/Resources << /Font << /F1 {fonts} 0 R /F2 {fonts + 1} 0 R >> >> "
             f"/Contents {4 + 2 * i} 0 R >>").encode())
        objects.append(f"<< /Length {len(content)} >>\nstream\n".encode() + content
                       + b"endstream")
    objects.append(
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold "
                   b"/Encoding /WinAnsiEncoding >>")
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
