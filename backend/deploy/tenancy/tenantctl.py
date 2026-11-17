#!/usr/bin/env python3
"""
Add, check and remove company workspaces.

    tenantctl.py setup-routing <nginx site file>...   once: one address for every company
    tenantctl.py create <slug> "<Company name>" [--sector <sector>]
    tenantctl.py process           create the companies an admin added (run by the timer)
    tenantctl.py routes            rewrite the nginx company map from the env files
    tenantctl.py check  <slug>
    tenantctl.py sync   <slug>        add company tables/columns new code introduced
    tenantctl.py list
    tenantctl.py run    <slug> <script.py> [args]   a scraper script, as that company
    tenantctl.py remove <slug> --yes  delete the workspace and ALL its data

Run as root on the server. Database steps re-run this file as the postgres
user (peer auth), so no database password exists anywhere.

WHAT A WORKSPACE IS (see scraper/regulatory_ingestion/tenancy.py)
----------------------------------------------------------------
  database   schema co_<slug> in company_brain and company_brain_rag, holding
             the company tables; the regulation library stays shared in public
  role       cb_<slug>: owns its schema, search_path co_<slug>,public, granted
             the library and nothing of any other company's tables
  OS user    cb_<slug>: runs the API, owns /srv/company-brain/companies/<slug>
  service    company-brain@<slug> on its own port, env in
             /etc/company-brain/companies/<slug>.env
  web        none of its own: the same address and sign-in as the main
             installation. The browser names the company (X-Company), nginx
             checks the session with the main API (/api/auth/gate) and sends the
             request to this port (conf.d map written by routes()).

Who may work in it is kept on the main installation (workspace_members; an
admin of the home company is admin in every company).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import pwd
import re
import secrets
import subprocess
import sys
from pathlib import Path

APP = Path(os.environ.get("COMPANY_BRAIN_ROOT", "/srv/company-brain"))
sys.path.insert(0, str(APP / "scraper"))
from regulatory_ingestion import tenancy as T  # noqa: E402

PY = APP / ".venv" / "bin" / "python"
ENV_DIR = Path("/etc/company-brain/companies")
MAIN_ENV = Path("/etc/company-brain/env")
DATA = APP / "companies"
UNIT = "company-brain@{}.service"
PORT_BASE = 8800
MAIN_DB, RAG_DB = "company_brain", "company_brain_rag"
# keys a workspace must not inherit from the first company's env (it shares the
# address, so APP_BASE_URL and CORS_ORIGINS are inherited)
OWN_KEYS = {"COMPANY_BRAIN_DSN", "RAG_DSN", "CONFIG_ENCRYPTION_KEY"}
MAIN_PORT = 8787
MAP_FILE = Path("/etc/nginx/conf.d/company-brain-companies.conf")
SNIPPET = Path("/etc/nginx/snippets/company-brain-companies.conf")


def sh(*cmd: str, check: bool = True, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(list(cmd), check=check, text=True, **kw)


def as_postgres(*args: str) -> str:
    """Run this file's database half as the postgres OS user and return its output."""
    out = sh("runuser", "-u", "postgres", "--", str(PY), "-I", str(Path(__file__).resolve()), "_db", *args,
             capture_output=True, cwd="/tmp", check=False)
    if out.returncode:
        sys.exit(f"database step failed:\n{out.stderr.strip() or out.stdout.strip()}")
    return out.stdout


# =========================================================================== #
# database half — runs as postgres                                            #
# =========================================================================== #
def _pg(db: str):
    import psycopg
    return psycopg.connect(f"dbname={db}", autocommit=False)


def _ident(s: str) -> str:
    return '"' + s.replace('"', '""') + '"'


def _rows(con, q: str, *a):
    with con.cursor() as c:
        c.execute(q, a)
        return c.fetchall()


def _tables(con, schema: str) -> set[str]:
    return {r[0] for r in _rows(con, "SELECT tablename FROM pg_tables WHERE schemaname=%s", schema)}


def _clone_table(cur, con, sch: str, t: str) -> None:
    """An empty copy of public.t in the company schema, with its own sequences."""
    cur.execute(f"CREATE TABLE {sch}.{_ident(t)} (LIKE public.{_ident(t)} INCLUDING ALL)")
    # LIKE copies a serial default as nextval('public.<seq>'): give the copy its own sequence
    for col, dflt in _rows(con, """SELECT column_name, column_default FROM information_schema.columns
                                   WHERE table_schema=%s AND table_name=%s AND column_default LIKE 'nextval(%%'""", sch, t):
        seq = f"{t}_{col}_seq"[:63]
        cur.execute(f"CREATE SEQUENCE IF NOT EXISTS {sch}.{_ident(seq)} OWNED BY {sch}.{_ident(t)}.{_ident(col)}")
        cur.execute(f"ALTER TABLE {sch}.{_ident(t)} ALTER COLUMN {_ident(col)} SET DEFAULT nextval('{sch}.{seq}'::regclass)")


