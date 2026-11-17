"""
Integrations offer exactly two ways in: a folder, and an API endpoint.

The API connector used to ask "which domain does this feed populate?" and drop
every record into that one bucket. It now places each record by its OWN type
field, and a record that names no type is skipped and counted rather than
filed somewhere nobody chose. These pin that, and pin that the five removed
connectors — and the two unauthenticated OAuth callback routes they needed —
stay removed.
"""
import os

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

from regulatory_ingestion import integrations as I  # noqa: E402


# ---------------------------------------------------------------- catalogue
def test_only_the_folder_and_the_api_endpoint_are_offered():
    ids = [c["id"] for c in I.runtime_catalogue()]
    assert ids == ["folder", "http_csv"]


def test_both_connectors_work_without_server_setup():
    assert all(c["ready"] for c in I.runtime_catalogue())
    assert all(I.is_ready(c) for c in ("folder", "http_csv"))


def test_the_api_connector_is_named_for_what_it_is():
    api = I.BY_ID["http_csv"]
    assert api["name"] == "API endpoint"
    assert api["auth"] == "token"


def test_the_removed_connectors_stay_removed():
    for gone in ("gdrive", "sharepoint", "salesforce", "aws", "jira"):
        assert gone not in I.BY_ID
        assert not I.is_ready(gone)


def test_no_oauth_route_is_served():
    """The Drive and SharePoint callbacks had to be reachable without a session.
    With the connectors gone, nothing should answer there at all."""
    from regulatory_ingestion.api import app
    from fastapi.routing import APIRoute
    try:
        from fastapi.routing import _IncludedRouter
    except ImportError:
        _IncludedRouter = ()

    def walk(routes):
        for r in routes:
            if isinstance(r, APIRoute):
                yield r.path
            elif _IncludedRouter and isinstance(r, _IncludedRouter):
                yield from walk(r.original_router.routes)

    paths = list(walk(app.routes))
    assert paths, "route walk found nothing — the check would be vacuous"
    assert not [p for p in paths if "oauth" in p or "google" in p or "microsoft" in p]


# ------------------------------------------------------- records by own type
def test_a_record_is_placed_by_its_own_type():
    assert I.domain_of_row({"entity_type": "Person", "name": "A"}, "entity_type") == "people"
    assert I.domain_of_row({"type": "risk", "name": "B"}, "type") == "risks"
    assert I.domain_of_row({"type": "Control", "name": "C"}, "type") == "controls"
    assert I.domain_of_row({"type": "Policy"}, "type") == "policies"


def test_the_words_real_exports_use_are_understood():
    assert I.domain_of_row({"type": "employee"}, "type") == "people"
    assert I.domain_of_row({"type": "SOP"}, "type") == "processes"
    assert I.domain_of_row({"type": "application"}, "type") == "systems"
    assert I.domain_of_row({"type": "vendor"}, "type") == "systems"
    assert I.domain_of_row({"type": "location"}, "type") == "overview"


def test_separators_do_not_matter():
    for raw in ("data asset", "data_asset", "Data-Asset", "DATA ASSET"):
        assert I.domain_of_row({"type": raw}, "type") == "data", raw


def test_a_record_that_names_no_type_is_not_guessed():
    assert I.domain_of_row({"type": ""}, "type") is None
    assert I.domain_of_row({"type": "something else entirely"}, "type") is None
    assert I.domain_of_row({"name": "no type column"}, None) is None


def test_a_non_string_type_does_not_crash():
    """Real JSON is not tidy: a type can arrive as a number, a bool, or null."""
    for raw in (None, 7, True, {"nested": 1}, ["list"]):
        assert I.domain_of_row({"type": raw}, "type") is None


# ------------------------------------------------ an equipment register feed
# Shaped like the hospital's partner API: every record carries its own id and
# entity_type "equipment", and many units share a name.
REGISTER = [
    {"id": "EQ-0001", "entity_type": "equipment", "name": "Infusion Pump", "serial_no": "IP-7781"},
    {"id": "EQ-0002", "entity_type": "equipment", "name": "Infusion Pump", "serial_no": "IP-7782"},
    {"id": "EQ-0003", "entity_type": "equipment", "name": "Ventilator", "serial_no": "VT-1100"},
]


def test_equipment_is_an_asset():
    for raw in ("equipment", "Equipment", "medical device", "instrument"):
        assert I.domain_of_row({"entity_type": raw}, "entity_type") == "systems", raw


def test_identical_names_stay_separate_when_keyed_by_their_own_id():
    ents = I.rows_to_entities(REGISTER, "systems", "integration:http_csv",
                              "https://h/api", key_prefix="apiabc123")
    ids = [e["id"] for e in ents]
    assert len(ids) == 3 and len(set(ids)) == 3, ids
    assert ids[0] == "sys-apiabc123-eq-0001"


