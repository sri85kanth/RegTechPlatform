"""Regulatory Intelligence API (spec §37) — thin read layer over PostgreSQL (company_brain).
Run:  ./.venv/bin/pip install fastapi uvicorn && ./.venv/bin/uvicorn regulatory_ingestion.api:app --port 8787
The frontend consumes the same read models exported as static intel JSON; this
API serves them live for backend deployments."""
import json
import time as _time
from typing import Any

import os
import pathlib

# Load .env before anything reads os.environ, so deployment secrets (the Google
# OAuth client among them) can live in a file that is not the shell history and
# not the repository. Absent python-dotenv or an absent file, real environment
# variables are used exactly as before.
try:
    from dotenv import load_dotenv
    load_dotenv(pathlib.Path(__file__).parent.parent / ".env")
except ImportError:
    pass

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .db import connect
from .api_auth import require

# CORS: localhost only by default. "*" together with credentials is exactly the
# combination that makes an authenticated API exploitable from any page, so the
# allowed origins are explicit and come from the environment at deployment.
CORS_ORIGINS = [o.strip() for o in os.environ.get(
    "CORS_ORIGINS",
    "http://localhost:5180,http://127.0.0.1:5180,http://localhost:5173,http://localhost:3000"
).split(",") if o.strip()]
from . import company_db, change_status

app = FastAPI(title="Regulatory Intelligence API")

# the Vite dev server and any local origin during development
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _init_schemas() -> None:
    """
    Best-effort schema setup.

    These used to run at import time, so a locked database meant the API could
    not start at all — a background indexer could take the whole service down.
    Now they are attempted once, and a failure is logged rather than fatal: the
    tables already exist in any running deployment.
    """
    from . import versions as _versions
    # Cheap read first: if the core tables are already there, skip every write.
    # Otherwise three schema scripts each wait out the busy timeout, and the
    # server takes minutes to start whenever anything else is writing.
    try:
        con = connect()
        present = con.execute(
            """SELECT COUNT(*) FROM information_schema.tables
               WHERE table_schema='public'
                 AND table_name IN ('regulations','company_entities','document_versions','source_checks')"""
        ).fetchone()[0]
        if present >= 4:
            return
    except Exception:
        pass

    for step, fn in (("company", lambda c: company_db.init(c)),
                     ("change_status", lambda c: change_status.init(c)),
                     ("amendments", lambda c: company_db.init_amendments(c)),
                     ("versions", lambda c: _versions.init(c))):
        try:
            fn(connect())
        except Exception as e:                                  # noqa: BLE001
            print(f"[api] schema init '{step}' deferred: {type(e).__name__}: {e}")


_init_schemas()


def _warm_retrieval() -> None:
    """
    Load the embedder and the cross-encoder in the background at startup.

    Both are lazy by design, so the first search after a restart paid for the
    load — measured at 25 seconds through nginx, which reads as a hung request.
    Warming on a daemon thread keeps uvicorn binding immediately: the port is
    open and every non-RAG route serves while the models load. Each worker warms
    its own copy, because the models live in process memory, not shared.

    Failure here is not fatal. On a core-tier install neither package exists and
    /api/rag returns its own 503; nothing else should care.
    """
    def _load():
        try:
            from . import rag
            rag.model().encode(["warm"])
            if getattr(rag, "RERANK", False):
                rag.reranker().predict([("warm", "warm")])
            print("[api] retrieval models warm", flush=True)
        except Exception as e:                                  # noqa: BLE001
            print(f"[api] retrieval warm-up skipped: {type(e).__name__}: {e}", flush=True)

    if os.environ.get("RAG_WARM", "1") not in ("0", "false", "no"):
        import threading
        threading.Thread(target=_load, name="rag-warm", daemon=True).start()


@app.on_event("startup")
def _on_startup() -> None:
    _warm_retrieval()


from .api_regulations import router as regulations_router   # noqa: E402
app.include_router(regulations_router)

from .api_dashboard import router as dashboard_router       # noqa: E402
app.include_router(dashboard_router)

