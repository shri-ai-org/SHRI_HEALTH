"""RxNorm Current Prescribable Content into admin.concept (A53, D97).

Reads the three RRF files of the release (RXNCONSO, RXNREL, RXNSAT), SAB=RXNORM only, except
the DEA schedule, which the subset carries as the MTHSPL attribute DCSA. RXNREL rows read
"RXCUI2 <RELA> RXCUI1".

Per product (SCD, SBD, GPCK, BPCK) the concept's display is its prescribable name (PSN), and
its properties are:
  tty                 the term type
  name                the full RxNorm name (STR), when the display is the PSN
  strength            RXN_AVAILABLE_STRENGTH ("5 MG"; combinations joined with " / ")
  dose_form           the dose form ("Oral Tablet")
  route               the route the dose form's name gives ("Oral" for "Extended Release Oral
                      Tablet"); absent when it names none ("Prefilled Syringe")
  ingredient          each active ingredient's RxCUI (IN), for the allergy and duplicate checks
  precise_ingredient  each precise ingredient's RxCUI (PIN), when there is one
  brand_name          the brand (BN) of a branded product
  dea_schedule        CII to CV; the most restrictive one the labels give, and a product with
                      none takes its generic's or brands' (the same drug, the same schedule)
Ingredients (IN, PIN, MIN) are loaded too, with their tty; a PIN's ``ingredient`` is its IN.
"""
from __future__ import annotations

import io
import zipfile
from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db.models import MAPPERS, systems

PRODUCTS = ("SCD", "SBD", "GPCK", "BPCK")
INGREDIENTS = ("IN", "PIN", "MIN")
SYNONYMS = ("SY", "TMSY", "PSN")
#: Most restrictive first (21 CFR 1308).
SCHEDULES = ("CII", "CIII", "CIV", "CV")
#: Routes as RxNorm's dose-form names write them. The subset has no route attribute.
ROUTES = ("Oral", "Sublingual", "Buccal", "Topical", "Transdermal", "Ophthalmic", "Otic",
          "Nasal", "Rectal", "Vaginal", "Inhalant", "Injectable", "Intravenous",
          "Intramuscular", "Subcutaneous", "Intrathecal", "Urethral", "Dental", "Mucosal")
#: Dose forms whose name gives no route word but whose route is unambiguous. Injections,
#: syringes and pens are left without one: the dose form doesn't say IV, IM or subcutaneous.
ROUTE_OF_FORM = {"Chewable Tablet": "Oral", "Chewable Bar": "Oral",
                 "Dry Powder Inhaler": "Inhalant", "Metered Dose Inhaler": "Inhalant",
                 "Medicated Patch": "Transdermal"}
LICENCE_NOTE = ("RxNorm Current Prescribable Content (NLM): no licence required; SAB=RXNORM "
                "and MTHSPL only")
BATCH = 5000


@dataclass
class Release:
    """What the loader keeps of one release, per RxCUI."""
    version: date
    tty: dict[str, str] = field(default_factory=dict)
    name: dict[str, str] = field(default_factory=dict)
    psn: dict[str, str] = field(default_factory=dict)
    out: dict[str, list[tuple[str, str]]] = field(default_factory=lambda: defaultdict(list))
    strength: dict[str, str] = field(default_factory=dict)
    schedules: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))

    def related(self, rxcui: str, *relas: str) -> list[str]:
        return [target for rela, target in self.out.get(rxcui, ()) if rela in relas]


def _rows(lines: Iterable[str]) -> Iterator[list[str]]:
    for line in lines:
        if line.strip():
            yield line.rstrip("\n").split("|")


def read_release(source: Path, version: date) -> Release:
    """``source``: the release .zip, or a folder with the three RRF files."""
    def lines(name: str) -> Iterator[str]:
        if source.suffix == ".zip":
            with zipfile.ZipFile(source) as z, z.open(f"rrf/{name}") as f:
                yield from io.TextIOWrapper(f, encoding="utf-8")
        else:
            with (source / name).open(encoding="utf-8") as f:
                yield from f

    r = Release(version=version)
    for f in _rows(lines("RXNCONSO.RRF")):
        rxcui, sab, tty, string = f[0], f[11], f[12], f[14]
        if sab != "RXNORM":
            continue
        if tty == "PSN":
            r.psn[rxcui] = string
        elif tty not in SYNONYMS:
            r.tty[rxcui], r.name[rxcui] = tty, string
    for f in _rows(lines("RXNREL.RRF")):
        if f[10] == "RXNORM" and f[7]:
            r.out[f[4]].append((f[7], f[0]))         # RXCUI2 <RELA> RXCUI1
    for f in _rows(lines("RXNSAT.RRF")):
        rxcui, atn, sab, value = f[0], f[8], f[9], f[10]
        if atn == "RXN_AVAILABLE_STRENGTH" and sab == "RXNORM":
            r.strength[rxcui] = value
        elif atn == "DCSA" and sab == "MTHSPL" and value in SCHEDULES:
            r.schedules[rxcui].add(value)
    return r


