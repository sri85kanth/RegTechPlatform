"""
One connection, several registers — the multi-feed sync, end to end.

A partner shares its equipment register, its complaint register and its
organisation chart under one key. These pin that the three are read in one
run and filed where they belong: complaints beside the equipment of the same
department (through the same remembered nodes), the organisation chart at the
top of the structure rather than inside the collection, and a register the
key may not read yet reported by name without failing the rest.

Runs against a DISPOSABLE PostgreSQL database — every table this touches is
dropped first. Set SYNC_TEST_DSN (e.g. postgresql:///cb_synctest) to run it;
without it the test is skipped. Never point it at a database you need.
"""
import json
import os
import urllib.error

import pytest

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

DSN = os.getenv("SYNC_TEST_DSN")
pytestmark = pytest.mark.skipif(not DSN, reason="needs a disposable database: set SYNC_TEST_DSN")

BASE = "https://partner.example.com/api/v1/partner"

EQUIPMENT = [
    {"id": "EQ-1", "entity_type": "equipment", "name": "CT scanner", "department": "Radiology", "status": "ACTIVE"},
    {"id": "EQ-2", "entity_type": "equipment", "name": "X-ray unit", "department": "Radiology", "status": "ACTIVE"},
    {"id": "EQ-3", "entity_type": "equipment", "name": "Ventilator", "department": "MICU", "status": "ACTIVE"},
    {"id": "EQ-4", "entity_type": "equipment", "name": "Defibrillator", "department": "MICU", "status": "ACTIVE"},
]
COMPLAINTS = [
    {"id": "SR-1", "entity_type": "complaint", "name": "SR-1 · CT scanner", "department": "Radiology",
     "status": "OPEN", "priority": "HIGH", "record_origin": None},
    {"id": "SR-2", "entity_type": "complaint", "name": "SR-2 · Ventilator", "department": "MICU",
     "status": "CLOSED", "priority": "MEDIUM", "record_origin": "Demo: DEMO"},
]
WALKS = [
    {"id": "WT-1", "entity_type": "walkthrough_check", "name": "2026-09-01 · Radiology", "department": "Radiology",
     "finding": "NO_COMPLAINT"},
    {"id": "WT-2", "entity_type": "walkthrough_check", "name": "2026-09-01 · MICU", "department": "MICU",
     "finding": "COMPLAINT"},
]
ORG = [
    {"id": "P-1", "entity_type": "person", "name": "A. Head", "designation": "HOD", "department": "NURSING",
     "is_head": True, "reports_to_id": None},
    {"id": "P-2", "entity_type": "person", "name": "B. Staff", "designation": "Staff nurse", "department": "NURSING",
     "is_head": False, "reports_to_id": "P-1"},
    {"id": "P-3", "entity_type": "person", "name": "C. Head", "designation": "Manager", "department": "PHARMACY",
     "is_head": True, "reports_to_id": "P-1"},
]
FEEDS = {"equipment": EQUIPMENT, "complaints": COMPLAINTS, "walkthroughs": WALKS, "org-chart": ORG}


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setenv("COMPANY_BRAIN_DSN", DSN)
    from regulatory_ingestion import company_db, integrations as I, pgdb, taxonomy as T
    con = pgdb.connect(DSN)
    for t in ("integration_records", "integration_syncs", "integrations", "company_entities",
              "company_relationships", "company_mappings", "company_profile", "org_nodes", "audit_events"):
        con.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
    con.commit()
    company_db._SCHEMA_READY = False
    T._READY.clear()
    company_db.init(con); T.init(con); I.init(con)

    def fake_http(url, secret, cfg):
        name = url.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
        if name == "invoices":
            raise urllib.error.HTTPError(url, 403, "This key may not read the invoice handover register", {}, None)
        return json.dumps({"data": FEEDS[name]}).encode(), "application/json"
    monkeypatch.setattr(I, "_http", fake_http)
    monkeypatch.setattr(I, "check_public_url", lambda *a, **k: None)

    conn = I.add(con, connector="http_csv", label="Partner registers", secret="k", config={
        "url": f"{BASE}/equipment", "collection_context": "Biomedical",
        "also": [{"url": f"{BASE}/complaints"}, {"url": f"{BASE}/walkthroughs"},
                 {"url": f"{BASE}/invoices", "label": "Invoice handover register"},
                 {"url": f"{BASE}/org-chart", "file": "top", "label": "Organisation chart"}]})
    I._set_status(con, conn["id"], "CONNECTED", "ok")
    return con, I, T, company_db, conn["id"]


def _where(con, name):
    r = con.execute("""SELECT n.name, p.name FROM company_entities e JOIN org_nodes n ON n.id = e.org_node_id
                       LEFT JOIN org_nodes p ON p.id = n.parent_id WHERE e.name = ?""", (name,)).fetchone()
    return (r[1], r[0]) if r else None


