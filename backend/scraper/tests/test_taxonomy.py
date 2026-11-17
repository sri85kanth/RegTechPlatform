"""
The structure the user defines must survive being edited.

Every test here is a way a tree breaks in practice: a rename that leaves
descendants pointing at the old path, a drag that drops a branch inside itself,
two siblings with the same name colliding on one path, a delete that quietly
takes a subtree with it. The materialised path makes subtree queries cheap and
makes all four of those silent rather than loud, so they are pinned.

These run on sqlite in memory — the module uses only portable SQL, and the
point is the tree arithmetic, not the engine.
"""
import os
import sqlite3

import pytest

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

from regulatory_ingestion import taxonomy as T  # noqa: E402


@pytest.fixture
def con():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.executescript("""
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT, action TEXT, actor TEXT, detail TEXT, at TEXT);
    """)
    T.init(c)
    return c


def names(rows):
    return [r["name"] for r in rows]


def paths(con):
    return {r["name"]: r["path"] for r in con.execute("SELECT name, path FROM org_nodes")}


# ------------------------------------------------------------------ building
def test_a_company_defines_its_own_departments(con):
    it = T.add_node(con, name="Information Technology", kind="Department")
    T.add_node(con, name="Cybersecurity", parent_id=it["id"], kind="Subcategory")
    T.add_node(con, name="Infrastructure", parent_id=it["id"], kind="Subcategory")
    tree = T.tree(con)
    assert names(tree) == ["Information Technology"]
    assert names(tree[0]["children"]) == ["Cybersecurity", "Infrastructure"]


def test_nothing_is_named_in_advance(con):
    """No seeded departments. An empty structure is empty."""
    assert T.tree(con) == []


def test_a_node_needs_a_name(con):
    with pytest.raises(ValueError, match="needs a name"):
        T.add_node(con, name="   ")


def test_two_siblings_cannot_share_a_name(con):
    hr = T.add_node(con, name="Human Resources")
    T.add_node(con, name="Recruitment", parent_id=hr["id"])
    with pytest.raises(ValueError, match="already exists here"):
        T.add_node(con, name="recruitment", parent_id=hr["id"])


def test_the_same_name_under_different_parents_is_fine(con):
    a = T.add_node(con, name="Finance")
    b = T.add_node(con, name="Legal & Compliance")
    T.add_node(con, name="Regulations", parent_id=a["id"])
    T.add_node(con, name="Regulations", parent_id=b["id"])
    assert con.execute("SELECT COUNT(DISTINCT path) FROM org_nodes").fetchone()[0] == 4


def test_nesting_is_refused_past_the_guard(con):
    parent = None
    for i in range(T.MAX_DEPTH):
        parent = T.add_node(con, name=f"level{i}", parent_id=parent)["id"]
    with pytest.raises(ValueError, match="deeper than"):
        T.add_node(con, name="too deep", parent_id=parent)


# ------------------------------------------------------------------ renaming
def test_renaming_rewrites_every_descendant_path(con):
    it = T.add_node(con, name="IT")
    cyber = T.add_node(con, name="Cybersecurity", parent_id=it["id"])
    T.add_node(con, name="Incident Response", parent_id=cyber["id"])
    T.rename_node(con, it["id"], "Information Technology")
    p = paths(con)
    assert p["Information Technology"] == "information-technology"
    assert p["Cybersecurity"] == "information-technology/cybersecurity"
    assert p["Incident Response"] == "information-technology/cybersecurity/incident-response"


def test_renaming_to_a_siblings_name_is_refused(con):
    root = T.add_node(con, name="Finance")
    T.add_node(con, name="Tax", parent_id=root["id"])
    acct = T.add_node(con, name="Accounting", parent_id=root["id"])
    with pytest.raises(ValueError, match="already exists here"):
        T.rename_node(con, acct["id"], "Tax")


# -------------------------------------------------------------------- moving
def test_moving_re_parents_and_rewrites_the_subtree(con):
    it = T.add_node(con, name="IT")
    legal = T.add_node(con, name="Legal")
    dp = T.add_node(con, name="Data Protection", parent_id=it["id"])
    T.add_node(con, name="Consent", parent_id=dp["id"])
    T.move_node(con, dp["id"], legal["id"])
    p = paths(con)
    assert p["Data Protection"] == "legal/data-protection"
    assert p["Consent"] == "legal/data-protection/consent"