def _ingredients(r: Release, product: str) -> tuple[set[str], set[str]]:
    """(IN, PIN) RxCUIs of a product."""
    tty = r.tty.get(product)
    if tty in ("GPCK", "BPCK"):
        ins: set[str] = set()
        pins: set[str] = set()
        for member in r.related(product, "contains"):
            i, p = _ingredients(r, member)
            ins |= i
            pins |= p
        return ins, pins
    if tty == "SBD":
        generics = r.related(product, "tradename_of")
        if generics:
            return _ingredients(r, generics[0])
    ins, pins = set(), set()
    for component in r.related(product, "consists_of"):
        ins |= set(r.related(component, "has_ingredient"))
        pins |= set(r.related(component, "has_precise_ingredient"))
    return ins, pins


def _schedule(r: Release, product: str) -> str | None:
    own = r.schedules.get(product)
    if not own:     # the same drug, branded or generic
        own = set().union(*(r.schedules.get(c, set()) for c in
                            r.related(product, "tradename_of", "has_tradename")))
    return next((s for s in SCHEDULES if s in own), None)


def concepts(r: Release) -> Iterator[tuple[str, str, list[tuple[str, str]]]]:
    """(RxCUI, display, [(property, value)]) for every concept the loader stores."""
    for rxcui, tty in sorted(r.tty.items()):
        if tty in INGREDIENTS:
            props = [("tty", tty)]
            if tty == "PIN":
                props += [("ingredient", i) for i in sorted(r.related(rxcui, "form_of"))]
            yield rxcui, r.name[rxcui], props
        elif tty in PRODUCTS:
            props = [("tty", tty)]
            display = r.psn.get(rxcui, r.name[rxcui])
            if display != r.name[rxcui]:
                props.append(("name", r.name[rxcui]))
            if rxcui in r.strength:
                props.append(("strength", r.strength[rxcui]))
            for form in r.related(rxcui, "has_dose_form"):
                form_name = r.name.get(form)
                if form_name:
                    props.append(("dose_form", form_name))
                    words = form_name.split()
                    route = next((x for x in ROUTES if x in words),
                                 ROUTE_OF_FORM.get(form_name))
                    if route:
                        props.append(("route", route))
            ins, pins = _ingredients(r, rxcui)
            props += [("ingredient", i) for i in sorted(ins)]
            props += [("precise_ingredient", p) for p in sorted(pins)]
            if tty == "SBD":
                props += [("brand_name", r.name[b]) for b in r.related(rxcui, "has_ingredient")
                          if r.tty.get(b) == "BN"]
            schedule = _schedule(r, rxcui)
            if schedule:
                props.append(("dea_schedule", schedule))
            yield rxcui, display, sorted(set(props))


def load(db: Session, r: Release) -> dict[str, int]:
    """Loads the release in the session's transaction; the caller commits. Returns counts."""
    cs, concept, prop = M["code_system"], M["concept"], M["concept_property"]
    system_id = db.execute(select(cs.id).where(cs.uri == systems.RXNORM)).scalar_one()
    db.execute(update(cs).where(cs.id == system_id).values(
        version=r.version.isoformat(), license_note=LICENCE_NOTE, updated_at=func.now()))
    rows = list(concepts(r))
    codes = [code for code, _, _ in rows]
    for i in range(0, len(rows), BATCH):
        stmt = insert(concept).values([
            {"code_system_id": system_id, "code": code, "display": display[:500],
             "is_active": True, "effective_from": r.version}
            for code, display, _ in rows[i:i + BATCH]])
        db.execute(stmt.on_conflict_do_update(
            index_elements=[concept.code_system_id, concept.code],
            set_={"display": stmt.excluded.display, "is_active": True,
                  "effective_from": stmt.excluded.effective_from, "updated_at": func.now()}))
    retired = len(db.execute(update(concept).where(
        concept.code_system_id == system_id, concept.is_active,
        concept.code.not_in(codes)).values(is_active=False, updated_at=func.now())
        .returning(concept.id)).all())
    ids = {code: cid for code, cid in db.execute(select(concept.code, concept.id).where(
        concept.code_system_id == system_id))}
    db.execute(text("DELETE FROM admin.concept_property p USING admin.concept c "
                    "WHERE p.concept_id = c.id AND c.code_system_id = :s"), {"s": system_id})
    values = [{"concept_id": ids[code], "property": name, "value": value[:500]}
              for code, _, props in rows for name, value in props]
    for i in range(0, len(values), BATCH):
        db.execute(insert(prop).values(values[i:i + BATCH]))
    return {"concepts": len(rows), "properties": len(values), "retired": retired}


M = MAPPERS
