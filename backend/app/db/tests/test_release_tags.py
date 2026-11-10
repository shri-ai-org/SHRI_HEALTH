"""Every table has a release tag (app.db.models.release, P0_SCHEMA_SCOPE.md), and the data
dictionary shows it. No database needed."""
from __future__ import annotations

from typing import Any

from app.db.models import MAPPERS
from app.db.models.release import P0, P1, RELEASES, TAGS, _tag
from app.db.tools.gen_docs import data_dictionary


def test_every_table_has_one_of_the_four_tags() -> None:
    untagged = sorted(n for n, cls in MAPPERS.items() if "release" not in cls.__table__.info)
    assert untagged == [], f"tag these in app/db/models/release.py: {untagged}"
    wrong = {n: cls.__table__.info["release"] for n, cls in MAPPERS.items()
             if cls.__table__.info["release"] not in RELEASES}
    assert wrong == {}


def test_the_list_names_only_tables_that_exist_and_no_child_table() -> None:
    assert set(TAGS) <= set(MAPPERS), sorted(set(TAGS) - set(MAPPERS))
    children = {n for n, cls in MAPPERS.items() if hasattr(cls, "fhir_parent")}
    assert set(TAGS) & children == set()        # a child takes its resource's tag


def test_a_child_table_takes_its_resources_tag() -> None:
    def tag(name: str) -> Any:
        return MAPPERS[name].__table__.info["release"]

    assert tag("medication_statement_reason") == tag("medication_statement") == P1
    assert tag("dosage") == tag("medication_request") == P0
    assert tag("human_name") == P0               # shared: Patient, Practitioner, RelatedPerson


def test_a_new_table_not_in_the_list_gets_no_tag() -> None:
    class NewTable:                              # an admin table nobody has tagged yet
        pass

    assert _tag("a_new_table", NewTable, MAPPERS, frozenset()) is None


def test_the_data_dictionary_shows_each_tables_release() -> None:
    text = data_dictionary()
    assert text.count("Release: **") == len(MAPPERS)
    assert "## `admin.remittance`\n\nAdmin (normalized)" in text
    section = text.split("## `admin.remittance`", 1)[1].split("## ", 1)[0]
    assert "Release: **P0 stretch**." in section
    assert f"| {P0} |" in text                  # the summary table