def _foreign_keys(con, cur, sch: str, only: set[str] | None = None) -> None:
    """Recreate public's foreign keys from company tables, pointing at the company copy or the library."""
    fks = _rows(con, """
        SELECT c.conname, src.relname, dst.relname, pg_get_constraintdef(c.oid)
          FROM pg_constraint c
          JOIN pg_class src ON src.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = src.relnamespace
          JOIN pg_class dst ON dst.oid = c.confrelid
         WHERE c.contype = 'f' AND ns.nspname = 'public'""")
    have = {r[0] for r in _rows(con, """SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
                                         WHERE n.nspname=%s AND contype='f'""", sch)}
    for name, src, dst, ddl in fks:
        if src not in T.COMPANY_TABLES or name in have or (only and src not in only):
            continue
        target = f"{sch}.{_ident(dst)}" if dst in T.COMPANY_TABLES else f"public.{_ident(dst)}"
        # pg_get_constraintdef names the target unqualified (public is on the path): requalify it
        head, _, rest = ddl.partition(" REFERENCES ")
        rest = rest.split("(", 1)
        cur.execute(f"ALTER TABLE {sch}.{_ident(src)} ADD CONSTRAINT {_ident(name)} {head} REFERENCES {target}({rest[1]}")


def _overlay(con, cur, sch: str, role: str) -> None:
    """regulation_state + a `regulations` view that shows this company's derived values."""
    for table, own in T.OVERLAY.items():
        cols = _rows(con, """SELECT column_name, format_type(a.atttypid, a.atttypmod), pg_get_expr(d.adbin, d.adrelid)
                               FROM information_schema.columns ic
                               JOIN pg_attribute a ON a.attrelid = ('public.' || %s)::regclass AND a.attname = ic.column_name
                               LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                              WHERE ic.table_schema='public' AND ic.table_name=%s ORDER BY ic.ordinal_position""", table, table)
        names = [c[0] for c in cols]
        typ = {c[0]: c[1] for c in cols}
        shared = [c for c in names if c not in own]
        state = f"{table.rstrip('s')}_state"                           # regulations -> regulation_state
        key = f"{table.rstrip('s')}_id"
        cur.execute(f"""CREATE TABLE {sch}.{state} ({key} text PRIMARY KEY REFERENCES public.{table}(id) ON DELETE CASCADE,
                        {', '.join(f'{_ident(c)} {typ[c]}' for c in own)})""")
        sel = ", ".join(f"s.{_ident(c)}" if c in own else f"r.{_ident(c)}" for c in names)
        cur.execute(f"CREATE VIEW {sch}.{table} AS SELECT {sel} FROM public.{table} r LEFT JOIN {sch}.{state} s ON s.{key} = r.id")
        for c, _, dflt in cols:                                         # inserts through the view keep the defaults
            if dflt:
                cur.execute(f"ALTER VIEW {sch}.{table} ALTER COLUMN {_ident(c)} SET DEFAULT {dflt}")
        newv = lambda cs: ", ".join(f"NEW.{_ident(c)}" for c in cs)    # noqa: E731
        cur.execute(f"""
CREATE FUNCTION {sch}.{table}_write() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.{table} WHERE id = OLD.id;
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.{table} ({', '.join(_ident(c) for c in shared)}) VALUES ({newv(shared)});
  ELSIF ROW({newv(shared)}) IS DISTINCT FROM ROW({', '.join(f'OLD.{_ident(c)}' for c in shared)}) THEN
    UPDATE public.{table} SET ({', '.join(_ident(c) for c in shared)}) = ROW({newv(shared)}) WHERE id = OLD.id;
  END IF;
  INSERT INTO {sch}.{state} ({key}, {', '.join(_ident(c) for c in own)}) VALUES (NEW.id, {newv(own)})
    ON CONFLICT ({key}) DO UPDATE SET {', '.join(f'{_ident(c)} = EXCLUDED.{_ident(c)}' for c in own)};
  RETURN NEW;
END $f$""")
        cur.execute(f"CREATE TRIGGER {table}_write INSTEAD OF INSERT OR UPDATE OR DELETE ON {sch}.{table} "
                    f"FOR EACH ROW EXECUTE FUNCTION {sch}.{table}_write()")