def test_every_register_is_collected_and_filed_where_it_belongs(world):
    con, I, T, company_db, iid = world
    out = I.sync(con, iid, company_db)
    assert out["outcome"] == "PARTIAL", out
    assert "Invoice handover register: not collected" in out["detail"]

    # equipment and complaints of one department share its node
    assert _where(con, "CT scanner") == ("Biomedical", "Radiology")
    assert _where(con, "SR-1 · CT scanner") == ("Biomedical", "Radiology")
    assert _where(con, "2026-09-01 · MICU") == ("Biomedical", "MICU")
    # the organisation chart is filed at the top, by its own departments
    assert _where(con, "A. Head") == (None, "NURSING")
    assert _where(con, "C. Head") == (None, "PHARMACY")

    types = dict(con.execute("SELECT name, type FROM company_entities").fetchall())
    assert types["2026-09-01 · Radiology"] == "Walkthrough check"
    assert types["SR-1 · CT scanner"] == "Complaint"
    domains = dict(con.execute("SELECT name, domain FROM company_entities").fetchall())
    assert domains["SR-1 · CT scanner"] == "evidence" and domains["A. Head"] == "people"

    attrs = json.loads(con.execute("SELECT attrs FROM company_entities WHERE name = 'A. Head'").fetchone()[0])
    assert attrs["isHead"] is True and "collectionContext" not in attrs, "the org chart is not the collection's"
    demo = json.loads(con.execute("SELECT attrs FROM company_entities WHERE name = 'SR-2 · Ventilator'").fetchone()[0])
    assert demo["recordOrigin"] == "Demo: DEMO"


def test_a_second_run_creates_nothing_new(world):
    con, I, T, company_db, iid = world
    I.sync(con, iid, company_db)
    nodes = con.execute("SELECT COUNT(*) FROM org_nodes").fetchone()[0]
    records = con.execute("SELECT COUNT(*) FROM company_entities").fetchone()[0]
    I.sync(con, iid, company_db)
    assert con.execute("SELECT COUNT(*) FROM org_nodes").fetchone()[0] == nodes
    assert con.execute("SELECT COUNT(*) FROM company_entities").fetchone()[0] == records == 11


def test_a_moved_org_department_stays_where_it_was_put(world):
    """Nesting the equipment collection under the org chart's department must survive re-syncs."""
    con, I, T, company_db, iid = world
    I.sync(con, iid, company_db)
    bio = con.execute("SELECT id FROM org_nodes WHERE name = 'Biomedical'").fetchone()[0]
    nursing = con.execute("SELECT id FROM org_nodes WHERE name = 'NURSING'").fetchone()[0]
    T.move_node(con, bio, nursing)
    I.sync(con, iid, company_db)
    assert _where(con, "CT scanner") == ("Biomedical", "Radiology")
    assert con.execute("SELECT COUNT(*) FROM org_nodes WHERE name = 'Biomedical'").fetchone()[0] == 1


def test_each_register_keeps_its_own_columns_and_names(world):
    """A complaint's priority is stored as criticality; its register must still say "priority", in its place."""
    con, I, T, company_db, iid = world
    I.sync(con, iid, company_db)
    layouts = json.loads(con.execute("SELECT config FROM integrations WHERE id = ?", (iid,)).fetchone()[0])["layouts"]
    assert set(layouts) == {"Equipment", "Complaint", "Walkthrough check", "Person"}, "invoices were not collected"
    complaint = layouts["Complaint"]
    assert [k for k, _ in complaint["fields"]] == [
        "reference", "type", "name", "attr.department", "status", "criticality", "attr.recordOrigin"]
    assert ["criticality", "priority"] in complaint["fields"]
    assert layouts["Person"]["label"] == "Organisation chart"
    assert ["attr.reportsToId", "reports_to_id"] in layouts["Person"]["fields"]


def test_a_sparse_feed_keeps_the_source_order():
    from regulatory_ingestion.integrations import feed_layout, map_columns
    rows = [{"id": "1", "name": "A", "status": "OPEN"}, {"id": "2", "name": "B", "remarks": "x", "status": "OPEN"}]
    shape = feed_layout(rows, map_columns(list(rows[0].keys())))
    assert [h for _, h in shape] == ["id", "name", "remarks", "status"]


def test_a_person_is_never_filed_by_their_managers_department():
    """With many small departments `department` can fail the grouping ceiling; reports_to_department must not win instead."""
    from regulatory_ingestion.integrations import grouping_field
    rows = [{"id": f"P-{i}", "name": f"P{i}", "department": f"D{i}", "reports_to_department": "NURSING" if i % 2 else "HR"}
            for i in range(10)]
    assert grouping_field(rows) is None, "ten departments among ten people groups nothing; the manager's never stands in"
    rows = [dict(r, department=f"D{i % 3}") for i, r in enumerate(rows)]
    assert grouping_field(rows) == "department"