from .api_calendar import router as calendar_router  # noqa: E402
app.include_router(calendar_router)

from .api_compliance import router as compliance_router  # noqa: E402
app.include_router(compliance_router)
from .api_intel import router as intel_router                # noqa: E402
app.include_router(intel_router)
from .api_integrations import router as integrations_router  # noqa: E402
from .api_taxonomy import router as structure_router  # noqa: E402
from .company_lookup import router as company_lookup_router  # noqa: E402

app.include_router(integrations_router)
app.include_router(structure_router)
app.include_router(company_lookup_router)
from .api_rag import router as rag_router                    # noqa: E402
app.include_router(rag_router)
from .api_agent import router as agent_router                # noqa: E402
app.include_router(agent_router)
from .api_actions import router as actions_router            # noqa: E402
app.include_router(actions_router)
from .api_watcher import router as watcher_router            # noqa: E402
app.include_router(watcher_router)
from .api_auth import router as auth_router                  # noqa: E402
app.include_router(auth_router)
from .api_notifications import router as notif_router        # noqa: E402
app.include_router(notif_router)
from .api_accountability import router as acct_router, docs as docs_router  # noqa: E402
app.include_router(acct_router)
app.include_router(docs_router)
from .api_regulation_detail import router as regdetail_router  # noqa: E402
app.include_router(regdetail_router)
from .api_controls import router as controls_router, obl as obligations_router  # noqa: E402
app.include_router(controls_router)
app.include_router(obligations_router)
from .api_penalties import router as penalties_router  # noqa: E402
app.include_router(penalties_router)
from .api_requirements import router as requirements_router  # noqa: E402
app.include_router(requirements_router)
from .api_cascade import router as cascade_router  # noqa: E402
app.include_router(cascade_router)
from .api_reg_upload import router as reg_upload_router  # noqa: E402
app.include_router(reg_upload_router)
from .api_reg_overview import router as reg_overview_router  # noqa: E402
app.include_router(reg_overview_router)
from .api_home import router as home_router  # noqa: E402
app.include_router(home_router)
from .api_remediation import router as remediation_router  # noqa: E402
app.include_router(remediation_router)
from .api_risk import router as risk_router  # noqa: E402
app.include_router(risk_router)
# external auditors: what the hospital shared with each, and the shares themselves
from .api_auditor import router as auditor_router  # noqa: E402
app.include_router(auditor_router)
# document intake: a folder of documents, sorted into the company structure
from .api_doc_intake import router as intake_router  # noqa: E402
app.include_router(intake_router)
# "set up a new company" requests and their approval (main installation only)
from .api_workspaces import router as workspaces_router  # noqa: E402
app.include_router(workspaces_router)
# each company's logo (company_profile.logo)
from .api_company_logo import router as company_logo_router  # noqa: E402
app.include_router(company_logo_router)


def write(q: str, *p) -> None:
    con = company_db.init()
    con.execute(q, p)
    con.commit()


def rows(q, *p):
    con = company_db.init()
    return [dict(r) for r in con.execute(q, p).fetchall()]


# Regulatory endpoints live in api_regulations.py and are mounted as a router
# above. They are intentionally NOT duplicated here.

@app.get("/api/ingestion/status", dependencies=[Depends(require("read"))])
def ingestion_status():
    return {"totals": rows("SELECT ingestion_status, COUNT(*) n FROM regulations GROUP BY 1"),
            "bySource": rows("SELECT regulator_short, ingestion_status, COUNT(*) n FROM regulations GROUP BY 1,2"),
            "recentJobs": rows("SELECT * FROM ingestion_jobs ORDER BY id DESC LIMIT 50")}


# ============================================================
# Company Brain — the half that used to live as seed data in the
# frontend. Read and write, so onboarding survives a refresh.
# ============================================================

@app.get("/api/company/entities", dependencies=[Depends(require("read"))])
def company_entities(domain: str | None = None):
    con = company_db.init()
    items = company_db.entity_rows(con)
    if domain:
        items = [e for e in items if e["domain"] == domain]
    return {"total": len(items), "items": items}