def _views(con, cur, sch: str) -> None:
    """Company views, rebuilt so their table names bind to the company's own tables."""
    for v in T.COMPANY_VIEWS:
        d = _rows(con, "SELECT pg_get_viewdef(('public.' || %s)::regclass, true)", v)
        cur.execute(f"SET LOCAL search_path = {sch}, public")
        cur.execute(f"CREATE VIEW {sch}.{_ident(v)} AS {d[0][0]}")
        cur.execute("SET LOCAL search_path = public")


def _grant_library(con, cur, role: str, sch: str, rag: bool) -> None:
    """Exactly the listed library tables and their sequences; nothing unclassified, nothing of a company's."""
    cur.execute(f"GRANT USAGE ON SCHEMA public TO {role}")
    library = set(T.RAG_LIBRARY_TABLES if rag else T.LIBRARY_TABLES)
    for t in sorted(_tables(con, "public") & library):
        cur.execute(f"GRANT SELECT, INSERT, UPDATE, REFERENCES ON public.{_ident(t)} TO {role}")
    for (seq, owner) in _rows(con, """
            SELECT s.relname, t.relname FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace
              LEFT JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
              LEFT JOIN pg_class t ON t.oid = d.refobjid
             WHERE s.relkind = 'S' AND n.nspname = 'public'"""):
        if owner is None or owner in library or (rag and owner == "chunks"):
            cur.execute(f"GRANT USAGE, SELECT ON SEQUENCE public.{_ident(seq)} TO {role}")
    # who may work in this company; the view shows each role only its own members
    if not rag and _rows(con, "SELECT to_regclass('public.company_members')")[0][0]:
        cur.execute(f"GRANT SELECT ON public.company_members TO {role}")


def _rag(con, cur, sch: str, role: str) -> None:
    """Company passages in the company schema; the regulatory corpus read from the shared table."""
    _clone_table(cur, con, sch, "chunks")
    cur.execute(f"ALTER TABLE {sch}.chunks RENAME TO company_chunks")
    # ids come from the shared sequence: the chunks view unions both tables and
    # look-ups by id (rag.py) must never match a company passage and a library one
    cur.execute(f"ALTER TABLE {sch}.company_chunks ALTER COLUMN id SET DEFAULT nextval('public.chunks_id_seq'::regclass)")
    cur.execute(f"DROP SEQUENCE {sch}.chunks_id_seq")
    cols = [r[0] for r in _rows(con, """SELECT column_name FROM information_schema.columns
                                         WHERE table_schema='public' AND table_name='chunks' ORDER BY ordinal_position""")]
    cl = ", ".join(_ident(c) for c in cols)
    cur.execute(f"""CREATE VIEW {sch}.chunks AS
        SELECT {cl} FROM public.chunks WHERE corpus IS DISTINCT FROM '{T.RAG_COMPANY_CORPUS}'
        UNION ALL SELECT {cl} FROM {sch}.company_chunks""")
    cur.execute(f"ALTER VIEW {sch}.chunks ALTER COLUMN id SET DEFAULT nextval('public.chunks_id_seq'::regclass)")
    cur.execute(f"ALTER VIEW {sch}.chunks ALTER COLUMN indexed_at SET DEFAULT now()")
    newv = ", ".join(f"NEW.{_ident(c)}" for c in cols)
    sets = ", ".join(f"{_ident(c)} = NEW.{_ident(c)}" for c in cols if c != "id")
    cur.execute(f"""
CREATE FUNCTION {sch}.chunks_write() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM {sch}.company_chunks WHERE id = OLD.id;
    IF NOT FOUND AND OLD.source_table = 'upload' THEN DELETE FROM public.chunks WHERE id = OLD.id; END IF;
    RETURN OLD;
  END IF;
  IF NEW.corpus = '{T.RAG_COMPANY_CORPUS}' THEN
    IF TG_OP = 'INSERT' THEN INSERT INTO {sch}.company_chunks ({cl}) VALUES ({newv});
    ELSE UPDATE {sch}.company_chunks SET {sets} WHERE id = OLD.id; END IF;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.chunks ({cl}) VALUES ({newv});   -- an uploaded regulation joins the shared library
  ELSE
    UPDATE public.chunks SET {sets} WHERE id = OLD.id;
  END IF;
  RETURN NEW;
END $f$""")
    cur.execute(f"CREATE TRIGGER chunks_write INSTEAD OF INSERT OR UPDATE OR DELETE ON {sch}.chunks "
                f"FOR EACH ROW EXECUTE FUNCTION {sch}.chunks_write()")
    # the shared table: read it, add regulation uploads, and remove only upload passages (trigger above)
    cur.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON public.chunks TO {role}")


