"""Response shapes of searchCodes (contracts/openapi/modules/encounters.yaml: CodeMatchList,
CodeMatch, DrugDetails, DrugIngredient). Field names are the contract's camelCase."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

CodeSystem = Literal["icd-10-cm", "snomed-ct", "loinc", "rxnorm", "cpt", "hcpcs", "cvx"]


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class DrugIngredient(_Model):
    rxcui: str
    name: str


class DrugDetails(_Model):
    strength: str | None = None
    dose_form: str | None = None
    route: str | None = None
    ingredients: list[DrugIngredient]
    brand_name: str | None = None
    controlled_schedule: Literal["CII", "CIII", "CIV", "CV"] | None = None


class CodeMatch(_Model):
    system: str
    code: str
    display: str
    billable: bool | None = None
    drug: DrugDetails | None = None


class CodeMatchList(_Model):
    items: list[CodeMatch]
    next_cursor: str | None = None