def test_a_node_cannot_be_moved_inside_itself(con):
    a = T.add_node(con, name="Finance")
    with pytest.raises(ValueError, match="inside itself"):
        T.move_node(con, a["id"], a["id"])


def test_a_node_cannot_be_moved_inside_its_own_descendant(con):
    """The one that detaches a branch: rows survive, the tree walk never
    reaches them, and the whole subtree disappears from the UI."""
    a = T.add_node(con, name="Finance")
    b = T.add_node(con, name="Taxation", parent_id=a["id"])
    c = T.add_node(con, name="GST", parent_id=b["id"])
    with pytest.raises(ValueError, match="inside itself"):
        T.move_node(con, a["id"], c["id"])
    assert names(T.tree(con)) == ["Finance"]


def test_moving_to_the_root_is_allowed(con):
    a = T.add_node(con, name="Finance")
    b = T.add_node(con, name="Taxation", parent_id=a["id"])
    T.move_node(con, b["id"], None)
    assert sorted(names(T.tree(con))) == ["Finance", "Taxation"]
    assert paths(con)["Taxation"] == "taxation"


# ------------------------------------------------------------------ ordering
def test_siblings_keep_insertion_order_then_can_be_reordered(con):
    root = T.add_node(con, name="IT")
    ids = [T.add_node(con, name=n, parent_id=root["id"])["id"]
           for n in ("Cybersecurity", "Infrastructure", "Data Protection")]
    assert names(T.tree(con)[0]["children"]) == ["Cybersecurity", "Infrastructure", "Data Protection"]
    T.reorder(con, root["id"], [ids[2], ids[0], ids[1]])
    assert names(T.tree(con)[0]["children"]) == ["Data Protection", "Cybersecurity", "Infrastructure"]


# ------------------------------------------------------------------ deleting
def test_delete_reports_what_it_takes_with_it(con):
    it = T.add_node(con, name="IT")
    cyber = T.add_node(con, name="Cybersecurity", parent_id=it["id"])
    T.add_node(con, name="Incident Response", parent_id=cyber["id"])
    T.add_node(con, name="Infrastructure", parent_id=it["id"])
    assert T.subtree_count(con, it["id"]) == 3          # ask before confirming
    out = T.delete_node(con, it["id"])
    assert out["count"] == 4                            # the node plus its three
    assert T.tree(con) == []


def test_deleting_a_leaf_leaves_its_siblings_alone(con):
    it = T.add_node(con, name="IT")
    a = T.add_node(con, name="Cybersecurity", parent_id=it["id"])
    T.add_node(con, name="Infrastructure", parent_id=it["id"])
    T.delete_node(con, a["id"])
    assert names(T.tree(con)[0]["children"]) == ["Infrastructure"]


# ---------------------------------------------------------------- taxonomies
def test_the_seed_installs_the_requirement_vocabulary(con):
    made = T.seed_taxonomies(con)
    assert made["taxonomies"] == 3
    tax = {t["id"]: t for t in T.taxonomies(con)}
    assert set(tax) == {"document_type", "risk", "compliance"}
    assert len(tax["document_type"]["terms"]) == 15
    assert len(tax["risk"]["terms"]) == 10
    assert len(tax["compliance"]["terms"]) == 6
    assert tax["risk"]["multi_valued"] is True
    assert tax["document_type"]["multi_valued"] is False


def test_every_seeded_term_carries_a_description(con):
    """The classifier embeds the description. A bare term name is not a signal."""
    T.seed_taxonomies(con)
    for t in T.taxonomies(con):
        for term in t["terms"]:
            assert (term["description"] or "").strip(), f"{t['id']}/{term['name']} has no description"


def test_re_seeding_does_not_undo_an_edit(con):
    T.seed_taxonomies(con)
    T.delete_term(con, "risk-third-party-risk")
    T.add_term(con, "risk", "Clinical Risk", "Patient safety and care quality.")
    again = T.seed_taxonomies(con)
    assert again["taxonomies"] == 0
    terms = {x["name"] for x in T.taxonomies(con)[1]["terms"]}
    assert "Clinical Risk" in terms
    assert "Third-Party Risk" not in terms