@app.get("/api/company/relationships", dependencies=[Depends(require("read"))])
def company_relationships():
    con = company_db.init()
    return {"items": [dict(r) for r in con.execute("SELECT * FROM entity_relationships")]}


@app.get("/api/company/graph", dependencies=[Depends(require("read"))])
def company_graph():
    """Everything the frontend needs to render the Company Brain in one call."""
    con = company_db.init()
    prof = con.execute("SELECT * FROM company_profile ORDER BY id LIMIT 1").fetchone()
    return {
        "profile": dict(prof) if prof else None,
        "entities": company_db.entity_rows(con),
        "relationships": [dict(r) for r in con.execute("SELECT * FROM entity_relationships")],
        "mappings": [dict(r) for r in con.execute("SELECT * FROM company_mappings")],
    }


def _actor(user) -> str:
    """Who did it, from the session — never a name the client supplies."""
    return ((user or {}).get("email") or (user or {}).get("name") or "api") if isinstance(user, dict) else "api"


@app.post("/api/company/entities")
def create_entities(payload: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    """Bulk insert from the CSV importer or the guided form."""
    entities = payload.get("entities") or []
    links = payload.get("relationships") or []
    source = payload.get("source", "onboarding")
    if not entities and not links:
        raise HTTPException(400, "supply entities, relationships, or both")
    con = company_db.init()
    for e in entities:
        company_db.upsert_entity(con, e, actor=f"{_actor(user)} via {source}")
    for r in links:
        company_db.add_relationship(con, r)
    con.commit()
    return {"created": len(entities), "relationships": len(links)}


@app.patch("/api/company/entities/{eid}")
def update_entity(eid: str, patch: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    con = company_db.init()
    cur = con.execute("SELECT * FROM company_entities WHERE id=?", (eid,)).fetchone()
    if not cur:
        raise HTTPException(404, "entity not found")
    allowed = {"name", "description", "owner_id", "criticality", "lifecycle", "status", "verification"}
    sets = {k: v for k, v in patch.items() if k in allowed}
    if sets:
        con.execute(
            f"UPDATE company_entities SET {', '.join(f'{k}=?' for k in sets)}, updated_at=? WHERE id=?",
            (*sets.values(), company_db.now(), eid),
        )
        action = ("verified" if sets.get("verification") == "Verified"
                  else "owner assigned" if "owner_id" in sets else "entity updated")
        company_db.log(con, eid, action, json.dumps(sets), _actor(user))
        con.commit()
    return {"updated": list(sets)}


@app.delete("/api/company/entities", dependencies=[Depends(require("approve"))])
def clear_company(confirm: str = ""):
    """Wipe company data — used when replacing demo content with real records."""
    if confirm != "yes":
        raise HTTPException(400, "pass ?confirm=yes")
    con = company_db.init()
    for t in ("company_entities", "entity_relationships", "company_mappings"):
        con.execute(f"DELETE FROM {t}")
    company_db.log(con, "-", "company data cleared", "", "api")
    con.commit()
    return {"cleared": True}


@app.get("/api/company/profile", dependencies=[Depends(require("read"))])
def get_profile():
    """
    The company this installation is configured for.

    Existed only as a PUT, so the one place the name was displayed had it typed
    into the sidebar as a literal. A hardcoded company name is wrong the moment
    the profile is edited, and silently wrong for anyone else who deploys this.
    """
    con = company_db.init()
    r = con.execute("SELECT * FROM company_profile ORDER BY id LIMIT 1").fetchone()
    if not r:
        # Not an error: a fresh install has no profile until setup is completed.
        return {"configured": False, "profile": None}
    d = dict(r)
    d.pop("logo", None)           # served on its own (/api/company/logo), not with every profile read
    for k in ("jurisdictions", "sectors", "licences", "derived_from", "public_record"):
        if isinstance(d.get(k), str):
            try:
                d[k] = json.loads(d[k])
            except Exception:
                d[k] = [] if k not in ("derived_from", "public_record") else {}
    return {"configured": bool((d.get("legal_name") or "").strip()), "profile": d}


def _count(v: Any) -> int | None:
    """A non-negative whole number, or None when blank or not a number (beds: 0 means non-bedded)."""
    try:
        n = int(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


@app.put("/api/company/profile", dependencies=[Depends(require("approve"))])
def save_profile(p: dict[str, Any] = Body(...)):
    con = company_db.init()
    con.execute(
        """INSERT INTO company_profile
           (id,legal_name,registration_no,entity_type,incorporated,hq_state,jurisdictions,
            sectors,licences,employees,turnover_cr,customers,listed,handles_personal_data,
            imports_exports,updated_at,source_verified,legal_form,registered_address,lei,
            public_record,beds)
           VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             legal_name=excluded.legal_name, registration_no=excluded.registration_no,
             entity_type=excluded.entity_type, incorporated=excluded.incorporated,
             hq_state=excluded.hq_state, jurisdictions=excluded.jurisdictions,
             sectors=excluded.sectors, licences=excluded.licences, employees=excluded.employees,
             turnover_cr=excluded.turnover_cr, customers=excluded.customers, listed=excluded.listed,
             handles_personal_data=excluded.handles_personal_data,
             imports_exports=excluded.imports_exports, updated_at=excluded.updated_at,
             -- a person opened this profile and saved it; that is the review
             source_verified=1,
             legal_form=excluded.legal_form, registered_address=excluded.registered_address,
             lei=excluded.lei, public_record=excluded.public_record, beds=excluded.beds""",
        (p.get("legalName"), p.get("registrationNo"), p.get("entityType"), p.get("incorporated"),
         p.get("hqState"), json.dumps(p.get("jurisdictions") or []), json.dumps(p.get("sectors") or []),
         json.dumps(p.get("licences") or []), p.get("employees"), p.get("turnoverCr"), p.get("customers"),
         int(bool(p.get("listed"))), int(bool(p.get("handlesPersonalData"))),
         int(bool(p.get("importsExports"))), company_db.now(),
         p.get("legalForm") or None, p.get("registeredAddress") or None, p.get("lei") or None,
         # Which answers came from a public record, and which record: kept so
         # the form can say "from the LEI register, updated 13 Feb 2026" later.
         json.dumps(p["publicRecord"]) if isinstance(p.get("publicRecord"), dict) else None,
         _count(p.get("beds"))),
    )
    company_db.log(con, "profile", "company profile saved", p.get("legalName", ""), "api")
    con.commit()
    return {"saved": True}


@app.post("/api/company/mappings/{mid}/review")
def review_mapping(mid: str, body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    """The human gate — approve, reject or edit a proposed mapping, durably."""
    status = body.get("status")
    if status not in ("Approved", "Rejected", "Needs Review"):
        raise HTTPException(400, "status must be Approved, Rejected or Needs Review")
    con = company_db.init()
    who = _actor(user)            # the session's user, not a client-supplied name
    con.execute(
        "UPDATE company_mappings SET status=?, reviewed_by=?, reviewed_at=?, rationale=? WHERE id=?",
        (status, who, company_db.now(), body.get("rationale", ""), mid),
    )
    company_db.log(con, mid, f"mapping {status.lower()}", body.get("rationale", ""), who)
    con.commit()
    return {"id": mid, "status": status}


@app.get("/api/audit", dependencies=[Depends(require("read"))])
def audit(limit: int = 100):
    con = company_db.init()
    return {"items": [dict(r) for r in con.execute(
        "SELECT * FROM audit_events ORDER BY id DESC LIMIT ?", (limit,))]}


# The first call every page makes, so its latency is the app's perceived
# start-up cost. COUNT(*) over obligations alone measured 2.1 s on this
# deployment, and four of them ran on every poll. The counts describe a corpus
# that changes on an ingestion run, so they are computed once and reused for a
# short window — still real COUNTs, never estimates.
_HEALTH: dict[str, object] = {"at": 0.0, "value": None}
_HEALTH_TTL = 30.0


@app.get("/api/health")
def health():
    now = _time.monotonic()
    cached = _HEALTH["value"]
    if cached is not None and now - float(_HEALTH["at"]) < _HEALTH_TTL:
        return cached
    con = company_db.init()

    def n(t: str) -> int:
        """
        A table this deployment has not created yet counts zero.

        A fresh install has the company tables but not the regulatory ones
        until the first ingest; before this, health answered 500 and the whole
        app read as "Cannot reach the API" on a customer's very first screen.
        """
        try:
            return con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        except Exception:
            try:
                con.rollback()          # a failed statement aborts the transaction
            except Exception:
                pass
            return 0

    value = {
        "ok": True,
        "regulations": n("regulations"),
        "obligations": n("obligations"),
        "companyEntities": n("company_entities"),
        "relationships": n("entity_relationships"),
    }
    _HEALTH.update(at=now, value=value)
    return value


# ============================================================
# Database browser — read-only, for development.
# Lets you inspect every table from /docs without a separate tool.
# NOT for production: it exposes raw tables and has no auth.
# ============================================================

_SAFE = None  # populated on first use: the real table names, to reject anything else


def _tables(con) -> list[str]:
    return [r[0] for r in con.execute(
        """SELECT table_name FROM information_schema.tables
           WHERE table_schema='public' ORDER BY table_name""")]


@app.get("/api/db/tables", dependencies=[Depends(require("administer"))])
def db_tables():
    """Every table, its row count and its columns."""
    con = company_db.init()
    out = []
    for t in _tables(con):
        cols = [dict(cid=r[0], name=r[1], type=r[2], notnull=r[3], pk=r[5])
                for r in con.execute(f"PRAGMA table_info({t})")]
        out.append({
            "table": t,
            "rows": con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0],
            "columns": [c["name"] for c in cols],
            "schema": cols,
        })
    return {"database": "postgresql/company_brain", "tables": out}


@app.get("/api/db/table/{name}", dependencies=[Depends(require("administer"))])
def db_table(name: str, limit: int = 25, offset: int = 0, order: str | None = None):
    """Browse rows of one table. `name` is validated against the real table list."""
    con = company_db.init()
    if name not in _tables(con):
        raise HTTPException(404, f"no such table: {name}")
    total = con.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
    cols = [r[1] for r in con.execute(f"PRAGMA table_info({name})")]
    order_sql = ""
    if order and order.lstrip("-") in cols:
        order_sql = f"ORDER BY {order.lstrip('-')} {'DESC' if order.startswith('-') else 'ASC'}"
    rows = [dict(r) for r in con.execute(
        f"SELECT * FROM {name} {order_sql} LIMIT ? OFFSET ?", (min(limit, 500), offset))]
    return {"table": name, "total": total, "limit": limit, "offset": offset,
            "columns": cols, "rows": rows}


@app.get("/api/db/query", dependencies=[Depends(require("administer"))])
def db_query(sql: str, limit: int = 100):
    """Run a read-only SELECT. Anything that could modify data is rejected."""
    stripped = sql.strip().rstrip(";")
    lowered = stripped.lower()
    if not lowered.startswith(("select", "with")):
        raise HTTPException(400, "only SELECT / WITH queries are allowed")
    banned = ("insert", "update", "delete", "drop", "alter", "create", "attach", "pragma", "replace")
    if any(f" {b} " in f" {lowered} " for b in banned):
        raise HTTPException(400, "read-only: that statement is not allowed")
    con = company_db.init()
    try:
        rows = [dict(r) for r in con.execute(f"SELECT * FROM ({stripped}) LIMIT {min(limit, 500)}")]
    except Exception as e:
        raise HTTPException(400, f"SQL error: {e}")
    return {"sql": stripped, "count": len(rows), "rows": rows}

# which regulations reach each department (What applies to us -> By department)
from .api_dept_applicability import router as dept_applicability_router  # noqa: E402
app.include_router(dept_applicability_router)
