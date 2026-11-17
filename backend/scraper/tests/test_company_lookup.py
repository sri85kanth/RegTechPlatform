"""
Company Setup's "find your company" reads public records — and nothing else.

These pin what it may and may not conclude: a CIN is read by its published
layout, dates come out as the registry meant them, only Indian entities are
offered, and the industry code is never turned into a sector (NIC-2004 and
NIC-2008 give the same digits different meanings). No test touches the
network: GLEIF's answers are fed in.
"""
import os

import pytest

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

from regulatory_ingestion import company_lookup as L  # noqa: E402


# ------------------------------------------------------------------ the CIN
def test_a_cin_is_read_by_its_published_layout():
    c = L.decode_cin("U85110TG1989PTC010684")
    assert c == {"listed": False, "industryCode": "85110", "stateCode": "TG", "state": "Telangana",
                 "year": 1989, "kindCode": "PTC", "kind": "Private limited company", "serial": "010684"}


def test_a_listed_company_says_so():
    c = L.decode_cin("l85110tn1979plc008035")               # case and spacing do not matter
    assert c["listed"] is True and c["state"] == "Tamil Nadu" and c["kind"] == "Public limited company"


def test_an_unknown_state_code_is_not_guessed():
    c = L.decode_cin("U85110ZZ1999PTC000001")
    assert c["stateCode"] == "ZZ" and c["state"] is None


def test_an_unsettled_company_kind_is_not_guessed():
    assert L.decode_cin("U85110TG1999FTC000001")["kind"] is None


@pytest.mark.parametrize("value", ["", None, "36AAJFL8027F1Z8", "AAB-1234", "U85110TG1989PTC01068"])
def test_anything_else_is_not_a_cin(value):
    assert L.decode_cin(value) is None


# ------------------------------------------------------------------ dates
@pytest.mark.parametrize("instant, date", [
    ("1989-11-19T22:00:00Z", "1989-11-20"),       # local midnight entered in another zone
    ("2000-07-14T18:30:00Z", "2000-07-15"),       # IST midnight stored as UTC
    ("1999-07-23T00:00:00Z", "1999-07-23"),
    ("2001-04-01", "2001-04-01"),
    (None, None),
])
def test_dates_come_out_as_the_registry_meant_them(instant, date):
    assert L.ist_date(instant) == date


# ------------------------------------------------------------------ canned GLEIF
PREMIER = {
    "id": "894500GNV8GBB3KR5H20", "type": "lei-records",
    "attributes": {
        "entity": {
            "legalName": {"name": "PREMIER HOSPITALS PVT. LTD."}, "otherNames": [],
            "registeredAs": "U85110TG1989PTC010684", "registeredAt": {"id": "RA000394"},
            "legalForm": {"id": "YSP9"}, "status": "ACTIVE", "creationDate": "1989-11-19T22:00:00Z",
            "legalAddress": {"addressLines": ["12-2-710/1/1 to 4 NANAL NAGAR X ROADS, MEHDIPATNAM"],
                             "city": "HYDERABAD", "region": None, "country": "IN", "postalCode": "500028"},
            "headquartersAddress": {"addressLines": ["12-2-710/1/1 to 4 NANAL NAGAR X ROADS, MEHDIPATNAM"],
                                    "city": "HYDERABAD", "region": None, "country": "IN", "postalCode": "500028"},
        },
        "registration": {"status": "ISSUED", "lastUpdateDate": "2026-02-13T06:10:27Z",
                         "corroborationLevel": "FULLY_CORROBORATED"},
    },
}


def _record(lei, name, country="IN", reg=None, ra=None, status="ACTIVE", region=None):
    return {"id": lei, "attributes": {"entity": {
        "legalName": {"name": name}, "registeredAs": reg, "registeredAt": {"id": ra} if ra else None,
        "status": status, "legalAddress": {"country": country, "city": "X", "region": region},
        "headquartersAddress": {"country": country, "region": region}}}}


@pytest.fixture
def gleif(monkeypatch):
    """Answer GLEIF requests from a table; record what was asked."""
    asked = []
    table = {}

    def fake(path, params=None, ttl=600):
        asked.append((path, dict(params or {})))
        for (p, key), value in table.items():
            if p == path and (key is None or key in str(params)):
                return value
        return {"data": []}

    monkeypatch.setattr(L, "_get", fake)
    return table, asked


def test_a_typed_name_offers_indian_entities_only(gleif):
    table, _ = gleif
    table[("/fuzzycompletions", None)] = {"data": [
        {"relationships": {"lei-records": {"data": {"id": "894500GNV8GBB3KR5H20"}}}},
        {"relationships": {"lei-records": {"data": {"id": "549300E5L9K8IPZG7832"}}}}]}
    table[("/lei-records", "filter[lei]")] = {"data": [
        PREMIER, _record("549300E5L9K8IPZG7832", "Premier Hospitality Group", country="US")]}
    got = L.search("premier hosp")
    assert [g["name"] for g in got] == ["PREMIER HOSPITALS PVT. LTD."]
    assert got[0] == {"lei": "894500GNV8GBB3KR5H20", "name": "PREMIER HOSPITALS PVT. LTD.",
                      "registrationNo": "U85110TG1989PTC010684", "registrationKind": "CIN",
                      "city": "HYDERABAD", "state": "Telangana", "status": "ACTIVE"}