def test_a_term_cannot_be_added_twice(con):
    T.seed_taxonomies(con)
    with pytest.raises(ValueError, match="already exists"):
        T.add_term(con, "risk", "privacy risk")


# --------------------------------------------------------------------- audit
def test_every_structural_change_is_audited(con):
    n = T.add_node(con, name="Finance")
    T.rename_node(con, n["id"], "Finance & Accounts")
    T.delete_node(con, n["id"])
    actions = [r["action"] for r in con.execute("SELECT action FROM audit_events ORDER BY id")]
    assert actions == ["org node created", "org node renamed", "org node deleted"]


# ------------------------------------------------- the structure holds records
@pytest.fixture
def con_with_entities(con):
    con.executescript("""
      CREATE TABLE company_entities (
        id TEXT PRIMARY KEY, domain TEXT, name TEXT, type TEXT, source TEXT,
        status TEXT, criticality TEXT, org_node_id TEXT, updated_at TEXT, attrs TEXT);
    """)
    return con


def _add(con, eid, node=None, domain="people", type=None, source=None,
         status=None, criticality=None, name=None):
    con.execute("INSERT INTO company_entities "
                "(id,domain,name,type,source,status,criticality,org_node_id) VALUES (?,?,?,?,?,?,?,?)",
                (eid, domain, name or eid, type, source, status, criticality, node))


def test_a_context_typed_twice_does_not_make_two_departments(con):
    a = T.resolve_context(con, "Biomedical Department")
    b = T.resolve_context(con, "  biomedical   department ")
    assert a == b
    assert len(T.flat(con)) == 1


def test_a_context_matches_a_node_anywhere_in_the_tree(con):
    """A company that already files Biomedical under Clinical Services should
    get that node, not a second one beside it."""
    cs = T.add_node(con, name="Clinical Services")
    bio = T.add_node(con, name="Biomedical", parent_id=cs["id"])
    assert T.resolve_context(con, "Biomedical") == bio["id"]
    assert len(T.flat(con)) == 2


def test_a_context_creates_a_node_when_nothing_matches(con):
    nid = T.resolve_context(con, "Radiology")
    assert nid
    node = [n for n in T.flat(con) if n["id"] == nid][0]
    assert node["name"] == "Radiology"
    assert node["description"], "a created node must say where it came from"


def test_resolve_can_refuse_to_create(con):
    assert T.resolve_context(con, "Pharmacy", create=False) is None
    assert T.flat(con) == []


def test_an_empty_context_resolves_to_nothing(con):
    assert T.resolve_context(con, "   ") is None


def test_counts_roll_up_through_the_tree(con_with_entities):
    con = con_with_entities
    fin = T.add_node(con, name="Finance")
    tax = T.add_node(con, name="Taxation", parent_id=fin["id"])
    gst = T.add_node(con, name="GST", parent_id=tax["id"])
    _add(con, "e1", fin["id"]); _add(con, "e2", tax["id"])
    _add(con, "e3", gst["id"]); _add(con, "e4", gst["id"])
    c = T.counts(con)
    assert c["total"][gst["id"]] == 2
    assert c["total"][tax["id"]] == 3          # its own, plus GST's two
    assert c["total"][fin["id"]] == 4          # everything below it
    assert c["own"][fin["id"]] == 1            # but only one is filed directly on it


def test_records_with_no_node_are_counted_not_hidden(con_with_entities):
    """Records collected before the structure existed are real records with no
    home yet. Hiding them makes the structure look complete while the corpus
    disagrees."""
    con = con_with_entities
    fin = T.add_node(con, name="Finance")
    _add(con, "e1", fin["id"]); _add(con, "e2", None); _add(con, "e3", None)
    c = T.counts(con)
    assert c["unfiled"] == 2
    assert c["filed"] == 1


def test_filing_moves_records_and_unfiling_returns_them(con_with_entities):
    con = con_with_entities
    fin = T.add_node(con, name="Finance")
    _add(con, "e1", None); _add(con, "e2", None)
    assert T.file_under(con, fin["id"], ["e1", "e2"]) == 2
    assert T.counts(con)["unfiled"] == 0
    T.file_under(con, None, ["e2"])
    assert T.counts(con)["unfiled"] == 1


