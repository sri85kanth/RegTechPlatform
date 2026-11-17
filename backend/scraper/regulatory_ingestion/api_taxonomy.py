"""
Organisation-structure and taxonomy endpoints.

The structure decides where every uploaded document is filed, so changing it is
an `approve` action, not a `write` one — and every change is already audited by
the taxonomy module itself.

Errors here are the user's own words coming back at them ("'Recruitment'
already exists here"), not stack traces: this is a screen somebody is typing
their company into, and a 500 in the middle of that loses the structure they
were halfway through building.
"""
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from . import taxonomy as T
from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api/structure", tags=["structure"])

READ = Depends(require("read"))
WRITE = Depends(require("approve"))


def _con():
    return T.init(connect())


def _actor(user) -> str:
    return (user or {}).get("email") or (user or {}).get("id") or "user"


def _guard(fn):
    """A ValueError from the module is a message for the person typing."""
    try:
        return fn()
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


# ------------------------------------------------------------------ the tree
@router.get("")
def get_structure(user=READ):
    """
    The structure, with how many records sit under each node.

    Counts travel with the tree rather than in a second call: the navigation
    renders from this, and a tree that arrives before its counts renders a row
    of empty badges that then jump.
    """
    con = _con()
    return {"tree": T.tree(con), "flat": T.flat(con),
            "taxonomies": T.taxonomies(con), "counts": T.counts(con)}


@router.get("/nodes/{node_id}/records")
def records(node_id: str, include_descendants: bool = True, limit: int = 500, user=READ):
    """Every record filed under a node. `node_id` may be the literal "unfiled"."""
    con = _con()
    if node_id == "unfiled":
        rows = con.execute(
            """SELECT * FROM company_entities WHERE org_node_id IS NULL
               ORDER BY domain, name LIMIT ?""", (limit,)).fetchall()
    else:
        node = con.execute("SELECT path FROM org_nodes WHERE id=?", (node_id,)).fetchone()
        if not node:
            raise HTTPException(404, "no such node")
        if include_descendants:
            rows = con.execute(
                """SELECT e.* FROM company_entities e
                     JOIN org_nodes n ON n.id = e.org_node_id
                    WHERE n.id = ? OR n.path LIKE ?
                    ORDER BY e.domain, e.name LIMIT ?""",
                (node_id, node["path"] + "/%", limit)).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM company_entities WHERE org_node_id=? ORDER BY domain, name LIMIT ?",
                (node_id, limit)).fetchall()
    import json as _json
    out = []
    for r in rows:
        d = dict(r)
        d["attrs"] = _json.loads(d.get("attrs") or "{}")
        out.append(d)
    where = ("e.org_node_id IS NULL", ()) if node_id == "unfiled" else (
        ("(n.id = ? OR n.path LIKE ?)", (node_id, node["path"] + "/%")) if include_descendants
        else ("n.id = ?", (node_id,)))
    return {"records": out, "count": len(out), "sources": _sources(con, *where)}


def _sources(con, where: str, params: tuple) -> list[dict]:
    """
    Which connections the records under a node came from — by name, with when
    each last collected — so a department page can say "from the Biomedical
    equipment register, collected today" instead of "from an API".

    Only the connection's label, kind, host or folder name and times leave
    here. Its secret and full configuration never do.
    """
    from . import integrations as I
    import json as _json
    import urllib.parse as _up
    I.init(con)
    counts = {r[0]: int(r[1]) for r in con.execute(
        f"""SELECT ir.integration_id, COUNT(DISTINCT e.id) FROM integration_records ir
              JOIN company_entities e ON e.id = ir.entity_id
              LEFT JOIN org_nodes n ON n.id = e.org_node_id
             WHERE {where} GROUP BY ir.integration_id""", params)}
    out = []
    for iid, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        row = con.execute(
            "SELECT id, connector, label, config, last_sync_at FROM integrations WHERE id=?",
            (iid,)).fetchone()
        if not row:
            continue
        cfg = _json.loads(row["config"] or "{}")
        where_from = (_up.urlsplit(cfg["url"]).netloc if cfg.get("url")
                      else (cfg.get("path") or "").rstrip("/").split("/")[-1])
        # Caveats are the connection owner's own notes on a field ("location:
        # as placed in the source, not verified"). Text only — shown beside the
        # field wherever it appears, so an unverified value never looks settled.
        caveats = {str(k): str(v) for k, v in (cfg.get("field_caveats") or {}).items()
                   if isinstance(v, str) and v.strip()}
        # Each register's own columns and its own name for them, by record type —
        # so its table reads like the source's page. Column names only.
        layouts = {str(t): {"label": str(v.get("label") or ""),
                            "fields": [[str(k), str(h)] for k, h in (v.get("fields") or [])
                                       if isinstance(k, str) and isinstance(h, str)]}
                   for t, v in (cfg.get("layouts") or {}).items() if isinstance(v, dict)}
        out.append({"id": row["id"], "label": row["label"], "connector": row["connector"],
                    "kind": I.BY_ID.get(row["connector"], {}).get("name", row["connector"]),
                    "where": where_from, "lastSyncAt": row["last_sync_at"], "records": n,
                    "caveats": caveats, "layouts": layouts})
    return out