def test_a_credential_column_is_never_stored():
    """A user export carrying a password column must not leave it in our database."""
    from regulatory_ingestion.integrations import rows_to_entities
    rows = [{"id": "U-1", "name": "A. Nurse", "entity_type": "person", "email": "a@x.test",
             "password": "hunter2", "api_key": "abc123", "token": "t-9", "department": "MICU"}]
    [e] = rows_to_entities(rows, "people", "test", "ref")
    assert "password" not in e["attrs"] and "apiKey" not in e["attrs"] and "token" not in e["attrs"]
    assert e["attrs"]["email"] == "a@x.test" and e["attrs"]["department"] == "MICU"


# The real employee directory feed, header for header, in its own order.
_EMPLOYEE_HEADERS = [
    "id", "entity_type", "employee_number", "full_name", "display_name", "work_email",
    "mobile_phone", "date_of_birth", "gender", "date_joined", "location", "legal_entity",
    "business_unit", "department", "sub_department", "job_title", "band", "pay_grade",
    "cost_center", "worker_type", "time_type", "reporting_manager_number", "reporting_to",
    "registration_certificate", "registration_certificate_no", "registration_expiry_date",
    "employment_status", "exit_date", "exit_status", "updated_at",
]


def test_a_person_is_named_by_their_name_not_their_job_title():
    """413 employees arrived named 'Assistant Cook', 'Supervisor': job_title won `name`."""
    from regulatory_ingestion.integrations import map_columns
    m = map_columns(_EMPLOYEE_HEADERS)
    assert m["name"] == "full_name", "the person's name, not what they do"
    assert m["status"] == "employment_status", "whether they work here, not how they left"
    assert m["reference"] == "id" and m["type"] == "entity_type" and m["department"] == "department"


def test_a_header_reads_the_same_however_it_is_written():
    """full_name, Full Name and fullName are one header; an exact alias must beat a loose one."""
    from regulatory_ingestion.integrations import map_columns
    for spelling in ("full_name", "Full Name", "fullName", "FULL-NAME"):
        assert map_columns([spelling, "job_title"])["name"] == spelling
    # a canonical entity_type column still outranks a generic category column
    assert map_columns(["entityType", "category"])["type"] == "entityType"
    assert map_columns(["record_type", "category"])["type"] == "record_type"


def test_the_order_of_the_columns_decides_a_tie_not_their_spelling():
    """Two equally loose hits must resolve by the feed's own order, so the result is stable."""
    from regulatory_ingestion.integrations import map_columns
    assert map_columns(["employment_status", "exit_status"])["status"] == "employment_status"
    assert map_columns(["exit_status", "employment_status"])["status"] == "exit_status"


def test_a_staff_register_never_holds_personal_data():
    """Name, designation, department, reporting line — not a phone, an email or a birth date."""
    from regulatory_ingestion.integrations import is_personal
    for h in ("work_email", "workEmail", "E-Mail", "mobile_phone", "personal mobile",
              "date_of_birth", "DOB", "gender", "employee_number", "emp_code",
              "reporting_manager_number", "aadhaar_number", "bank_account_number"):
        assert is_personal(h), h
    for h in ("full_name", "job_title", "department", "sub_department", "designation",
              "location", "date_joined", "invoice_number", "asset_id", "reporting_to",
              "registration_certificate_no", "employment_status", "cost_center"):
        assert not is_personal(h), h


def test_the_employee_feed_keeps_the_job_and_drops_the_person():
    from regulatory_ingestion.integrations import drop_personal, map_columns, feed_layout
    row = {h: "x" for h in _EMPLOYEE_HEADERS}
    kept = drop_personal([row], {"department", "entity_type", "id"})[0]
    assert set(kept) == set(_EMPLOYEE_HEADERS) - {
        "employee_number", "work_email", "mobile_phone", "date_of_birth", "gender",
        "reporting_manager_number"}
    # the register's own columns no longer offer them either
    shape = feed_layout([kept], map_columns(list(kept.keys())))
    assert not [h for _, h in shape if h in ("work_email", "mobile_phone", "date_of_birth")]
    assert ["name", "full_name"] in shape and ["status", "employment_status"] in shape


def test_an_identifier_is_kept_when_it_is_the_only_key():
    """Dropping the one id a feed has would key people by name and merge namesakes."""
    from regulatory_ingestion.integrations import drop_personal
    rows = [{"employee_number": "E-1", "full_name": "A Nurse", "work_email": "a@x.test"}]
    [kept] = drop_personal(rows, {"employee_number"})
    assert kept == {"employee_number": "E-1", "full_name": "A Nurse"}
