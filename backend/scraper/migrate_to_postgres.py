"""
Migrate the Company Brain from SQLite to PostgreSQL.

WHY
---
SQLite served the build well but is the wrong engine for this product: several
processes write concurrently (API, pipeline, watcher, indexer), the impact graph
is 200k+ rows, and the retrieval index already lives in Postgres. Running one
engine removes a whole class of lock contention and lets retrieval join real
data.

APPROACH
--------
    1. read the SQLite schema and translate it, table by table
    2. copy every row, preserving ids exactly
    3. reset sequences so new inserts do not collide with migrated ids
    4. verify row counts table by table and refuse to declare success on a mismatch

The source database is never modified. It is left in place as a fallback until
the migration has been verified.
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from pathlib import Path

import psycopg

HERE = Path(__file__).parent
SQLITE_PATH = HERE / "output" / "regintel.db"
PG_DSN = "postgresql:///company_brain"

# SQLite is loosely typed; Postgres is not. These map the declared types we
# actually use, and anything unknown falls back to TEXT rather than guessing a
# narrower type that could reject real data.
TYPE_MAP = [
    (r"^INTEGER PRIMARY KEY AUTOINCREMENT$", "BIGSERIAL PRIMARY KEY"),
    (r"^INTEGER PRIMARY KEY$", "BIGSERIAL PRIMARY KEY"),
    (r"^INTEGER$", "BIGINT"),
    (r"^INT$", "INTEGER"),
    (r"^REAL$", "DOUBLE PRECISION"),
    (r"^BLOB$", "BYTEA"),
    (r"^BOOLEAN$", "BOOLEAN"),
    (r"^TEXT$", "TEXT"),
]


def pg_type(decl: str) -> str:
    d = decl.strip().upper()
    for pat, repl in TYPE_MAP:
        if re.match(pat, d):
            return repl
    return "TEXT"


def sqlite_tables(con) -> list[str]:
    return [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def build_ddl(con, table: str) -> tuple[str, list[str]]:
    """Returns (CREATE TABLE ..., [column names]) for one table."""
    cols = con.execute(f"PRAGMA table_info({table})").fetchall()
    pk = [c[1] for c in cols if c[5]]
    defs, names = [], []
    for cid, name, decl, notnull, default, is_pk in cols:
        names.append(name)
        t = pg_type(decl or "TEXT")
        # PRAGMA table_info reports only the DECLARED type ("INTEGER"), never
        # "INTEGER PRIMARY KEY AUTOINCREMENT" — so autoincrement has to be
        # inferred from the pk flag. Missing this produced plain BIGINT columns
        # with no default, which would reject every insert that omits an id.
        is_autoinc = (is_pk and len(pk) == 1
                      and (decl or "").strip().upper() in ("INTEGER", "INT", ""))
        if is_autoinc:
            defs.append(f'"{name}" BIGSERIAL PRIMARY KEY')
            continue
        t = t.replace("BIGSERIAL PRIMARY KEY", "BIGINT")
        piece = f'"{name}" {t}'
        if notnull:
            piece += " NOT NULL"
        if default is not None:
            d = str(default)
            # SQLite's datetime('now') has no Postgres equivalent inline
            if "datetime(" in d or "date(" in d or "CURRENT_TIMESTAMP" in d.upper():
                piece += " DEFAULT now()::text"
            elif d.upper() != "NULL":
                piece += f" DEFAULT {d}"
        defs.append(piece)
    if len(pk) > 1:
        defs.append(f'PRIMARY KEY ({", ".join(chr(34) + p + chr(34) for p in pk)})')
    elif len(pk) == 1 and not any("PRIMARY KEY" in d for d in defs):
        defs.append(f'PRIMARY KEY ("{pk[0]}")')
    return f'CREATE TABLE IF NOT EXISTS "{table}" (\n  ' + ",\n  ".join(defs) + "\n);", names


def indexes_for(con, table: str) -> list[str]:
    """Translate the unique indexes. Plain indexes are recreated by the app schema."""
    out = []
    for r in con.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
            (table,)):
        sql = r[1]
        m = re.search(r"ON\s+\w+\s*\(([^)]+)\)", sql, re.I)
        if not m:
            continue
        cols = ", ".join(f'"{c.strip().strip(chr(34))}"' for c in m.group(1).split(","))
        uniq = "UNIQUE " if re.search(r"CREATE\s+UNIQUE", sql, re.I) else ""
        out.append(f'CREATE {uniq}INDEX IF NOT EXISTS "{r[0]}" ON "{table}" ({cols});')
    return out


def migrate(drop: bool = False, batch: int = 2000) -> dict:
    scon = sqlite3.connect(f"file:{SQLITE_PATH}?mode=ro", uri=True)
    scon.row_factory = sqlite3.Row
    pcon = psycopg.connect(PG_DSN, autocommit=False)

    tables = sqlite_tables(scon)
    report: dict[str, dict] = {}

    with pcon.cursor() as cur:
        if drop:
            for t in reversed(tables):
                cur.execute(f'DROP TABLE IF EXISTS "{t}" CASCADE')
            pcon.commit()
            print(f"  dropped {len(tables)} existing tables")

        # 1. schema
        for t in tables:
            ddl, _ = build_ddl(scon, t)
            cur.execute(ddl)
        pcon.commit()
        print(f"  created {len(tables)} tables")

        # 2. data
        for t in tables:
            cols = [c[1] for c in scon.execute(f"PRAGMA table_info({t})")]
            total = scon.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            if not total:
                report[t] = {"sqlite": 0, "postgres": 0, "ok": True}
                continue
            quoted = ", ".join(f'"{c}"' for c in cols)
            placeholders = ", ".join(["%s"] * len(cols))
            copied = 0
            rows = scon.execute(f"SELECT {quoted.replace(chr(34), '')} FROM {t}")
            while True:
                chunk = rows.fetchmany(batch)
                if not chunk:
                    break
                cur.executemany(
                    f'INSERT INTO "{t}" ({quoted}) VALUES ({placeholders}) ON CONFLICT DO NOTHING',
                    [tuple(r) for r in chunk])
                copied += len(chunk)
            pcon.commit()
            got = cur.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
            report[t] = {"sqlite": total, "postgres": got, "ok": got == total}
            print(f"  {t:<24} {total:>7} -> {got:>7} {'ok' if got == total else 'MISMATCH'}")

        # 3. indexes
        n_idx = 0
        for t in tables:
            for stmt in indexes_for(scon, t):
                try:
                    cur.execute(stmt); n_idx += 1
                except Exception as e:
                    print(f"  [index skipped] {str(e)[:90]}")
                    pcon.rollback()
        pcon.commit()
        print(f"  created {n_idx} indexes")

        # 4. sequences — otherwise the first insert collides with a migrated id
        n_seq = 0
        for t in tables:
            # not every table has an 'id' column (impact_scores is keyed by
            # regulation_id), so ask before assuming one exists
            has_id = cur.execute(
                """SELECT 1 FROM information_schema.columns
                   WHERE table_name=%s AND column_name='id'""", (t,)).fetchone()
            if not has_id:
                continue
            seq = cur.execute(
                "SELECT pg_get_serial_sequence(%s, %s)", (t, "id")).fetchone()[0]
            if not seq:
                continue
            cur.execute(f'SELECT COALESCE(MAX("id"), 0) FROM "{t}"')
            mx = cur.fetchone()[0] or 0
            cur.execute("SELECT setval(%s, %s)", (seq, max(mx, 1)))
            n_seq += 1
        pcon.commit()
        print(f"  reset {n_seq} sequences")

    bad = {t: v for t, v in report.items() if not v["ok"]}
    return {"tables": len(tables), "mismatches": bad,
            "totalRows": sum(v["postgres"] for v in report.values()), "report": report}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--drop", action="store_true", help="drop existing Postgres tables first")
    a = ap.parse_args()
    res = migrate(drop=a.drop)
    print()
    if res["mismatches"]:
        print("MIGRATION INCOMPLETE — row count mismatches:", res["mismatches"])
        sys.exit(1)
    print(f"migrated {res['totalRows']} rows across {res['tables']} tables, all counts match")