def _owned_by(cur, con, sch: str, role: str) -> None:
    cur.execute(f"ALTER SCHEMA {sch} OWNER TO {role}")
    for (t,) in _rows(con, "SELECT tablename FROM pg_tables WHERE schemaname=%s", sch):
        cur.execute(f"ALTER TABLE {sch}.{_ident(t)} OWNER TO {role}")
    for (v,) in _rows(con, "SELECT viewname FROM pg_views WHERE schemaname=%s", sch):
        cur.execute(f"ALTER VIEW {sch}.{_ident(v)} OWNER TO {role}")
    # a sequence owned by a column follows its table; only free-standing ones need moving
    for (s,) in _rows(con, """SELECT s.relname FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace
                               WHERE s.relkind = 'S' AND n.nspname = %s AND NOT EXISTS (
                                 SELECT 1 FROM pg_depend d WHERE d.objid = s.oid AND d.deptype IN ('a', 'i'))""", sch):
        cur.execute(f"ALTER SEQUENCE {sch}.{_ident(s)} OWNER TO {role}")
    for (f,) in _rows(con, """SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                               WHERE n.nspname=%s""", sch):
        cur.execute(f"ALTER FUNCTION {sch}.{_ident(f)}() OWNER TO {role}")


def db_create(slug: str, name: str, sector: str = "") -> None:
    sch, role = T.schema_of(slug), T.role_of(slug)
    con = _pg(MAIN_DB)
    with con.cursor() as cur:
        if not _rows(con, "SELECT 1 FROM pg_roles WHERE rolname=%s", role):
            cur.execute(f"CREATE ROLE {role} LOGIN")
        if _rows(con, "SELECT 1 FROM pg_namespace WHERE nspname=%s", sch):
            sys.exit(f"{sch} already exists in {MAIN_DB}")
        cur.execute(f"CREATE SCHEMA {sch}")
        public = _tables(con, "public")
        for t in T.COMPANY_TABLES:
            if t in public:
                _clone_table(cur, con, sch, t)
        _foreign_keys(con, cur, sch)
        _overlay(con, cur, sch, role)
        _views(con, cur, sch)
        _grant_library(con, cur, role, sch, rag=False)
        _owned_by(cur, con, sch, role)
        cur.execute(f"ALTER ROLE {role} SET search_path = {sch}, public")
        # sectors as the profile stores them: a JSON list of the library's sector names
        cur.execute(f"INSERT INTO {sch}.company_profile (legal_name, sectors, updated_at) VALUES (%s, %s, now()::text)",
                    (name, json.dumps([sector]) if sector and sector != "Other" else None))
    con.commit()
    con = _pg(RAG_DB)
    with con.cursor() as cur:
        cur.execute(f"CREATE SCHEMA {sch}")
        _rag(con, cur, sch, role)
        _grant_library(con, cur, role, sch, rag=True)
        _owned_by(cur, con, sch, role)
    con.commit()
    print(json.dumps({"schema": sch, "role": role}))


def db_sync(slug: str) -> None:
    """Add company tables, columns and keys that code added to public after the workspace was made."""
    sch, role = T.schema_of(slug), T.role_of(slug)
    con = _pg(MAIN_DB)
    added = []
    with con.cursor() as cur:
        mine, public = _tables(con, sch), _tables(con, "public")
        new = [t for t in T.COMPANY_TABLES if t in public and t not in mine]
        for t in new:
            _clone_table(cur, con, sch, t)
            added.append(t)
        for t in T.COMPANY_TABLES:
            if t not in public or t in new:
                continue
            want = _rows(con, """SELECT column_name, format_type(a.atttypid, a.atttypmod) FROM information_schema.columns ic
                                  JOIN pg_attribute a ON a.attrelid = ('public.' || %s)::regclass AND a.attname = ic.column_name
                                 WHERE ic.table_schema='public' AND ic.table_name=%s""", t, t)
            have = {r[0] for r in _rows(con, "SELECT column_name FROM information_schema.columns WHERE table_schema=%s AND table_name=%s", sch, t)}
            for col, typ in want:
                if col not in have:
                    cur.execute(f"ALTER TABLE {sch}.{_ident(t)} ADD COLUMN {_ident(col)} {typ}")
                    added.append(f"{t}.{col}")
        _foreign_keys(con, cur, sch, only=set(new) or None)
        _grant_library(con, cur, role, sch, rag=False)                 # library tables added since
        _owned_by(cur, con, sch, role)
    con.commit()
    print(json.dumps({"added": added}))