# ------------------------------------------------------ schema, once not always
# init() used to run on every request, and the sidebar requests on every page:
# six DDL statements with a commit each, 100–300 ms on the deployment. These pin
# that it now runs once per database — and that "once" is per DATABASE, because
# a bare process-wide flag would starve every fresh in-memory test database.
class _PgLike:
    """Shaped like pgdb.Connection: a psycopg handle whose info carries a DSN."""

    def __init__(self, dsn):
        info = type("Info", (), {"dsn": dsn})()
        self._c = type("Psycopg", (), {"info": info})()
        self.scripts = 0

    def executescript(self, script):
        self.scripts += 1

    def execute(self, sql, params=()):
        # Asked only which columns org_nodes has: report them all present.
        return iter([("head_name",), ("head_role",)])

    def commit(self):
        pass


def test_the_schema_is_ensured_once_per_database_not_once_per_request():
    T._READY.discard("dbname=probe-a")
    first, second = _PgLike("dbname=probe-a"), _PgLike("dbname=probe-a")
    T.init(first)
    T.init(second)                     # a later request, same database
    assert first.scripts + second.scripts == 1


def test_a_different_database_is_still_initialised():
    for k in ("dbname=probe-b", "dbname=probe-c"):
        T._READY.discard(k)
    b, c = _PgLike("dbname=probe-b"), _PgLike("dbname=probe-c")
    T.init(b)
    T.init(c)
    assert (b.scripts, c.scripts) == (1, 1)


def test_a_failed_first_attempt_is_retried():
    T._READY.discard("dbname=probe-d")

    class _Flaky(_PgLike):
        def executescript(self, script):
            self.scripts += 1
            if self.scripts == 1:
                raise RuntimeError("database busy")

    con = _Flaky("dbname=probe-d")
    with pytest.raises(RuntimeError):
        T.init(con)
    T.init(con)                        # must try again, not believe it succeeded
    assert con.scripts == 2


def test_an_in_memory_database_is_always_initialised():
    """The fixture depends on this: every test gets a fresh sqlite database."""
    for _ in range(2):
        c = sqlite3.connect(":memory:")
        c.row_factory = sqlite3.Row
        T.init(c)
        assert c.execute("SELECT COUNT(*) FROM org_nodes").fetchone()[0] == 0


# ------------------------------------------------ the structure builds itself
@pytest.mark.parametrize("raw,clean", [
    ("17_Job_Descriptions", "Job Descriptions"),
    ("03_SOPs", "SOPs"),
    ("25_Support_Services", "Support Services"),
    ("Nirmaya-Demo-Corpus", "Nirmaya Demo Corpus"),
    ("1. Finance", "Finance"),
    ("ICU", "ICU"),
    ("2026", "2026"),                  # a folder that IS a number keeps its name
])
def test_folder_names_lose_their_sort_prefix_and_underscores(raw, clean):
    assert T.folder_label(raw) == clean


def test_a_path_is_created_once_and_reused(con):
    a = T.ensure_path(con, ["Clinical", "ICU", "Equipment"])
    b = T.ensure_path(con, ["clinical", "icu", "EQUIPMENT"])      # a re-sync
    assert a == b
    assert [n["path"] for n in T.flat(con)] == ["clinical", "clinical/icu", "clinical/icu/equipment"]


def test_the_same_folder_name_under_two_parents_stays_two_nodes(con):
    icu = T.ensure_path(con, ["ICU", "Records"])
    rad = T.ensure_path(con, ["Radiology", "Records"])
    assert icu != rad
    assert len([n for n in T.flat(con) if n["name"] == "Records"]) == 2


def test_a_path_starts_beneath_a_given_parent(con):
    root = T.resolve_context(con, "Biomedical Department")
    leaf = T.ensure_path(con, ["SOPs"], parent_id=root)
    node = [n for n in T.flat(con) if n["id"] == leaf][0]
    assert node["parent_id"] == root and node["depth"] == 1