def test_without_a_key_prefix_records_are_still_keyed_by_name():
    """The folder connector's behaviour is unchanged: same name, same record."""
    ents = I.rows_to_entities(REGISTER, "systems", "integration:folder", "f.csv")
    assert ents[0]["id"] == ents[1]["id"] == "sys-infusion-pump"


def test_the_source_fields_survive_as_attributes():
    ents = I.rows_to_entities(REGISTER, "systems", "integration:http_csv",
                              "https://h/api", key_prefix="apiabc123")
    assert ents[0]["attrs"]["serialNo"] == "IP-7781"
    assert ents[0]["provenance"]["sourceReference"] == "EQ-0001"


def test_a_list_under_an_unexpected_key_is_unwrapped():
    import json
    body = json.dumps({"equipment": REGISTER, "total": 3, "limit": 5000}).encode()
    rows = I._parse(body, "application/json", "")
    assert [r["id"] for r in rows] == ["EQ-0001", "EQ-0002", "EQ-0003"]


def test_the_known_wrappers_still_work():
    import json
    for key in ("items", "records", "results", "data", "value"):
        rows = I._parse(json.dumps({key: REGISTER}).encode(), "application/json", "")
        assert len(rows) == 3, key


def test_an_ambiguous_envelope_is_not_guessed_at():
    """Two lists of records under two keys: which is the register? Not guessed."""
    import json
    body = json.dumps({"equipment": REGISTER, "retired": REGISTER[:1]}).encode()
    rows = I._parse(body, "application/json", "")
    assert len(rows) == 1 and "equipment" in rows[0]


# ----------------------------------------------------- addresses it must refuse
import pytest  # noqa: E402


@pytest.mark.parametrize("url", [
    "http://localhost:4200/api/v1/partner/equipment?limit=5000",   # the partner's note, verbatim
    "http://127.0.0.1:8787/api/health",
    "http://[::1]:5432/",
    "http://10.0.0.5/api", "http://192.168.1.20/api", "http://172.16.4.2/api",
    "http://169.254.169.254/latest/meta-data/",                     # cloud metadata
    "http://0.0.0.0:3000/",
    "http://hospital-server.local/api",
    "http://api.localhost/records",
])
def test_addresses_inside_this_machine_or_a_private_network_are_refused(url):
    with pytest.raises(I.NotPublicURL):
        I.check_public_url(url, resolve=False)


def test_the_refusal_says_what_to_do_instead():
    with pytest.raises(I.NotPublicURL) as e:
        I.check_public_url("http://localhost:4200/api", resolve=False)
    assert "this server itself" in str(e.value)
    assert "https://" in str(e.value)


def test_a_missing_scheme_is_refused_with_a_plain_message():
    for url in ("", "hospital.example.com/api", "ftp://hospital.example.com/x"):
        with pytest.raises(I.NotPublicURL, match="https://"):
            I.check_public_url(url, resolve=False)


def test_a_public_address_is_allowed():
    I.check_public_url("https://8.8.8.8/api", resolve=False)
    I.check_public_url("https://partner.example.com/api/v1/partner/equipment?limit=5000", resolve=False)


def test_a_name_that_resolves_inside_is_refused(monkeypatch):
    """A public-looking name pointed at a private address is still inside."""
    monkeypatch.setattr(I.socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", ("10.1.2.3", 443))])
    with pytest.raises(I.NotPublicURL, match="resolves to 10.1.2.3"):
        I.check_public_url("https://sneaky.example.com/api")


def test_every_fetch_is_checked_not_just_the_save(monkeypatch):
    """A DNS change after saving must not route around the check."""
    monkeypatch.setattr(I.socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 443))])
    with pytest.raises(I.NotPublicURL):
        I._http("https://was-public.example.com/api", "token", {})


# --------------------------------------------- local collection, when it is local
def test_localhost_is_allowed_only_when_the_switch_is_on(monkeypatch):
    url = "http://localhost:4200/api/v1/partner/equipment?limit=5000"
    monkeypatch.delenv("CONNECTORS_ALLOW_LOCAL", raising=False)
    with pytest.raises(I.NotPublicURL):
        I.check_public_url(url, resolve=False)
    monkeypatch.setenv("CONNECTORS_ALLOW_LOCAL", "1")
    I.check_public_url(url, resolve=False)          # a laptop collecting from itself


def test_the_switch_does_not_accept_a_non_address(monkeypatch):
    monkeypatch.setenv("CONNECTORS_ALLOW_LOCAL", "1")
    with pytest.raises(I.NotPublicURL, match="https://"):
        I.check_public_url("localhost:4200/api", resolve=False)


def test_the_deployment_does_not_turn_the_switch_on():
    """The public server must never collect from its own localhost."""
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[2]
    for f in ("deploy/ship.sh",):
        text = (root / f).read_text() if (root / f).exists() else ""
        assert "CONNECTORS_ALLOW_LOCAL" not in text, f"{f} enables local fetching on the server"
    env = pathlib.Path("/etc/company-brain/env")
    if env.exists():
        assert "CONNECTORS_ALLOW_LOCAL" not in env.read_text(), "the server env enables local fetching"