@router.get("/people")
def people(user=READ):
    """
    Everyone the company's sources name, with where each sits and whom they
    report to — what the Company Graph draws its organisation chart from.
    Only what a source shared: an organisation chart feed carries no phone,
    email or employee code, and none is added here.
    """
    import json as _json
    con = _con()
    out = []
    for r in con.execute(
            "SELECT id, name, org_node_id, source_reference, attrs FROM company_entities "
            "WHERE domain = 'people' ORDER BY name"):
        a = _json.loads(r["attrs"] or "{}")
        out.append({
            "id": r["id"], "ref": r["source_reference"], "name": r["name"], "nodeId": r["org_node_id"],
            "designation": a.get("designation"), "department": a.get("department"),
            "branch": a.get("branch"), "isHead": a.get("isHead") is True,
            "reportsToRef": a.get("reportsToId"), "reportsTo": a.get("reportsTo"),
            "reportsToDepartment": a.get("reportsToDepartment"),
            "inferred": bool(a.get("reportingInferred")), "origin": a.get("recordOrigin"),
        })
    return {"people": out, "count": len(out)}


@router.post("/nodes/{node_id}/file")
def file_records(node_id: str, payload: dict[str, Any] = Body(...), user=WRITE):
    """Move records into a node, or out of the structure with node_id "unfiled"."""
    ids = payload.get("ids") or []
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise HTTPException(400, "ids must be a list of entity ids")
    con = _con()
    target = None if node_id == "unfiled" else node_id
    if target and not con.execute("SELECT 1 FROM org_nodes WHERE id=?", (target,)).fetchone():
        raise HTTPException(404, "no such node")
    return {"moved": T.file_under(con, target, ids, actor=_actor(user))}


@router.post("/nodes")
def create_node(payload: dict[str, Any] = Body(...), user=WRITE):
    con = _con()
    return _guard(lambda: T.add_node(
        con, name=payload.get("name", ""), parent_id=payload.get("parentId"),
        kind=payload.get("kind"), description=payload.get("description"),
        head_name=payload.get("headName"), head_role=payload.get("headRole"),
        actor=_actor(user)))


@router.patch("/nodes/{node_id}")
def edit_node(node_id: str, payload: dict[str, Any] = Body(...), user=WRITE):
    con = _con()
    out = None
    if "name" in payload:
        out = _guard(lambda: T.rename_node(con, node_id, payload["name"], actor=_actor(user)))
    if any(k in payload for k in ("kind", "description", "headName", "headRole")):
        # A head sent as null or "" is cleared; a head not sent is left alone.
        head = lambda k: (payload.get(k) or "") if k in payload else None  # noqa: E731
        out = _guard(lambda: T.update_node(
            con, node_id, kind=payload.get("kind"), description=payload.get("description"),
            head_name=head("headName"), head_role=head("headRole"), actor=_actor(user)))
    if out is None:
        raise HTTPException(400, "nothing to change — send name, kind, description or head")
    return out


@router.post("/nodes/{node_id}/move")
def move(node_id: str, payload: dict[str, Any] = Body(...), user=WRITE):
    con = _con()
    return _guard(lambda: T.move_node(
        con, node_id, payload.get("parentId"), position=payload.get("position"),
        actor=_actor(user)))


@router.post("/reorder")
def reorder(payload: dict[str, Any] = Body(...), user=WRITE):
    ids = payload.get("ids") or []
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise HTTPException(400, "ids must be a list of node ids")
    con = _con()
    _guard(lambda: T.reorder(con, payload.get("parentId"), ids, actor=_actor(user)))
    return {"ok": True, "tree": T.tree(con)}


@router.get("/nodes/{node_id}/impact")
def delete_impact(node_id: str, user=READ):
    """What a delete would take with it — asked BEFORE the confirm dialog, so
    "this also removes 3 subcategories" is on the button the user presses."""
    con = _con()
    return {"descendants": T.subtree_count(con, node_id)}


@router.delete("/nodes/{node_id}")
def remove_node(node_id: str, user=WRITE):
    con = _con()
    return _guard(lambda: T.delete_node(con, node_id, actor=_actor(user)))


# ---------------------------------------------------------------- taxonomies
@router.post("/taxonomies/seed")
def seed(user=WRITE):
    """Install the default vocabulary. Existing taxonomies are left untouched."""
    con = _con()
    return T.seed_taxonomies(con)


@router.post("/taxonomies/{taxonomy_id}/terms")
def create_term(taxonomy_id: str, payload: dict[str, Any] = Body(...), user=WRITE):
    con = _con()
    return _guard(lambda: T.add_term(
        con, taxonomy_id, payload.get("name", ""), payload.get("description"),
        actor=_actor(user)))


@router.delete("/taxonomies/terms/{term_id}")
def remove_term(term_id: str, user=WRITE):
    con = _con()
    T.delete_term(con, term_id, actor=_actor(user))
    return {"ok": True}