def test_a_tree_deeper_than_the_guard_is_folded_not_refused(con):
    parts = [f"level{i}" for i in range(T.MAX_DEPTH + 3)]
    leaf = T.ensure_path(con, parts)
    assert leaf is not None                                 # the records still have a home
    assert max(n["depth"] for n in T.flat(con)) == T.MAX_DEPTH - 1


def test_empty_parts_are_skipped(con):
    leaf = T.ensure_path(con, ["", "  ", "Finance"])
    assert [n["name"] for n in T.flat(con)] == ["Finance"] and leaf


def test_counts_say_what_each_node_holds_and_where_it_came_from(con_with_entities):
    """A department page names what it holds — "Equipment 315, from an API" —
    and a parent says it for everything beneath it, like its total does."""
    con = con_with_entities
    bio = T.add_node(con, name="Biomedical", kind="Department")
    micu = T.add_node(con, name="MICU", parent_id=bio["id"])
    for i in range(3):
        _add(con, f"m{i}", micu["id"], "systems", "Equipment", "integration:http_csv")
    _add(con, "b1", bio["id"], "systems", "Equipment", "integration:http_csv")
    _add(con, "p1", bio["id"], "policies", None, "integration:folder")
    c = T.counts(con)
    assert c["collected"][micu["id"]] == [{"domain": "systems", "type": "Equipment", "n": 3}]
    assert c["collected"][bio["id"]] == [{"domain": "systems", "type": "Equipment", "n": 4},
                                         {"domain": "policies", "type": None, "n": 1}]
    assert c["sources"][bio["id"]] == {"integration:http_csv": 4, "integration:folder": 1}
    assert c["own"][bio["id"]] == 2 and c["total"][bio["id"]] == 5


# ------------------------------------------ names that come from a source field
@pytest.mark.parametrize("raw, shown", [
    ("3rd floor room", "3rd Floor Room"),
    ("First floor", "First Floor"),
    ("Opd -Procedure Room", "Opd - Procedure Room"),
    ("Opd- Procedure Room", "Opd - Procedure Room"),
    ("Opd-12", "Opd-12"),                       # no space either side: a compound, kept
    ("Post-Op", "Post-Op"),
    ("post-op", "Post-Op"),
    ("MICU", "MICU"),                           # an acronym is never re-cased
    ("Opd", "Opd"),                             # ...nor guessed at
    ("  emergency   department ", "Emergency Department"),
    ("head of department", "Head of Department"),
    ("of counsel", "Of Counsel"),               # the first word is always capitalised
])
def test_a_source_value_becomes_a_readable_name(raw, shown):
    assert T.group_label(raw) == shown


def test_tidying_never_merges_two_different_values():
    assert T.group_label("3rd floor room") != T.group_label("3rd Floor Ward")
    assert T.group_label("First floor") != T.group_label("1st Floor Ward")


def test_a_tidied_name_still_finds_the_node_the_raw_value_made(con):
    """Nodes made before tidying existed must be reused, not duplicated."""
    bio = T.add_node(con, name="Biomedical")
    old = T.ensure_path(con, ["Opd -Procedure Room"], parent_id=bio["id"])
    assert T.ensure_path(con, [T.group_label("Opd -Procedure Room")], parent_id=bio["id"]) == old
    assert len(T.flat(con)) == 2


# ------------------------------------- a connection remembers the nodes it made
def test_a_renamed_department_keeps_its_records_on_the_next_sync(con):
    """The regression: renaming a collected department made the next sync
    create the old name again beside it and move every record back."""
    memory = T.Remembered(con)
    home = memory.node("home", lambda: T.resolve_context(con, "Biomedical Equipment"))
    T.rename_node(con, home, "Biomedical")
    again = T.Remembered(con, memory.to_save())          # the next run, from saved config
    assert again.node("home", lambda: T.resolve_context(con, "Biomedical Equipment")) == home
    assert names(T.flat(con)) == ["Biomedical"]


def test_a_moved_unit_stays_where_the_user_put_it(con):
    memory = T.Remembered(con)
    home = memory.node("home", lambda: T.resolve_context(con, "Biomedical"))
    micu = memory.node("group:micu", lambda: T.ensure_path(con, ["MICU"], parent_id=home))
    critical = T.add_node(con, name="Critical Care")
    T.move_node(con, micu, critical["id"])
    again = T.Remembered(con, memory.to_save())
    assert again.node("group:micu", lambda: T.ensure_path(con, ["MICU"], parent_id=home)) == micu
    assert len(T.flat(con)) == 3