# ----------------------------------------- where a record lands in the structure
def test_a_record_seen_in_two_departments_sits_above_both():
    assert I.common_dir(["Clinical/ICU/sop.pdf", "Clinical/Radiology/sop.pdf"]) == ("Clinical",)
    assert I.common_dir(["Clinical/ICU/a.pdf", "Clinical/ICU/b.pdf"]) == ("Clinical", "ICU")
    assert I.common_dir(["top.pdf", "Clinical/ICU/a.pdf"]) == ()
    assert I.common_dir([]) == ()


WARDS = [
    {"id": "EQ-1", "entity_type": "equipment", "name": "Infusion Pump", "department": "ICU", "serial_no": "S1"},
    {"id": "EQ-2", "entity_type": "equipment", "name": "Infusion Pump", "department": "ICU", "serial_no": "S2"},
    {"id": "EQ-3", "entity_type": "equipment", "name": "Ventilator", "department": "ICU", "serial_no": "S3"},
    {"id": "EQ-4", "entity_type": "equipment", "name": "CT Scanner", "department": "Radiology", "serial_no": "S4"},
    {"id": "EQ-5", "entity_type": "equipment", "name": "X-Ray", "department": "Radiology", "serial_no": "S5"},
]


def test_records_are_grouped_by_their_department():
    assert I.grouping_field(WARDS, exclude="entity_type") == "department"


def test_a_field_unique_to_every_record_does_not_group():
    rows = [{"name": f"Unit {i}", "location": f"Room {i}"} for i in range(10)]
    assert I.grouping_field(rows) is None


def test_a_field_with_one_value_does_not_group():
    rows = [{"name": f"Unit {i}", "department": "ICU"} for i in range(6)]
    assert I.grouping_field(rows) is None


def test_the_type_column_is_never_the_grouping():
    rows = [{"name": f"U{i}", "category": "A" if i % 2 else "B"} for i in range(6)]
    assert I.grouping_field(rows, exclude="category") is None


def test_department_beats_a_building():
    rows = [{"name": f"U{i}", "block": "A" if i < 3 else "B", "department": "ICU" if i % 2 else "Lab"}
            for i in range(6)]
    assert I.grouping_field(rows) == "department"


def test_a_prefixed_field_name_still_counts():
    rows = [{"name": f"U{i}", "department_name": "ICU" if i % 2 else "Lab"} for i in range(6)]
    assert I.grouping_field(rows) == "department_name"


# ------------------------------------------- a re-collection updates each unit
class _FakeCompanyDb:
    """Records every upsert, so the test sees which id each record was written to."""

    def __init__(self):
        self.upserts = []

    def upsert_entity(self, con, e, actor=""):
        self.upserts.append((e["id"], e["attrs"].get("serialNo")))


def _db_with(existing):
    import sqlite3
    c = sqlite3.connect(":memory:")
    c.executescript("""
      CREATE TABLE company_entities (id TEXT PRIMARY KEY, domain TEXT, name TEXT);
      CREATE TABLE integration_records (integration_id TEXT, external_id TEXT, entity_id TEXT,
        last_seen_at TEXT, PRIMARY KEY (integration_id, external_id));
    """)
    c.executemany("INSERT INTO company_entities VALUES (?,?,?)", existing)
    return c


PUMPS = [
    {"id": "EQ-1", "entity_type": "equipment", "name": "Infusion Pump", "serial_no": "IP-1"},
    {"id": "EQ-2", "entity_type": "equipment", "name": "Infusion Pump", "serial_no": "IP-2"},
    {"id": "EQ-3", "entity_type": "equipment", "name": "Infusion Pump", "serial_no": "IP-3"},
]


def test_a_re_collection_updates_each_unit_under_its_own_id():
    """The regression: on the second sync every same-named unit was written onto one."""
    ents = I.rows_to_entities(PUMPS, "systems", "integration:http_csv", "u", key_prefix="apix")
    con = _db_with([(e["id"], "systems", e["name"]) for e in ents])     # the first sync's result
    db = _FakeCompanyDb()
    I._write(con, con, db, "int-1", I.rows_to_entities(PUMPS, "systems", "integration:http_csv",
                                                         "u", key_prefix="apix"), "u")
    assert db.upserts == [("sys-apix-eq-1", "IP-1"), ("sys-apix-eq-2", "IP-2"),
                          ("sys-apix-eq-3", "IP-3")]


def test_a_file_record_is_still_recognised_by_name():
    """Folder sources have no id of their own; the name match must keep working."""
    rows = [{"name": "Priya Sharma", "role": "Owner"}]
    con = _db_with([("peo-existing-priya", "people", "Priya Sharma")])
    db = _FakeCompanyDb()
    I._write(con, con, db, "int-2", I.rows_to_entities(rows, "people", "integration:folder", "f.csv"), "f.csv")
    assert db.upserts[0][0] == "peo-existing-priya"
