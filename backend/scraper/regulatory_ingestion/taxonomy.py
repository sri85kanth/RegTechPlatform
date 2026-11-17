"""
The organisation structure the user defines, and the taxonomy documents are
classified against.

WHY NOTHING HERE IS HARD-CODED
------------------------------
A hospital, a bank and a manufacturer do not share departments, and the previous
intake assumed they did: eleven fixed domains, and every uploaded document had
to be pushed into one of them by hand. This stores the structure as ROWS, so the
company describes itself and the classifier reads that description back.

`description` is the load-bearing column and it is easy to mistake for
decoration. A node called "Cybersecurity" gives the classifier one word. The
same node described as "incident response, vulnerability management, access
control and security monitoring" gives it a sentence to embed, and that sentence
is what a document is actually compared against. The UI must ask for it.

THE MATERIALISED PATH
---------------------
`path` holds 'finance/taxation' so a subtree is one LIKE, not a recursive walk.
It is derived, never typed, and every rename or move rewrites the subtree — a
stale path is a node that silently disappears from its own parent's listing.

TAXONOMY, NOT CONSTANTS
-----------------------
Document type, risk class and compliance class arrive as seeded ROWS. The seeds
are the vocabulary from the requirement; a company that needs a term the seed
does not have adds it, and one that never uses "Third-Party Risk" deletes it.
Nothing in the classifier reads a Python list of terms.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

MAX_DEPTH = 8          # "unlimited nesting where appropriate" — a guard, not a design limit
MAX_NAME = 120


SCHEMA = """
CREATE TABLE IF NOT EXISTS org_nodes (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT,
  name        TEXT NOT NULL,
  kind        TEXT,
  description TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  path        TEXT NOT NULL,
  depth       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  head_name   TEXT,
  head_role   TEXT
);
CREATE INDEX IF NOT EXISTS idx_org_parent ON org_nodes(parent_id, position);
CREATE INDEX IF NOT EXISTS idx_org_path   ON org_nodes(path);