def test_a_deleted_node_is_found_again_by_name_or_made_again(con):
    memory = T.Remembered(con)
    home = memory.node("home", lambda: T.resolve_context(con, "Radiology"))
    T.delete_node(con, home)
    assert memory.to_save() == {}, "a deleted node is not carried in the saved config"
    again = T.Remembered(con, {"home": home})
    fresh = again.node("home", lambda: T.resolve_context(con, "Radiology"))
    assert fresh and fresh != home
    assert again.changed and again.to_save() == {"home": fresh}


def test_nothing_changes_when_every_remembered_node_still_exists(con):
    memory = T.Remembered(con)
    memory.node("home", lambda: T.resolve_context(con, "Laboratory"))
    again = T.Remembered(con, memory.to_save())
    again.node("home", lambda: pytest.fail("a remembered node must not be looked up again"))
    assert not again.changed


def test_counts_carry_the_sources_own_status_and_criticality(con_with_entities):
    """A department card says "4 under maintenance, 15 life support" and "88
    kinds" without loading its records — rolled up the tree like the total."""
    con = con_with_entities
    bio = T.add_node(con, name="Biomedical")
    micu = T.add_node(con, name="MICU", parent_id=bio["id"])
    _add(con, "a", micu["id"], "systems", status="ACTIVE", criticality="LIFE_SUPPORT", name="ICU Ventilator")
    _add(con, "b", micu["id"], "systems", status="UNDER_MAINTENANCE", criticality="CRITICAL", name="icu  ventilator")
    _add(con, "c", bio["id"], "systems", status="ACTIVE", name="Syringe pump")
    _add(con, "d", bio["id"], "systems", name="Suction jar")          # the source sent neither
    c = T.counts(con)
    assert c["status"][micu["id"]] == {"ACTIVE": 1, "UNDER_MAINTENANCE": 1}
    assert c["status"][bio["id"]] == {"ACTIVE": 2, "UNDER_MAINTENANCE": 1}, "no '' status bucket"
    assert c["criticality"][bio["id"]] == {"LIFE_SUPPORT": 1, "CRITICAL": 1}
    # the same thing spelled with different case or spacing is one kind
    assert c["distinct_names"][micu["id"]] == 1
    assert c["distinct_names"][bio["id"]] == 3


def test_signals_keep_each_kind_of_record_apart(con_with_entities):
    """A complaint's CRITICAL priority and an equipment item's CRITICAL criticality share a
    column; counted per kind of record they are never added together."""
    con = con_with_entities
    bio = T.add_node(con, name="Biomedical")
    micu = T.add_node(con, name="MICU", parent_id=bio["id"])
    _add(con, "a", micu["id"], "systems", type="Equipment", status="ACTIVE", criticality="CRITICAL")
    _add(con, "b", micu["id"], "systems", type="Equipment", status="CONDEMNED", criticality="CRITICAL")
    _add(con, "c", bio["id"], "evidence", type="Complaint", status="OPEN", criticality="CRITICAL")
    got = {(s["type"], s["field"], s["value"]): s["n"] for s in T.counts(con)["signals"][bio["id"]]}
    assert got == {("Equipment", "criticality", "CRITICAL"): 2, ("Complaint", "criticality", "CRITICAL"): 1,
                   ("Equipment", "status", "ACTIVE"): 1, ("Equipment", "status", "CONDEMNED"): 1,
                   ("Complaint", "status", "OPEN"): 1}
    assert T.counts(con)["signals"][micu["id"]][0] == {"type": "Equipment", "field": "criticality",
                                                        "value": "CRITICAL", "n": 2}