def db_check(slug: str) -> None:
    """What a workspace is missing, and proof that it cannot read another company's tables."""
    sch, role = T.schema_of(slug), T.role_of(slug)
    con = _pg(MAIN_DB)
    mine, public = _tables(con, sch), _tables(con, "public")
    out = {
        "missing_company_tables": [t for t in T.COMPANY_TABLES if t in public and t not in mine],
        # a library name inside the company schema would hide the shared table
        "shadowing_library": sorted(t for t in mine if t in public and t not in T.COMPANY_TABLES and t != "regulation_state"),
        "unlisted_in_schema": sorted(t for t in mine if t not in T.COMPANY_TABLES and t not in public and t != "regulation_state"),
        # neither company nor library: refused to every workspace until someone classifies it in tenancy.py
        "unclassified_public_tables": sorted(public - set(T.COMPANY_TABLES) - set(T.LIBRARY_TABLES) - set(T.PLATFORM_TABLES)),
    }
    leaks = []
    with con.cursor() as cur:
        cur.execute(f"SET ROLE {role}")
        for t in ("company_entities", "users", "gap_assessments"):
            try:
                cur.execute(f"SELECT 1 FROM public.{t} LIMIT 1")
                leaks.append(t)
            except Exception:
                con.rollback()
                cur.execute(f"SET ROLE {role}")
    con.rollback()
    out["role_search_path"] = [r[0] for r in _rows(con, """SELECT unnest(s.setconfig) FROM pg_db_role_setting s
                                                          JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = %s""", role)]
    out["readable_first_company_tables"] = leaks                        # must be empty
    rcon = _pg(RAG_DB)
    with rcon.cursor() as cur:
        cur.execute(f"SET ROLE {role}")
        cur.execute(f"SET search_path = {sch}, public")
        cur.execute("SELECT count(*) FILTER (WHERE corpus = %s), count(*) FROM chunks", (T.RAG_COMPANY_CORPUS,))
        own, total = cur.fetchone()
    rcon.rollback()
    out["rag_company_chunks_visible"], out["rag_chunks_visible"] = own, total
    print(json.dumps(out))


