"""The receipt PDF parses: header, objects where the cross-reference table says, the trailer, and
the texts on the page. A small reader with the standard library, so the test needs no PDF
package. Synthetic data only."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from ..receipt import ReceiptDetails, format_collected_at, render

PAYMENT_ID = UUID("3b4c5d6e-7f8a-4b9c-8d0e-1f2a3b4c5d6e")
COLLECTED = datetime(2026, 11, 3, 14, 53, tzinfo=UTC)


def _details(**overrides: object) -> ReceiptDetails:
    values: dict[str, object] = {
        "practice_name": "Lakeside Test Neurology", "patient_name": "Mai Thi Nguyen",
        "payment_id": PAYMENT_ID, "collected_at": COLLECTED, "amount": Decimal("25.00"),
        "currency": "USD", "method": "check", "check_number": "1042",
        "note": "Copay (visit) paid at check-in \\ thanks", "time_zone": "America/Chicago"}
    values.update(overrides)
    return ReceiptDetails(**values)  # type: ignore[arg-type]


def _unescape(raw: bytes) -> str:
    out, i = bytearray(), 0
    while i < len(raw):
        if raw[i:i + 1] == b"\\":
            out += raw[i + 1:i + 2]
            i += 2
        else:
            out += raw[i:i + 1]
            i += 1
    return out.decode("cp1252")


def _parse(pdf: bytes) -> tuple[dict[int, bytes], list[str]]:
    """The objects by number, read through the xref table, and the page's text lines."""
    assert pdf.startswith(b"%PDF-1.4\n")
    assert pdf.rstrip().endswith(b"%%EOF")
    startxref = int(re.findall(rb"startxref\s+(\d+)\s+%%EOF", pdf)[-1])
    assert pdf[startxref:startxref + 4] == b"xref"
    header = re.match(rb"xref\n0 (\d+)\n", pdf[startxref:])
    assert header is not None
    count = int(header.group(1))
    table = pdf[startxref + header.end():startxref + header.end() + 20 * count]
    entries = [table[i:i + 20] for i in range(0, len(table), 20)]
    assert entries[0] == b"0000000000 65535 f\r\n"
    objects: dict[int, bytes] = {}
    for number, entry in enumerate(entries[1:], start=1):
        assert re.fullmatch(rb"\d{10} 00000 n\r\n", entry), entry
        offset = int(entry[:10])
        assert pdf[offset:].startswith(f"{number} 0 obj\n".encode()), number
        end = pdf.index(b"endobj", offset)
        objects[number] = pdf[offset:end]
    trailer = pdf[startxref + header.end() + 20 * count:]
    assert trailer.startswith(f"trailer\n<< /Size {count} /Root 1 0 R >>".encode())

    page = objects[3]
    content_ref = re.search(rb"/Contents (\d+) 0 R", page)
    assert content_ref is not None
    stream_obj = objects[int(content_ref.group(1))]
    length = int(re.search(rb"/Length (\d+)", stream_obj).group(1))  # type: ignore[union-attr]
    start = stream_obj.index(b"stream\n") + len(b"stream\n")
    stream = stream_obj[start:start + length]
    assert stream_obj[start + length:].startswith(b"endstream")
    texts = [_unescape(m) for m in re.findall(rb"\(((?:\\.|[^\\)])*)\) Tj", stream)]
    return objects, texts


def test_the_receipt_is_a_one_page_pdf_with_a_correct_xref() -> None:
    objects, _ = _parse(render(_details()))

    assert b"/Type /Catalog /Pages 2 0 R" in objects[1]
    assert b"/Count 1" in objects[2] and b"/Kids [3 0 R]" in objects[2]
    assert b"/BaseFont /Helvetica " in objects[4] and b"/BaseFont /Helvetica-Bold" in objects[5]
    assert not any(b"/Image" in body or b"/Info" in body for body in objects.values())


def test_the_receipt_shows_what_was_paid() -> None:
    _, texts = _parse(render(_details()))

    assert texts[0] == "Lakeside Test Neurology"
    assert "Payment receipt" in texts
    assert f"Receipt number: {PAYMENT_ID}" in texts
    assert "Patient: Mai Thi Nguyen" in texts
    assert "Collected: November 3, 2026, 8:53 AM CST" in texts
    assert "Amount paid: $25.00 USD" in texts
    assert "Method: Check" in texts
    assert "Check number: 1042" in texts
    assert "Note: Copay (visit) paid at check-in \\ thanks" in texts


def test_cash_has_no_check_number_or_note_and_a_long_note_wraps() -> None:
    _, plain = _parse(render(_details(method="cash", check_number=None, note=None)))
    assert "Method: Cash" in plain
    assert not any(t.startswith(("Check number", "Note")) for t in plain)

    _, wrapped = _parse(render(_details(note="word " * 100)))
    note = [t for t in wrapped if t.startswith(("Note: ", "      "))]
    assert len(note) > 1 and all(len(t) <= 90 for t in note)


def test_letters_outside_winansi_lose_only_their_accent() -> None:
    _, texts = _parse(render(_details(patient_name="Trần Thị Nguyễn", practice_name="Café 中")))

    assert "Patient: Tran Thi Nguyen" in texts
    assert texts[0] == "Café ?"


def test_the_same_payment_gives_the_same_bytes() -> None:
    assert render(_details()) == render(_details())


def test_an_unknown_time_zone_shows_utc() -> None:
    assert format_collected_at(COLLECTED, "Not/AZone") == "November 3, 2026, 2:53 PM UTC"