def test_names_that_start_with_what_was_typed_come_first(gleif):
    table, _ = gleif
    table[("/lei-records", "legalName")] = {"data": [
        _record("11111111111111111111", "SRI YASHODA TRADERS"),
        _record("22222222222222222222", "YASHODA HOSPITAL", status="INACTIVE"),
        _record("33333333333333333333", "YASHODA HEALTHCARE SERVICES PRIVATE LIMITED",
                reg="U85110TG2000PTC000001", ra="RA000394")]}
    names = [g["name"] for g in L.search("yashoda")]
    assert names[0] == "YASHODA HEALTHCARE SERVICES PRIVATE LIMITED"      # prefix, active, CIN
    assert names[-1] == "SRI YASHODA TRADERS"                              # contains, not prefix


def test_a_cin_is_looked_up_directly(gleif):
    table, asked = gleif
    table[("/lei-records", "registeredAs")] = {"data": [PREMIER]}
    got = L.search("u85110tg1989ptc010684")
    assert got[0]["lei"] == "894500GNV8GBB3KR5H20"
    assert asked == [("/lei-records", {"filter[entity.registeredAs]": "U85110TG1989PTC010684", "page[size]": 5})]


def test_too_short_a_query_asks_nothing(gleif):
    _, asked = gleif
    assert L.search("ab") == [] and asked == []


def test_the_register_being_down_is_said_not_hidden(monkeypatch):
    def down(path, params=None, ttl=600):
        raise L.LookupUnavailable("The public LEI register could not be reached.")
    monkeypatch.setattr(L, "_get", down)
    with pytest.raises(L.LookupUnavailable):
        L.search("premier hosp")


# ------------------------------------------------------------------ the record
def test_a_record_fills_what_the_register_holds(gleif):
    table, _ = gleif
    table[("/lei-records/894500GNV8GBB3KR5H20", None)] = {"data": PREMIER}
    table[("/entity-legal-forms/YSP9", None)] = {"data": {"attributes": {"names": [{"localName": "Private Limited Company"}]}}}
    d = L.details("894500gnv8gbb3kr5h20")
    assert d["legalName"] == "PREMIER HOSPITALS PVT. LTD."
    assert d["registrationNo"] == "U85110TG1989PTC010684" and d["registrationKind"] == "CIN"
    assert d["registrationAuthority"] == "Companies Register — Ministry of Corporate Affairs"
    assert d["legalForm"] == "Private Limited Company"
    assert d["incorporated"] == "1989-11-20"
    assert d["hqState"] == "Telangana" and d["listed"] is False
    assert d["registeredAddress"] == "12-2-710/1/1 to 4 NANAL NAGAR X ROADS, MEHDIPATNAM, HYDERABAD 500028"
    assert d["headOfficeAddress"] is None, "the same address is not repeated"
    assert d["source"]["lastUpdated"] == "2026-02-13" and d["source"]["corroboration"] == "FULLY_CORROBORATED"
    assert d["notes"] == []


def test_the_industry_code_never_becomes_a_sector(gleif):
    table, _ = gleif
    table[("/lei-records/894500GNV8GBB3KR5H20", None)] = {"data": PREMIER}
    d = L.details("894500GNV8GBB3KR5H20")
    assert d["cin"]["industryCode"] == "85110"
    assert not any(k in d for k in ("sectors", "sector", "entityType")), \
        "85110 is hospitals in NIC-2004 and pre-primary education in NIC-2008"


def test_a_disagreement_between_cin_and_record_is_reported(gleif):
    table, _ = gleif
    odd = {**PREMIER, "attributes": {**PREMIER["attributes"], "entity": {
        **PREMIER["attributes"]["entity"], "creationDate": "1991-01-01T00:00:00Z"}}}
    table[("/lei-records/894500GNV8GBB3KR5H20", None)] = {"data": odd}
    assert "1989" in L.details("894500GNV8GBB3KR5H20")["notes"][0]


def test_a_gstin_record_is_not_read_as_a_cin(gleif):
    table, _ = gleif
    firm = _record("984500C2B5D8D915Y966", "LEELA HEALTH CARE HOSPITAL", reg="36AAJFL8027F1Z8",
                   ra="RA000754", region="IN-TG")
    firm["attributes"]["registration"] = {"status": "ISSUED"}
    firm["attributes"]["entity"].update({"legalForm": {"id": "8888", "other": "Partnership firm"},
                                         "creationDate": None, "otherNames": []})
    table[("/lei-records/984500C2B5D8D915Y966", None)] = {"data": firm}
    d = L.details("984500C2B5D8D915Y966")
    assert d["registrationKind"] == "GSTIN" and d["cin"] is None and d["listed"] is None
    assert d["legalForm"] == "Partnership firm" and d["hqState"] == "Telangana"


def test_an_unknown_lei_is_none_and_a_bad_one_is_refused(gleif):
    assert L.details("00000000000000000000") is None
    with pytest.raises(ValueError):
        L.details("not-an-lei")