def db_remove(slug: str) -> None:
    sch, role = T.schema_of(slug), T.role_of(slug)
    for db in (RAG_DB, MAIN_DB):
        con = _pg(db)
        with con.cursor() as cur:
            cur.execute(f"DROP SCHEMA IF EXISTS {sch} CASCADE")
            if _rows(con, "SELECT 1 FROM pg_roles WHERE rolname=%s", role):
                cur.execute(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {role}")
                cur.execute(f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {role}")
                cur.execute(f"REVOKE ALL ON SCHEMA public FROM {role}")
        con.commit()
    con = _pg(MAIN_DB)
    with con.cursor() as cur:
        cur.execute(f"DROP ROLE IF EXISTS {role}")
        # off the companies list and out of everybody's switcher; the short name is free again
        if _rows(con, "SELECT to_regclass('public.workspace_requests')")[0][0]:
            cur.execute("""UPDATE workspace_requests SET status = 'REMOVED', message = 'Removed', finished_at = now()::text
                            WHERE slug = %s AND status NOT IN ('DECLINED', 'FAILED', 'REMOVED')""", (slug,))
        if _rows(con, "SELECT to_regclass('public.workspace_members')")[0][0]:
            cur.execute("DELETE FROM workspace_members WHERE slug = %s", (slug,))
    con.commit()
    print(json.dumps({"removed": sch}))


def db_claim() -> None:
    """Take the oldest approved request (api_workspaces.py) and mark it CREATING; print it, or null."""
    con = _pg(MAIN_DB)
    if not _rows(con, "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='workspace_requests'"):
        print("null")
        return
    r = _rows(con, """UPDATE workspace_requests SET status = 'CREATING', message = 'Creating the workspace…'
                       WHERE id = (SELECT id FROM workspace_requests WHERE status = 'APPROVED'
                                    ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
                   RETURNING id, slug, company_name, coalesce(sector, '')""")
    con.commit()
    print(json.dumps(dict(zip(("id", "slug", "name", "sector"), r[0])) if r else None))


def db_claim_delete() -> None:
    """Take the oldest company an admin asked to delete (api_workspaces.py); print it, or null."""
    con = _pg(MAIN_DB)
    if not _rows(con, "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='workspace_requests'"):
        print("null")
        return
    r = _rows(con, """UPDATE workspace_requests SET status = 'REMOVING', message = 'Deleting the company and its data…'
                       WHERE id = (SELECT id FROM workspace_requests WHERE status = 'DELETING'
                                    ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
                   RETURNING id, slug""")
    con.commit()
    print(json.dumps(dict(zip(("id", "slug"), r[0])) if r else None))


def db_finish(rid: str, status: str, url: str, code: str, message: str) -> None:
    con = _pg(MAIN_DB)
    with con.cursor() as cur:
        cur.execute("""UPDATE workspace_requests SET status = %s, url = nullif(%s, ''), setup_code = nullif(%s, ''),
                              message = %s, finished_at = now()::text WHERE id = %s""", (status, url, code, message, int(rid)))
    con.commit()


def db_joined() -> None:
    """Forget a setup code once its workspace has an admin: the code has done its one job."""
    con = _pg(MAIN_DB)
    if not _rows(con, "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='workspace_requests'"):
        return
    with con.cursor() as cur:
        for rid, slug in _rows(con, "SELECT id, slug FROM workspace_requests WHERE status='READY' AND setup_code IS NOT NULL"):
            sch = T.schema_of(slug)
            if _rows(con, "SELECT 1 FROM pg_namespace WHERE nspname=%s", sch) and \
               _rows(con, f"SELECT count(*) FROM {sch}.users")[0][0] > 0:
                cur.execute("UPDATE workspace_requests SET setup_code = NULL, message = 'The admin has signed up.' "
                            "WHERE id = %s", (rid,))
    con.commit()


def db_list() -> None:
    con = _pg(MAIN_DB)
    out = []
    for (sch,) in _rows(con, "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'co\\_%%' ORDER BY 1"):
        name = _rows(con, f"SELECT legal_name FROM {sch}.company_profile ORDER BY id LIMIT 1")
        users = _rows(con, f"SELECT count(*) FROM {sch}.users")
        out.append({"slug": sch[3:], "name": name[0][0] if name else "", "users": users[0][0]})
    print(json.dumps(out))


# =========================================================================== #
# system half — runs as root                                                  #
# =========================================================================== #
def _env_file(slug: str) -> Path:
    return ENV_DIR / f"{slug}.env"


def _ports_in_use() -> set[int]:
    used = set()
    for f in ENV_DIR.glob("*.env"):
        for line in f.read_text().splitlines():
            if line.startswith("CB_PORT="):
                used.add(int(line.split("=", 1)[1]))
    return used


def _port_free(port: int) -> bool:
    """Nothing listens there yet — the server is shared, so env files are not the only claimants."""
    import socket
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _inherited_env() -> list[str]:
    keep = []
    for line in MAIN_ENV.read_text().splitlines():
        k = line.split("=", 1)[0].strip()
        if line.strip() and not line.lstrip().startswith("#") and "=" in line and k not in OWN_KEYS:
            keep.append(line)
    return keep


def create(slug: str, name: str, sector: str = "") -> dict:
    if os.geteuid() != 0:
        sys.exit("run as root")
    if not T.valid_slug(slug):
        sys.exit("slug: 2-24 lowercase letters or digits, starting with a letter")
    if _env_file(slug).exists():
        sys.exit(f"{slug} already exists ({_env_file(slug)})")
    user, home = T.role_of(slug), DATA / slug
    taken = _ports_in_use()
    port = next(p for p in range(PORT_BASE, PORT_BASE + 500) if p not in taken and _port_free(p))

    try:
        pwd.getpwnam(user)
    except KeyError:
        sh("useradd", "--system", "--home-dir", str(home), "--no-create-home", "--shell", "/usr/sbin/nologin", user)
    for sub in ("uploads", "reg-uploads", "auditor_files"):
        (home / sub).mkdir(parents=True, exist_ok=True)
    sh("chown", "-R", f"{user}:{user}", str(home))
    sh("chmod", "750", str(home))

    as_postgres("create", slug, name, sector)

    ENV_DIR.mkdir(parents=True, exist_ok=True)
    lines = _inherited_env() + [
        f"# workspace {slug} — {name}",
        "COMPANY_BRAIN_DSN=postgresql:///company_brain",
        "RAG_DSN=postgresql:///company_brain_rag",
        f"CB_TENANT={slug}",
        f"CB_PORT={port}",
        f"CB_UPLOADS_DIR={home / 'uploads'}",
        f"CB_REG_UPLOADS_DIR={home / 'reg-uploads'}",
        f"AUDITOR_FILES_DIR={home / 'auditor_files'}",
        f"CONFIG_ENCRYPTION_KEY={base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()}",
        f"HF_HOME={APP / '.cache' / 'huggingface'}",
        "HF_HUB_OFFLINE=1",
    ]
    f = _env_file(slug)
    f.write_text("\n".join(lines) + "\n")
    os.chmod(f, 0o640)
    sh("chown", f"root:{user}", str(f))

    sh("systemctl", "daemon-reload")
    sh("systemctl", "enable", "--now", UNIT.format(slug))
    routes()
    # READY must mean it answers: the browser saves the new company's profile straight away
    if not _healthy(port):
        sys.exit(f"its API did not start within {HEALTH_WAIT}s — see journalctl -u {UNIT.format(slug)}")
    return {"slug": slug, "name": name, "port": port}


HEALTH_WAIT = 180


def _healthy(port: int) -> bool:
    import time
    import urllib.request
    until = time.monotonic() + HEALTH_WAIT
    while time.monotonic() < until:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as r:
                if r.status == 200:
                    return True
        except Exception:                                                # noqa: BLE001 — still starting
            pass
        time.sleep(2)
    return False


def process() -> None:
    """
    Create the companies an admin added, and delete the ones an admin asked to
    delete (api_workspaces.py). Run by company-brain-workspaces.timer: one
    company per pass, so a failure in one never holds up the next.
    """
    if os.geteuid() != 0:
        sys.exit("run as root")
    as_postgres("joined")
    while True:
        req = json.loads(as_postgres("claim_delete") or "null")
        if not req:
            break
        try:
            remove(req["slug"])                                         # marks the row REMOVED
        except SystemExit as e:
            as_postgres("finish", str(req["id"]), "FAILED", "", "", f"Could not delete the company: {e}")
    while True:
        req = json.loads(as_postgres("claim") or "null")
        if not req:
            return
        rid, slug = str(req["id"]), req["slug"]
        try:
            create(slug, req["name"], req["sector"])
        except SystemExit as e:                                         # create() and routes() exit with the reason
            as_postgres("finish", rid, "FAILED", "", "", f"Could not create the company: {e}")
            continue
        as_postgres("finish", rid, "READY", "", "", "Ready. It is in the company switcher.")
        print(json.dumps({"ready": slug}))


def _nginx_swap(files: dict[Path, str]) -> None:
    """Write nginx files, test, reload; put the old ones back when nginx refuses them."""
    old = {f: (f.read_text() if f.exists() else None) for f in files}
    for f, text in files.items():
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
    t = sh("nginx", "-t", check=False, capture_output=True)
    if t.returncode:
        for f, text in old.items():
            if text is None:
                f.unlink(missing_ok=True)
            else:
                f.write_text(text)
        sys.exit("nginx refused the change: " + t.stderr.strip()[-300:])
    sh("systemctl", "reload", "nginx")


def routes() -> None:
    """The X-Company -> API port map. An unknown company goes nowhere (port 9), never to the main API."""
    lines = ["# written by deploy/tenancy/tenantctl.py — one line per company", "map $http_x_company $cb_company_api {",
             "    default 127.0.0.1:9;"]
    for f in sorted(ENV_DIR.glob("*.env")) if ENV_DIR.exists() else []:
        port = next((ln.split("=", 1)[1].strip() for ln in f.read_text().splitlines() if ln.startswith("CB_PORT=")), "")
        if T.valid_slug(f.stem) and port.isdigit():
            lines.append(f"    {f.stem} 127.0.0.1:{port};")
    text = "\n".join(lines + ["}", ""])
    if not MAP_FILE.exists() or MAP_FILE.read_text() != text:
        _nginx_swap({MAP_FILE: text})


def _env_value(path: Path, key: str) -> str:
    for ln in path.read_text().splitlines() if path.exists() else []:
        if ln.startswith(key + "="):
            return ln.split("=", 1)[1].strip()
    return ""


SNIPPET_TEXT = """# Company Brain: one address for every company (deploy/tenancy/tenantctl.py setup-routing).
# A request naming a company (X-Company) goes to that company's API once the main API has
# confirmed the session may work there. Sign-in and company management stay on the main API.
if ($http_x_company) {
    rewrite ^/api/(?!auth/|workspaces/) /_cb_company last;
}
location = /_cb_company {
    internal;
    auth_request /_cb_gate;
    auth_request_set $cb_user $upstream_http_x_cb_user_id;
    proxy_pass http://$cb_company_api$request_uri;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-CB-User-Id $cb_user;
    proxy_set_header X-CB-Gate "%(secret)s";
    proxy_read_timeout 300s;
    client_max_body_size 50M;
}
location = /_cb_gate {
    internal;
    proxy_pass http://127.0.0.1:%(port)d/api/auth/gate;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-CB-User-Id "";
}
"""


def setup_routing(sites: list[str]) -> None:
    """Once per server: the gate secret, the nginx snippet, and the include in the given site files."""
    if os.geteuid() != 0:
        sys.exit("run as root")
    secret = _env_value(MAIN_ENV, "CB_GATE_SECRET")
    if not secret:
        secret = secrets.token_urlsafe(32)
        with MAIN_ENV.open("a") as f:
            f.write(f"\n# nginx -> company workspaces (deploy/tenancy/tenantctl.py setup-routing)\nCB_GATE_SECRET={secret}\n")
    for f in sorted(ENV_DIR.glob("*.env")) if ENV_DIR.exists() else []:
        if _env_value(f, "CB_GATE_SECRET") != secret:
            kept = [ln for ln in f.read_text().splitlines() if not ln.startswith("CB_GATE_SECRET=")]
            f.write_text("\n".join(kept + [f"CB_GATE_SECRET={secret}"]) + "\n")
            sh("systemctl", "try-restart", UNIT.format(f.stem), check=False)
    include = f"include {SNIPPET};"
    files = {SNIPPET: SNIPPET_TEXT % {"secret": secret, "port": MAIN_PORT}}
    for site in map(Path, sites):
        text = site.resolve().read_text()
        if include not in text:
            api_block = re.compile(r"(?m)^(\s*)(location\s+/api/\s*\{)")
            if not api_block.search(text):
                sys.exit(f"{site}: no 'location /api/' block to put the company routing beside")
            text = api_block.sub(lambda m: f"{m[1]}{include}\n{m[1]}{m[2]}", text)
        files[site.resolve()] = text
    routes()                                    # the map the snippet uses must exist first
    _nginx_swap(files)
    os.chmod(SNIPPET, 0o640)
    print(json.dumps({"routing": "on", "sites": sites}))


def run(slug: str, script: str, args: list[str]) -> int:
    """Run a scraper script for one workspace: as its user, with its env, so it sees only that company."""
    if os.geteuid() != 0:
        sys.exit("run as root")
    T.schema_of(slug)
    path = (APP / "scraper" / script).resolve()
    if path.parent != (APP / "scraper").resolve() or path.suffix != ".py" or not path.is_file():
        sys.exit(f"not a script in {APP / 'scraper'}: {script}")
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "HOME": str(DATA / slug),
           "PYTHONPYCACHEPREFIX": str(DATA / slug / ".pycache")}
    for line in _env_file(slug).read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v
    return subprocess.run(["runuser", "-u", T.role_of(slug), "--", str(PY), str(path), *args],
                          cwd=str(APP / "scraper"), env=env).returncode


def remove(slug: str) -> None:
    if os.geteuid() != 0:
        sys.exit("run as root")
    T.schema_of(slug)
    sh("systemctl", "disable", "--now", UNIT.format(slug), check=False)
    as_postgres("remove", slug)
    _env_file(slug).unlink(missing_ok=True)
    sh("rm", "-rf", "--one-file-system", str(DATA / slug))
    sh("userdel", T.role_of(slug), check=False)
    routes()
    print(json.dumps({"removed": slug}))


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "_db":                  # the postgres half
        op, *rest = sys.argv[2:]
        {"create": lambda: db_create(rest[0], rest[1], rest[2] if len(rest) > 2 else ""),
         "sync": lambda: db_sync(rest[0]), "check": lambda: db_check(rest[0]),
         "remove": lambda: db_remove(rest[0]), "list": db_list, "claim": db_claim,
         "finish": lambda: db_finish(*rest[:5]), "joined": db_joined, "claim_delete": db_claim_delete}[op]()
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create"); c.add_argument("slug"); c.add_argument("name")
    c.add_argument("--sector", default="")
    sub.add_parser("process", help="create the companies an admin added on the main site")
    sub.add_parser("routes", help="rewrite the nginx company map")
    sr = sub.add_parser("setup-routing", help="once: one address for every company")
    sr.add_argument("sites", nargs="+", help="nginx site files serving the app")
    for n in ("check", "sync"):
        sub.add_parser(n).add_argument("slug")
    sub.add_parser("list")
    r = sub.add_parser("remove"); r.add_argument("slug"); r.add_argument("--yes", action="store_true")
    x = sub.add_parser("run", help="run a scraper script as this workspace")
    x.add_argument("slug"); x.add_argument("script"); x.add_argument("args", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    if a.cmd == "run":
        sys.exit(run(a.slug, a.script, a.args))
    if a.cmd == "create":
        print(json.dumps(create(a.slug, a.name, a.sector)))
    elif a.cmd == "process":
        process()
    elif a.cmd == "routes":
        if os.geteuid() != 0:
            sys.exit("run as root")
        routes()
    elif a.cmd == "setup-routing":
        setup_routing(a.sites)
    elif a.cmd == "remove":
        if not a.yes:
            sys.exit(f"this deletes workspace {a.slug} and all its data; re-run with --yes")
        remove(a.slug)
    elif a.cmd == "list":
        print(as_postgres("list"), end="")
    else:
        print(as_postgres(a.cmd, a.slug), end="")


if __name__ == "__main__":
    main()