# ------------------------------------------ where a department's records came from
def test_a_department_names_the_connection_it_came_from_and_never_its_secret(con_with_entities):
    from regulatory_ingestion import api_taxonomy as A, integrations as I
    con = con_with_entities
    I.init(con)
    bio = T.add_node(con, name="Biomedical")
    micu = T.add_node(con, name="MICU", parent_id=bio["id"])
    con.execute(
        "INSERT INTO integrations (id, connector, label, config, secret, status, last_sync_at, "
        "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("int-1", "http_csv", "Biomedical equipment register",
         '{"url": "https://partner.example.com/api/v1/partner/equipment?limit=5000", '
         '"auth_scheme": "bearer"}', "pbme_SECRET_VALUE", "CONNECTED",
         "2026-09-21T07:18:05+00:00", "t", "t"))
    for eid, node in (("e1", micu["id"]), ("e2", micu["id"]), ("e3", bio["id"])):
        _add(con, eid, node, "systems")
        con.execute("INSERT INTO integration_records (integration_id, external_id, entity_id, "
                    "last_seen_at) VALUES (?,?,?,?)", ("int-1", eid.upper(), eid, "t"))
    _add(con, "manual", bio["id"], "systems")            # typed in by hand: no connection

    path = [n for n in T.flat(con) if n["id"] == bio["id"]][0]["path"]
    got = A._sources(con, "(n.id = ? OR n.path LIKE ?)", (bio["id"], path + "/%"))
    assert got == [{"id": "int-1", "label": "Biomedical equipment register",
                    "connector": "http_csv", "kind": "API endpoint",
                    "where": "partner.example.com", "lastSyncAt": "2026-09-21T07:18:05+00:00",
                    "records": 3, "caveats": {}, "layouts": {}}]
    assert "SECRET" not in repr(got) and "auth_scheme" not in repr(got)
    assert A._sources(con, "n.id = ?", (micu["id"],))[0]["records"] == 2


# ------------------------------------------------------------ who heads a node
def test_a_head_is_recorded_changed_and_cleared(con):
    bio = T.add_node(con, name="Biomedical", kind="Department",
                     head_name="  Dr A. Rao ", head_role="Head of Biomedical Engineering")
    assert (bio["head_name"], bio["head_role"]) == ("Dr A. Rao", "Head of Biomedical Engineering")
    kept = T.update_node(con, bio["id"], description="Equipment and its upkeep")
    assert kept["head_name"] == "Dr A. Rao", "editing something else leaves the head alone"
    changed = T.update_node(con, bio["id"], head_name="B. Reddy")
    assert changed["head_name"] == "B. Reddy" and changed["head_role"] == "Head of Biomedical Engineering"
    cleared = T.update_node(con, bio["id"], head_name="", head_role="")
    assert cleared["head_name"] is None and cleared["head_role"] is None


def test_nobody_is_named_head_unless_someone_says_so(con):
    node = T.add_node(con, name="Radiology")
    assert node["head_name"] is None and node["head_role"] is None


def test_an_existing_table_gets_the_head_columns(con):
    """A deployment created before heads existed must not be left without them."""
    import sqlite3
    old = sqlite3.connect(":memory:")
    old.row_factory = sqlite3.Row
    old.executescript("""
      CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT, action TEXT,
        actor TEXT, detail TEXT, at TEXT);
      CREATE TABLE org_nodes (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, kind TEXT,
        description TEXT, position INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    """)
    T.init(old)
    assert {"head_name", "head_role"} <= T._node_columns(old)
    assert T.add_node(old, name="Finance", head_name="C. Iyer")["head_name"] == "C. Iyer"


def test_heads_are_read_from_what_the_source_says(con_with_entities):
    """An organisation chart marks its heads; nobody else is promoted to one."""
    con = con_with_entities
    nursing = T.add_node(con, name="NURSING")
    for eid, name, attrs in (
            ("p1", "A. Head", '{"isHead": true, "designation": "HOD", "reportsTo": "Z. Director"}'),
            ("p2", "B. Staff", '{"isHead": false, "designation": "Staff nurse"}'),
            ("p3", "C. Someone", '{"designation": "Head nurse"}')):       # a title is not the flag
        con.execute("INSERT INTO company_entities (id,domain,name,org_node_id,attrs) VALUES (?,?,?,?,?)",
                    (eid, "people", name, nursing["id"], attrs))
    heads = T.counts(con)["heads"]
    assert [h["name"] for h in heads[nursing["id"]]] == ["A. Head"]
    assert heads[nursing["id"]][0]["role"] == "HOD" and heads[nursing["id"]][0]["reportsTo"] == "Z. Director"