CREATE TABLE IF NOT EXISTS taxonomies (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  multi_valued INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS taxonomy_terms (
  id           TEXT PRIMARY KEY,
  taxonomy_id  TEXT NOT NULL,
  parent_id    TEXT,
  name         TEXT NOT NULL,
  description  TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tax_terms ON taxonomy_terms(taxonomy_id, position);
"""


# The requirement's own vocabulary (§5), seeded as editable rows. Each term
# carries a description for the same reason org nodes do: the classifier embeds
# the description, and "Control" alone is not a discriminating signal.
SEED_TAXONOMIES = [
    {
        "id": "document_type", "name": "Document Type", "multi_valued": False,
        "description": "What kind of document this is, regardless of its file format.",
        "terms": [
            ("Policy", "States what the organisation requires. Approved, dated, and binding internally."),
            ("Regulation", "An instrument issued by an external authority — an Act, rule, or gazette notification."),
            ("Procedure", "Step-by-step instructions for carrying out a task. Often titled SOP."),
            ("Standard", "A specification something must conform to, internal or external."),
            ("Guideline", "Recommended practice. Advisory rather than mandatory."),
            ("Framework", "An organising structure for a programme of work."),
            ("Requirement", "A single stated obligation, usually drawn from a regulation or standard."),
            ("Control", "A check or safeguard that enforces a policy or mitigates a risk."),
            ("Risk", "An identified exposure, with its rating and treatment."),
            ("Audit", "The plan, working papers or findings of a review."),
            ("Report", "A periodic or one-off account of status or results."),
            ("Contract", "An agreement with an external party."),
            ("Evidence", "An artefact proving a control operated — a log, attestation, or report output."),
            ("Record", "A retained business record kept because a rule requires it."),
            ("Other", "Does not fit the terms above."),
        ],
    },
    {
        "id": "risk", "name": "Risk Classification", "multi_valued": True,
        "description": "Which risk domains the document concerns.",
        "terms": [
            ("Operational Risk", "Failure of internal processes, people or systems."),
            ("Financial Risk", "Credit, market, liquidity and capital exposure."),
            ("Cybersecurity Risk", "Unauthorised access, intrusion, malware, incident response."),
            ("Compliance Risk", "Failure to meet a regulatory obligation."),
            ("Legal Risk", "Litigation, contractual liability and enforceability."),
            ("Strategic Risk", "Business model, market position and major decisions."),
            ("Privacy Risk", "Handling of personal data, consent, retention and disclosure."),
            ("Third-Party Risk", "Vendors, outsourcing, service providers and supply chain."),
            ("Reputational Risk", "Public trust, conduct and brand damage."),
            ("Environmental Risk", "Emissions, waste, pollution and environmental consent."),
        ],
    },
    {
        "id": "compliance", "name": "Compliance Classification", "multi_valued": True,
        "description": "How the document relates to external compliance.",
        "terms": [
            ("Regulation", "The instrument itself."),
            ("Regulatory Requirement", "A specific duty the regulation imposes."),
            ("Compliance Obligation", "A duty the organisation has accepted, from any source."),
            ("Control Requirement", "A required check, stated by a regulation or standard."),
            ("Audit Requirement", "A required review, attestation or inspection."),
            ("Regulatory Guidance", "Non-binding interpretation issued by an authority."),
        ],
    },
]


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def slug(s: str) -> str:
    keep = "".join(c if c.isalnum() else "-" for c in (s or "").lower())
    return "-".join(p for p in keep.split("-") if p)[:60] or "node"


# Databases this process has already ensured the schema on.
#
# init() ran on EVERY request. The sidebar fetches /api/structure on every page
# load, so every navigation paid for six CREATE … IF NOT EXISTS statements, each
# committed separately — measured on the deployment at 100–300 ms, against 1 ms
# for a plain round trip.
#
# The guard is keyed by DATABASE, not a bare "done" flag. A bare flag is what
# company_db uses, and it would be wrong here: every taxonomy test opens a brand
# new in-memory sqlite database that genuinely has no tables, and a process-wide
# flag would leave the second test onwards querying tables that were never made.
_READY: set[str] = set()


def _db_key(con) -> str | None:
    """
    A stable identity for the database behind `con`, or None when there is none.

    A psycopg connection (inside pgdb) carries its DSN, and every API connection
    to the same database shares it. An in-memory sqlite connection is a new
    database each time, so it returns None and is always initialised.
    """
    try:
        return con._c.info.dsn
    except AttributeError:
        return None


# Who heads a node — recorded by a person, never inferred. Added after
# org_nodes shipped, so an existing table gets the columns it is missing:
# CREATE TABLE IF NOT EXISTS leaves a table that is already there untouched.
ADDED_COLUMNS = [("head_name", "TEXT"), ("head_role", "TEXT")]


def _node_columns(con) -> set[str]:
    try:
        return {r[0] for r in con.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'org_nodes'")}
    except Exception:                        # sqlite has no information_schema
        return {r[1] for r in con.execute("PRAGMA table_info(org_nodes)")}


def init(con):
    key = _db_key(con)
    if key is not None and key in _READY:
        return con
    con.executescript(SCHEMA)
    have = _node_columns(con)
    for col, ddl in ADDED_COLUMNS:
        if col not in have:
            con.execute(f"ALTER TABLE org_nodes ADD COLUMN {col} {ddl}")
    con.commit()
    if key is not None:
        # Only once it succeeded — a failed first attempt must be retried.
        _READY.add(key)
    return con


def seed_taxonomies(con) -> dict[str, int]:
    """Install the default vocabulary. Never overwrites a taxonomy that exists —
    a company may have edited its terms, and re-seeding would undo that."""
    made = {"taxonomies": 0, "terms": 0}
    for t in SEED_TAXONOMIES:
        if con.execute("SELECT 1 FROM taxonomies WHERE id=?", (t["id"],)).fetchone():
            continue
        con.execute(
            """INSERT INTO taxonomies (id,name,description,multi_valued,position,created_at)
               VALUES (?,?,?,?,?,?)""",
            (t["id"], t["name"], t["description"], 1 if t["multi_valued"] else 0,
             SEED_TAXONOMIES.index(t), _now()))
        made["taxonomies"] += 1
        for i, (name, desc) in enumerate(t["terms"]):
            con.execute(
                """INSERT INTO taxonomy_terms (id,taxonomy_id,parent_id,name,description,position,created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (f"{t['id']}-{slug(name)}", t["id"], None, name, desc, i, _now()))
            made["terms"] += 1
    con.commit()
    return made


# ------------------------------------------------------------------ org tree
def _row(con, node_id: str):
    return con.execute("SELECT * FROM org_nodes WHERE id=?", (node_id,)).fetchone()


def _next_position(con, parent_id: str | None) -> int:
    r = con.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM org_nodes WHERE parent_id IS NOT DISTINCT FROM ?",
        (parent_id,)).fetchone()
    return int(r[0] or 0)


def _path_for(con, parent_id: str | None, name: str) -> tuple[str, int]:
    if not parent_id:
        return slug(name), 0
    p = _row(con, parent_id)
    if not p:
        raise ValueError(f"no such parent node: {parent_id}")
    return f"{p['path']}/{slug(name)}", int(p["depth"]) + 1


def add_node(con, *, name: str, parent_id: str | None = None,
             kind: str | None = None, description: str | None = None,
             head_name: str | None = None, head_role: str | None = None,
             actor: str = "user") -> dict:
    """
    Create one node. A name is required; everything else is optional — the point
    of this screen is that the user types their own words, not that they fill a
    form.
    """
    name = (name or "").strip()
    if not name:
        raise ValueError("a node needs a name")
    if len(name) > MAX_NAME:
        raise ValueError(f"name is longer than {MAX_NAME} characters")
    path, depth = _path_for(con, parent_id, name)
    if depth >= MAX_DEPTH:
        raise ValueError(f"nesting deeper than {MAX_DEPTH} levels is refused")
    # Siblings with the same name would produce the same path, and the path is
    # what subtree queries key on.
    clash = con.execute(
        "SELECT 1 FROM org_nodes WHERE parent_id IS NOT DISTINCT FROM ? AND lower(name)=lower(?)",
        (parent_id, name)).fetchone()
    if clash:
        raise ValueError(f"'{name}' already exists here")

    nid = _id("org")
    con.execute(
        """INSERT INTO org_nodes (id,parent_id,name,kind,description,position,path,depth,created_at,updated_at,
                                  head_name,head_role)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (nid, parent_id, name, kind, description, _next_position(con, parent_id),
         path, depth, _now(), _now(), _clean(head_name), _clean(head_role)))
    _audit(con, nid, "org node created", f"{path}", actor)
    con.commit()
    return dict(_row(con, nid))


def _rewrite_subtree(con, node_id: str) -> None:
    """After a rename or a move, every descendant's path and depth is stale."""
    node = _row(con, node_id)
    kids = con.execute(
        "SELECT id, name FROM org_nodes WHERE parent_id=? ORDER BY position", (node_id,)).fetchall()
    for k in kids:
        con.execute("UPDATE org_nodes SET path=?, depth=?, updated_at=? WHERE id=?",
                    (f"{node['path']}/{slug(k['name'])}", int(node["depth"]) + 1, _now(), k["id"]))
        _rewrite_subtree(con, k["id"])


def rename_node(con, node_id: str, name: str, *, actor: str = "user") -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("a node needs a name")
    node = _row(con, node_id)
    if not node:
        raise ValueError("no such node")
    clash = con.execute(
        """SELECT 1 FROM org_nodes WHERE parent_id IS NOT DISTINCT FROM ?
             AND lower(name)=lower(?) AND id<>?""",
        (node["parent_id"], name, node_id)).fetchone()
    if clash:
        raise ValueError(f"'{name}' already exists here")
    path, depth = _path_for(con, node["parent_id"], name)
    con.execute("UPDATE org_nodes SET name=?, path=?, depth=?, updated_at=? WHERE id=?",
                (name, path, depth, _now(), node_id))
    _rewrite_subtree(con, node_id)
    _audit(con, node_id, "org node renamed", f"{node['name']} → {name}", actor)
    con.commit()
    return dict(_row(con, node_id))


def _clean(v: str | None) -> str | None:
    return ((v or "").strip()[:MAX_NAME]) or None


def update_node(con, node_id: str, *, kind=None, description=None,
                head_name: str | None = None, head_role: str | None = None,
                actor: str = "user") -> dict:
    """
    Change what a node says about itself. For the head, None leaves it as it
    is and an empty string clears it — a department whose head has left must
    be able to say "not recorded" again rather than keep a stale name.
    """
    node = _row(con, node_id)
    if not node:
        raise ValueError("no such node")
    sets = ["kind=COALESCE(?,kind)", "description=COALESCE(?,description)", "updated_at=?"]
    args: list = [kind, description, _now()]
    for col, value in (("head_name", head_name), ("head_role", head_role)):
        if value is not None:
            sets.append(f"{col}=?")
            args.append(_clean(value))
    con.execute(f"UPDATE org_nodes SET {', '.join(sets)} WHERE id=?", (*args, node_id))
    if head_name is not None or head_role is not None:
        _audit(con, node_id, "org node head set",
               f"{node['path']}: {_clean(head_name) or 'not recorded'}", actor)
    _audit(con, node_id, "org node updated", node["path"], actor)
    con.commit()
    return dict(_row(con, node_id))


def _is_descendant(con, node_id: str, maybe_child: str) -> bool:
    node = _row(con, node_id)
    child = _row(con, maybe_child)
    if not node or not child:
        return False
    return child["path"] == node["path"] or child["path"].startswith(node["path"] + "/")


def move_node(con, node_id: str, new_parent_id: str | None, *,
              position: int | None = None, actor: str = "user") -> dict:
    """
    Re-parent, and/or reorder among siblings.

    A node cannot be moved inside itself or its own descendant. Without that
    check the subtree detaches from the root: the rows survive, the path walk
    never reaches them, and the branch simply vanishes from the tree.
    """
    node = _row(con, node_id)
    if not node:
        raise ValueError("no such node")
    if new_parent_id == node_id or (new_parent_id and _is_descendant(con, node_id, new_parent_id)):
        raise ValueError("a node cannot be moved inside itself")
    path, depth = _path_for(con, new_parent_id, node["name"])
    kids_depth = con.execute(
        "SELECT COALESCE(MAX(depth),?) FROM org_nodes WHERE path LIKE ?",
        (node["depth"], node["path"] + "/%")).fetchone()[0]
    if depth + (int(kids_depth) - int(node["depth"])) >= MAX_DEPTH:
        raise ValueError(f"that move would nest deeper than {MAX_DEPTH} levels")

    pos = _next_position(con, new_parent_id) if position is None else int(position)
    con.execute("UPDATE org_nodes SET parent_id=?, path=?, depth=?, position=?, updated_at=? WHERE id=?",
                (new_parent_id, path, depth, pos, _now(), node_id))
    _rewrite_subtree(con, node_id)
    _renumber(con, node["parent_id"])
    if new_parent_id != node["parent_id"]:
        _renumber(con, new_parent_id)
    _audit(con, node_id, "org node moved", f"{node['path']} → {path}", actor)
    con.commit()
    return dict(_row(con, node_id))


def _renumber(con, parent_id: str | None) -> None:
    rows = con.execute(
        "SELECT id FROM org_nodes WHERE parent_id IS NOT DISTINCT FROM ? ORDER BY position, name",
        (parent_id,)).fetchall()
    for i, r in enumerate(rows):
        con.execute("UPDATE org_nodes SET position=? WHERE id=?", (i, r["id"]))


def reorder(con, parent_id: str | None, ordered_ids: list[str], *, actor: str = "user") -> None:
    """Set sibling order explicitly, from a drag-and-drop."""
    for i, nid in enumerate(ordered_ids):
        con.execute(
            "UPDATE org_nodes SET position=?, updated_at=? WHERE id=? AND parent_id IS NOT DISTINCT FROM ?",
            (i, _now(), nid, parent_id))
    _renumber(con, parent_id)
    _audit(con, parent_id or "(root)", "org nodes reordered", ",".join(ordered_ids[:10]), actor)
    con.commit()


def delete_node(con, node_id: str, *, actor: str = "user") -> dict:
    """
    Delete a node and its subtree.

    Returns what was removed rather than a bare ok, so the caller can tell the
    user "this removes 3 subcategories" BEFORE they confirm — a delete that
    silently takes a branch with it is the fastest way to lose a structure
    somebody spent an afternoon building.
    """
    node = _row(con, node_id)
    if not node:
        raise ValueError("no such node")
    doomed = con.execute(
        "SELECT id, path FROM org_nodes WHERE id=? OR path LIKE ?",
        (node_id, node["path"] + "/%")).fetchall()
    con.execute("DELETE FROM org_nodes WHERE id=? OR path LIKE ?", (node_id, node["path"] + "/%"))
    _renumber(con, node["parent_id"])
    _audit(con, node_id, "org node deleted", f"{node['path']} (+{len(doomed) - 1} below)", actor)
    con.commit()
    return {"removed": [dict(d) for d in doomed], "count": len(doomed)}


def subtree_count(con, node_id: str) -> int:
    node = _row(con, node_id)
    if not node:
        return 0
    return con.execute("SELECT COUNT(*) FROM org_nodes WHERE path LIKE ?",
                       (node["path"] + "/%",)).fetchone()[0]


def tree(con) -> list[dict]:
    """The whole structure, nested, in display order."""
    rows = [dict(r) for r in con.execute(
        "SELECT * FROM org_nodes ORDER BY depth, position, name")]
    by_id = {r["id"]: {**r, "children": []} for r in rows}
    roots = []
    for r in rows:
        node = by_id[r["id"]]
        parent = by_id.get(r["parent_id"]) if r["parent_id"] else None
        (parent["children"] if parent else roots).append(node)
    return roots


def flat(con) -> list[dict]:
    """Every node with its full path — what the classifier scores against."""
    return [dict(r) for r in con.execute(
        "SELECT * FROM org_nodes ORDER BY path")]


# ---------------------------------------------------------------- taxonomies
def taxonomies(con) -> list[dict]:
    out = []
    for t in con.execute("SELECT * FROM taxonomies ORDER BY position, name"):
        d = dict(t)
        d["multi_valued"] = bool(d.get("multi_valued"))
        d["terms"] = [dict(x) for x in con.execute(
            "SELECT * FROM taxonomy_terms WHERE taxonomy_id=? ORDER BY position, name", (t["id"],))]
        out.append(d)
    return out


def add_term(con, taxonomy_id: str, name: str, description: str | None = None,
             *, actor: str = "user") -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("a term needs a name")
    if not con.execute("SELECT 1 FROM taxonomies WHERE id=?", (taxonomy_id,)).fetchone():
        raise ValueError("no such taxonomy")
    if con.execute("SELECT 1 FROM taxonomy_terms WHERE taxonomy_id=? AND lower(name)=lower(?)",
                   (taxonomy_id, name)).fetchone():
        raise ValueError(f"'{name}' already exists in this taxonomy")
    tid = f"{taxonomy_id}-{slug(name)}"
    pos = con.execute("SELECT COALESCE(MAX(position),-1)+1 FROM taxonomy_terms WHERE taxonomy_id=?",
                      (taxonomy_id,)).fetchone()[0]
    con.execute(
        """INSERT INTO taxonomy_terms (id,taxonomy_id,parent_id,name,description,position,created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (tid, taxonomy_id, None, name, description, int(pos or 0), _now()))
    _audit(con, tid, "taxonomy term added", f"{taxonomy_id}: {name}", actor)
    con.commit()
    return dict(con.execute("SELECT * FROM taxonomy_terms WHERE id=?", (tid,)).fetchone())


def delete_term(con, term_id: str, *, actor: str = "user") -> None:
    con.execute("DELETE FROM taxonomy_terms WHERE id=?", (term_id,))
    _audit(con, term_id, "taxonomy term deleted", term_id, actor)
    con.commit()


# --------------------------------------------------------------------- audit
def _audit(con, entity_id: str, action: str, detail: str, actor: str) -> None:
    """§16 — every structural change is logged with who and when."""
    try:
        con.execute(
            "INSERT INTO audit_events (entity_id,action,actor,detail,at) VALUES (?,?,?,?,?)",
            (entity_id, action, actor, detail[:500], _now()))
    except Exception:                       # noqa: BLE001 — never fail a write because the log did
        pass


# ------------------------------------------------- the structure holds records
def resolve_context(con, text: str, *, create: bool = True, actor: str = "collection") -> str | None:
    """
    Turn a free-text collection context into a node of the structure.

    "Biomedical Department" typed into the folder connector IS the user naming a
    department. Matching it to an existing node first and only then creating one
    means typing the same words twice does not produce two departments, and
    means a context typed before the structure was built still lands somewhere
    real rather than in a string nobody can navigate.

    Matching is on the normalised name ANYWHERE in the tree, not just at the
    root: a company that already has Biomedical under Clinical Services should
    get that node, not a second one beside it.
    """
    name = (text or "").strip()
    if not name:
        return None
    want = _norm(name)
    for r in con.execute("SELECT id, name FROM org_nodes ORDER BY depth, position"):
        if _norm(r["name"]) == want:
            return r["id"]
    if not create:
        return None
    return add_node(con, name=name, kind="Collection", actor=actor,
                    description=f"Created from a collection context on {_now()[:10]}.")["id"]


# The number a folder was sorted by is not part of its name: "17_Job_Descriptions"
# is filed under "Job Descriptions". Underscores and hyphens are spaces.
_ORDER_PREFIX = re.compile(r"^\s*\d+(?:[._\-\s]+)")


def folder_label(part: str) -> str:
    raw = (part or "").strip()
    cleaned = re.sub(r"\s+", " ", re.sub(r"[_\-]+", " ", _ORDER_PREFIX.sub("", raw))).strip()
    return cleaned or raw


# Joining words stay lower case inside a name: "Head of Department".
_SMALL_WORDS = {"a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"}


def group_label(value: str) -> str:
    """
    The name a node gets from a value in a source's own grouping field.

    Registers are typed by many hands, so "3rd floor room" sits beside
    "3rd Floor Ward" and "Opd -Procedure Room" beside "Opd-12". The node is what
    people read in the structure, so spacing is made consistent and a word typed
    all in lower case is capitalised. Nothing else changes: an acronym is not
    guessed at ("Opd" stays "Opd"), two different values are never merged, and
    the record itself keeps the value exactly as the source sent it.
    """
    s = re.sub(r"\s+", " ", (value or "").strip())
    # A hyphen spaced on one side only is a separator typed carelessly;
    # "Post-Op" and "Opd-12" have no space on either side and are left alone.
    s = re.sub(r"\s+-(?=\S)|(?<=\S)-\s+", " - ", s)
    words = []
    for i, w in enumerate(s.split(" ")):
        if w.islower() and not (i and w in _SMALL_WORDS):
            w = "-".join(p[:1].upper() + p[1:] for p in w.split("-"))
        words.append(w)
    return " ".join(words)


class Remembered:
    """
    The nodes one connection made, remembered by id rather than found again by name.

    Finding them by name on every run meant renaming "Biomedical Equipment" to
    "Biomedical" in the structure made the next sync create a fresh "Biomedical
    Equipment" beside it and move every record back into it: the user's edit
    silently undone, and a duplicate department left behind. An id survives a
    rename and a move. Only a node that has since been deleted is looked up by
    name again — and made again if nothing matches.

    `ids` is what the connection saves in its config for next time.
    """

    def __init__(self, con, saved: dict | None = None):
        self.con = con
        self._saved = dict(saved or {})
        self.ids = dict(self._saved)

    def node(self, key: str, make) -> str | None:
        nid = self.ids.get(key)
        if nid and _row(self.con, nid):
            return nid
        nid = make()
        if nid:
            self.ids[key] = nid
        else:
            self.ids.pop(key, None)
        return nid

    def to_save(self) -> dict:
        """What to keep: nodes deleted since are dropped rather than carried forever."""
        return {k: v for k, v in self.ids.items() if _row(self.con, v)}

    @property
    def changed(self) -> bool:
        return self.to_save() != self._saved


def ensure_path(con, parts: list[str], *, parent_id: str | None = None,
                kind: str | None = None, source: str = "",
                actor: str = "collection") -> str | None:
    """
    Find or create the nested nodes `parts` names, beneath `parent_id`, and
    return the deepest one's id.

    This is what lets ingestion build the structure instead of asking for it:
    a folder tree or an API's department field arrives, and the tree appears.

    Matching is by normalised name under the SAME parent, so a re-sync reuses
    what the last one made, and two departments that each have a "Records"
    subfolder keep two different "Records" nodes. A tree deeper than MAX_DEPTH
    is folded into the deepest allowed level — the records are still filed,
    one level up — rather than refused.
    """
    node = parent_id
    depth = 0
    if node:
        row = _row(con, node)
        depth = int(row["depth"]) + 1 if row else 0
    for raw in parts:
        name = (raw or "").strip()[:MAX_NAME]
        want = _norm(name)
        if not want:
            continue
        if depth >= MAX_DEPTH:
            break
        hit = None
        for r in con.execute(
                "SELECT id, name FROM org_nodes WHERE parent_id IS NOT DISTINCT FROM ?", (node,)):
            if _norm(r["name"]) == want:
                hit = r["id"]
                break
        if hit is None:
            hit = add_node(con, name=name, parent_id=node, kind=kind, actor=actor,
                           description=(f"Created from {source} on {_now()[:10]}." if source
                                        else None))["id"]
        node = hit
        depth += 1
    return node


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def counts(con) -> dict:
    """
    How many records sit under each node, and how many sit nowhere.

    A node's count INCLUDES its descendants — collapsing Finance should not make
    its records appear to vanish — and `own` is kept beside it so a parent whose
    children hold everything can still say so.

    `unfiled` is not an error state and must be shown: records collected before
    the structure existed, or through a connector that was given no context, are
    real records that simply have no home yet. Hiding them would make the
    structure look complete while the corpus disagreed.
    """
    own: dict[str, int] = {}
    # What kind of record sits on each node, and where it came from. Rolled up
    # below exactly like `total`, so a department can say "Equipment 315, from
    # an API" without its records being fetched to find out.
    own_kinds: dict[str, dict[tuple[str, str], int]] = {}
    own_sources: dict[str, dict[str, int]] = {}
    # The source's own status and criticality ride along: a department card can
    # say "4 under maintenance, 15 life support" from the same one query.
    own_status: dict[str, dict[str, int]] = {}
    own_crit: dict[str, dict[str, int]] = {}
    # The same, per kind of record: a complaint's "CRITICAL" priority and an
    # equipment item's "CRITICAL" criticality share a column here, and one
    # count of both would say something neither source said.
    own_signals: dict[str, dict[tuple[str, str, str], int]] = {}
    for r in con.execute(
            "SELECT org_node_id, domain, COALESCE(type, ''), COALESCE(source, ''), "
            "COALESCE(status, ''), COALESCE(criticality, ''), COUNT(*) "
            "FROM company_entities WHERE org_node_id IS NOT NULL "
            "GROUP BY org_node_id, domain, COALESCE(type, ''), COALESCE(source, ''), "
            "COALESCE(status, ''), COALESCE(criticality, '')"):
        nid, n = r[0], int(r[6])
        own[nid] = own.get(nid, 0) + n
        for bucket, key in ((own_kinds, (r[1], r[2])), (own_sources, r[3]),
                            (own_status, r[4]), (own_crit, r[5])):
            b = bucket.setdefault(nid, {})
            b[key] = b.get(key, 0) + n
        for field, value in (("status", r[4]), ("criticality", r[5])):
            if value:
                b = own_signals.setdefault(nid, {})
                b[(r[2], field, value)] = b.get((r[2], field, value), 0) + n
    # How many different things a node holds — 315 records may be 88 kinds of
    # equipment. Distinct names cannot be summed up a tree, so they are unioned.
    own_names: dict[str, set[str]] = {}
    for r in con.execute(
            "SELECT DISTINCT org_node_id, name FROM company_entities WHERE org_node_id IS NOT NULL"):
        own_names.setdefault(r[0], set()).add(" ".join((r[1] or "").lower().split()))

    rows = [dict(r) for r in con.execute("SELECT id, path FROM org_nodes")]
    by_path = {r["path"]: r["id"] for r in rows}
    total: dict[str, int] = {}
    collected: dict[str, list[dict]] = {}
    sources: dict[str, dict[str, int]] = {}
    status: dict[str, dict[str, int]] = {}
    criticality: dict[str, dict[str, int]] = {}
    signals: dict[str, list[dict]] = {}
    distinct_names: dict[str, int] = {}

    def rolled(bucket, members) -> dict:
        out: dict = {}
        for m in members:
            for k, n in bucket.get(m, {}).items():
                out[k] = out.get(k, 0) + n
        return out

    for r in rows:
        members = [r["id"]] + [o["id"] for o in rows       # descendants share the path prefix
                               if o["id"] != r["id"] and o["path"].startswith(r["path"] + "/")]
        total[r["id"]] = sum(own.get(m, 0) for m in members)
        kinds = rolled(own_kinds, members)
        collected[r["id"]] = [{"domain": d, "type": t or None, "n": n}
                              for (d, t), n in sorted(kinds.items(), key=lambda kv: -kv[1])]
        sources[r["id"]] = rolled(own_sources, members)
        # A record with no status is not counted as a status called "".
        status[r["id"]] = {k: n for k, n in rolled(own_status, members).items() if k}
        criticality[r["id"]] = {k: n for k, n in rolled(own_crit, members).items() if k}
        signals[r["id"]] = [{"type": t or None, "field": f, "value": v, "n": n}
                            for (t, f, v), n in sorted(rolled(own_signals, members).items(), key=lambda kv: -kv[1])]
        distinct_names[r["id"]] = len(set().union(*(own_names.get(m, set()) for m in members)))

    unfiled = con.execute(
        "SELECT COUNT(*) FROM company_entities WHERE org_node_id IS NULL").fetchone()[0]
    return {"own": own, "total": total, "unfiled": int(unfiled),
            "filed": sum(own.values()), "paths": by_path,
            "collected": collected, "sources": sources, "status": status,
            "criticality": criticality, "signals": signals, "distinct_names": distinct_names,
            "heads": heads_by_node(con)}


def heads_by_node(con) -> dict[str, list[dict]]:
    """
    Who a source says heads each node: people records filed there that their
    source marks as head (an organisation chart's is_head). Their own words —
    name, designation, whom they report to — and nothing inferred. A head a
    person types into the structure is kept separately, on the node itself.
    """
    out: dict[str, list[dict]] = {}
    for r in con.execute(
            "SELECT org_node_id, name, attrs FROM company_entities "
            "WHERE domain = 'people' AND org_node_id IS NOT NULL"):
        try:
            a = json.loads(r[2] or "{}")
        except ValueError:
            continue
        if a.get("isHead") is True:
            out.setdefault(r[0], []).append({
                "name": r[1], "role": a.get("designation"),
                "reportsTo": a.get("reportsTo"), "reportsToDepartment": a.get("reportsToDepartment"),
                "inferred": bool(a.get("reportingInferred")), "origin": a.get("recordOrigin"),
            })
    return out


def file_under(con, node_id: str | None, entity_ids: list[str], *, actor: str = "user") -> int:
    """Move records into a node — or out of the structure when node_id is None."""
    n = 0
    for eid in entity_ids:
        con.execute("UPDATE company_entities SET org_node_id=?, updated_at=? WHERE id=?",
                    (node_id, _now(), eid))
        n += 1
    _audit(con, node_id or "(unfiled)", "records filed", f"{n} record(s)", actor)
    con.commit()
    return n
