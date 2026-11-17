"""
PostgreSQL connection layer, shaped like the sqlite3 API the codebase already uses.

WHY A COMPATIBILITY LAYER
-------------------------
Twenty modules were written against sqlite3: `?` placeholders, `sqlite3.Row`
(which supports BOTH r[0] and r["name"]), `.executescript()`, `.lastrowid`.
Rewriting every call site by hand would be a large, silent-breakage-prone diff.
This layer keeps those call shapes working while the engine underneath is
Postgres, so the migration is one reviewable file rather than a thousand edits.

It is NOT an ORM and does not hide SQL. Genuinely dialect-specific statements
(ON CONFLICT, date functions, string_agg) are still translated below, because
pretending those are the same across engines is how subtle data bugs appear.
"""
from __future__ import annotations

import os
import re
from typing import Any, Iterable, Sequence

import psycopg
from psycopg import sql as _sql

DSN = os.environ.get("COMPANY_BRAIN_DSN", "postgresql:///company_brain")


class Row(dict):
    """
    Behaves like sqlite3.Row: indexable by position AND by column name.

    The codebase uses both — r[0] in aggregate queries, r["name"] elsewhere —
    so a plain dict row would break roughly half the call sites.
    """

    __slots__ = ("_values",)

    def __init__(self, values: Sequence, columns: Sequence[str]):
        super().__init__(zip(columns, values))
        self._values = list(values)

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        if isinstance(key, slice):
            return self._values[key]
        return super().__getitem__(key)

    def __iter__(self):
        # sqlite3.Row iterates VALUES, not keys
        return iter(self._values)

    def keys(self):
        return list(super().keys())


def _row_factory(cursor):
    cols = [c.name for c in (cursor.description or [])]
    def make(values):
        return Row(values, cols)
    return make


# ---- SQL translation -------------------------------------------------------
# Only what genuinely differs. Everything else is standard SQL in both engines.
_SUBS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bdatetime\('now'\)", re.I), "now()::text"),
    (re.compile(r"\bdate\('now'\)", re.I), "current_date::text"),
    (re.compile(r"\bGROUP_CONCAT\s*\(", re.I), "string_agg("),
    (re.compile(r"\bINSERT\s+OR\s+REPLACE\s+INTO\b", re.I), "INSERT INTO"),
    # NOTE: handled separately in translate() — it also needs ON CONFLICT DO NOTHING
    (re.compile(r"\bUPDATE\s+OR\s+IGNORE\b", re.I), "UPDATE"),
    (re.compile(r"\bAUTOINCREMENT\b", re.I), ""),
    (re.compile(r"\bINTEGER\s+PRIMARY\s+KEY\b", re.I), "BIGSERIAL PRIMARY KEY"),
    (re.compile(r"\bsubstr\s*\(", re.I), "substring("),
    (re.compile(r"\bIFNULL\s*\(", re.I), "COALESCE("),
    # rowid is SQLite's implicit key. ctid is the closest Postgres analogue for
    # ordering; selecting it explicitly is not supported and is not used here.
    (re.compile(r"\bORDER\s+BY\s+rowid\b", re.I), "ORDER BY ctid"),
]

_PLACEHOLDER = re.compile(r"\?(?=(?:[^']*'[^']*')*[^']*$)")   # ignore ? inside quotes
_LINE_COMMENT = re.compile(r"--[^\n]*")


def _mask_comments(q: str) -> tuple[str, list[str]]:
    """
    Blank out -- comments before placeholder rewriting.

    A '?' inside a comment is not a bind parameter, but the rewriter cannot tell
    the difference — a comment reading "changed between when and when?" silently
    became an extra placeholder and the query failed with a parameter-count
    mismatch that points nowhere near the comment.
    """
    saved: list[str] = []

    def keep(m):
        saved.append(m.group(0))
        return f"--__C{len(saved) - 1}__"

    return _LINE_COMMENT.sub(keep, q), saved


def _restore_comments(q: str, saved: list[str]) -> str:
    for i, c in enumerate(saved):
        q = q.replace(f"--__C{i}__", c)
    return q


_OR_IGNORE = re.compile(r"\b(INSERT|UPDATE)\s+OR\s+IGNORE\b", re.I)


def translate(q: str) -> str:
    ignore_kind = None
    m = _OR_IGNORE.search(q)
    if m:
        ignore_kind = m.group(1).upper()
        q = _OR_IGNORE.sub(m.group(1), q)

    for pat, repl in _SUBS:
        q = pat.sub(repl, q)

    # Placeholder style decides how to treat '%'.
    #
    # psycopg reserves '%' for placeholders, so a literal one in a LIKE pattern
    # ("LIKE 'docling%'") must be doubled. But queries already written in
    # psycopg style use %s deliberately and must not be touched. Using the
    # presence of '?' to tell them apart keeps both unambiguous — guessing per
    # character would mangle "LIKE '%sample%'".
    if _PLACEHOLDER.search(q):
        q, _saved = _mask_comments(q)
        q = q.replace("%", "%%")
        q = _PLACEHOLDER.sub("%s", q)
        q = _restore_comments(q, _saved)

    # Restore the "tolerate a conflict" semantics OR IGNORE provided. Without
    # this an insert that used to be skipped would now raise.
    if ignore_kind == "INSERT" and "on conflict" not in q.lower():
        q = q.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
    return q


_PRAGMA = re.compile(r"^\s*PRAGMA\s+(\w+)\s*(?:=\s*(\S+)|\(\s*([\w\"']+)\s*\))?", re.I)

# PRAGMA table_info(t) is used to introspect columns. Postgres has no PRAGMA, but
# information_schema answers the same question — and returning the same tuple
# shape means the call sites need no changes.
_TABLE_INFO = """
SELECT (ordinal_position - 1)::int      AS cid,
       column_name                      AS name,
       upper(data_type)                 AS type,
       CASE WHEN is_nullable='NO' THEN 1 ELSE 0 END AS notnull,
       column_default                   AS dflt_value,
       CASE WHEN column_name = ANY(
         SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = %s::regclass AND i.indisprimary
       ) THEN 1 ELSE 0 END              AS pk
FROM information_schema.columns
WHERE table_name=%s
  AND table_schema = (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE c.oid = to_regclass(%s))
ORDER BY ordinal_position
"""
# The schema is the one the name resolves to on this connection's search_path,
# not 'public': in a company workspace (tenancy.py) a company table resolves to
# the company's own schema and must be described from there.


# ---------------------------------------------------------------------------
# Schema changes in a company workspace
#
# Modules create and migrate their tables at runtime (CREATE TABLE IF NOT
# EXISTS, ALTER TABLE ... ADD COLUMN). In a company workspace the first schema
# on the search_path is the company's own, so an unqualified CREATE for a
# LIBRARY table would make an empty company copy that hides the shared one.
# Library tables are created and migrated by the first company's process; a
# company process only runs DDL on its own tables and skips the rest.
# ---------------------------------------------------------------------------
_DDL_TARGET = re.compile(
    r"^\s*(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(?:ONLY\s+)?"
    r"|CREATE\s+(?:TEMP(?:ORARY)?\s+)?(TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?"
    r"|CREATE\s+OR\s+REPLACE\s+VIEW\s+"
    r"|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"
    r"|DROP\s+(?:TABLE|VIEW|INDEX)\s+(?:IF\s+EXISTS\s+)?)"
    r"([\"A-Za-z_][\"A-Za-z0-9_.]*)", re.I)


def _skip_ddl(q: str) -> bool:
    """True when this process serves a company workspace and `q` is DDL on a library table."""
    from . import tenancy                      # imported late: tenancy imports nothing from here
    if not tenancy.current():
        return False
    m = _DDL_TARGET.match(q)
    if not m:
        return False
    if re.match(r"^\s*CREATE\s+TEMP", q, re.I):
        return False                           # a temporary table is private to the session
    # an index is judged by its table; DROP INDEX names only the index, so it is skipped
    return not tenancy.owns(m.group(2))


# Tables that answered "no id column" once. Remembered so the speculative
# RETURNING probe runs at most once per table per process.
_NO_ID_TABLES: set[str] = set()
_INSERT_TARGET = re.compile(r"^\s*INSERT\s+INTO\s+[\"\']?([A-Za-z_][A-Za-z0-9_.]*)", re.I)


def _insert_target(sql: str) -> str | None:
    m = _INSERT_TARGET.match(sql)
    return m.group(1).lower() if m else None


class Cursor:
    """Thin wrapper that translates SQL and exposes sqlite-style lastrowid."""

    def __init__(self, cur, conn):
        self._cur = cur
        self._conn = conn
        self.lastrowid: Any = None

    def execute(self, query: str, params: Sequence | None = None):
        # A str/bytes passed as params is always a bug: it would be treated as a
        # sequence of characters. Wrap it rather than failing obscurely.
        if isinstance(params, (str, bytes)):
            params = (params,)
        pg = _PRAGMA.match(query)
        if pg:
            name = pg.group(1).lower()
            target = (pg.group(3) or "").strip("\"'")
            if name == "table_info" and target:
                # answer the introspection question the caller actually asked
                self._cur.execute(_TABLE_INFO, (target, target, target))
                return self
            # journal_mode / busy_timeout / foreign_keys / integrity_check have no
            # Postgres equivalent and no meaning here — succeed silently rather
            # than making every caller special-case the engine.
            self._cur.execute("SELECT 1 WHERE false")
            return self

        q = translate(query)
        if _skip_ddl(q):
            self._cur.execute("SELECT 1 WHERE false")
            return self
        # sqlite exposes lastrowid after an INSERT; Postgres needs RETURNING
        wants_id = (re.match(r"\s*INSERT\b", q, re.I)
                    and "returning" not in q.lower())
        if wants_id:
            table = _insert_target(q)
            if table in _NO_ID_TABLES:
                wants_id = False                     # asked before; it has no id
        if wants_id:
            # The probe is speculative, so it has to be undoable. It used to be
            # recovered with a plain ROLLBACK, which threw away not just the
            # probe but every uncommitted write before it. An INSERT into any
            # table without an id column — regulation_sectors, regulation_types,
            # regulation_regions, impact_scores, sessions, the agent
            # checkpoints — therefore silently discarded the caller's whole
            # transaction and then failed on a foreign key to the row it had
            # just erased. A SAVEPOINT undoes the probe and nothing else.
            q_ret = q.rstrip().rstrip(";") + " RETURNING id"
            guarded = self._conn.in_transaction_block()
            if guarded:
                self._cur.execute("SAVEPOINT pgdb_returning_id")
            try:
                self._cur.execute(q_ret, tuple(params) if params else None)
                got = self._cur.fetchone()
                self.lastrowid = got[0] if got else None
                if guarded:
                    self._cur.execute("RELEASE SAVEPOINT pgdb_returning_id")
                return self
            except psycopg.errors.UndefinedColumn:
                if table:
                    _NO_ID_TABLES.add(table)         # do not probe this one again
                if guarded:
                    self._cur.execute("ROLLBACK TO SAVEPOINT pgdb_returning_id")
                else:
                    self._conn.rollback_savepoint()
        try:
            self._cur.execute(q, tuple(params) if params else None)
        except psycopg.Error:
            # Postgres aborts the transaction on ANY error, so without this one
            # bad statement makes every later query fail with
            # "current transaction is aborted" — masking the real cause.
            self._conn.rollback()
            raise
        return self

    def executemany(self, query: str, seq: Iterable[Sequence]):
        rows = [tuple(r) for r in seq]
        if rows:
            self._cur.executemany(translate(query), rows)
        return self

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    def fetchmany(self, n: int = 1000):
        return self._cur.fetchmany(n)

    def __iter__(self):
        return iter(self._cur)

    @property
    def rowcount(self):
        return self._cur.rowcount

    @property
    def description(self):
        return self._cur.description

    def close(self):
        self._cur.close()


def split_statements(script: str) -> list[str]:
    """
    Split a DDL script on statement boundaries.

    A naive split(";") breaks on semicolons inside line comments and string
    literals — several schemas here carry comments like
    "-- write-only; never returned by the API", which truncated the statement
    and produced "syntax error at end of input".
    """
    out, buf = [], []
    in_line_comment = in_block_comment = False
    quote: str | None = None
    i = 0
    while i < len(script):
        ch = script[i]
        nxt = script[i + 1] if i + 1 < len(script) else ""

        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            buf.append(ch); i += 1; continue
        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                buf.append("*/"); i += 2; continue
            buf.append(ch); i += 1; continue
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            i += 1; continue

        if ch == "-" and nxt == "-":
            in_line_comment = True; buf.append("--"); i += 2; continue
        if ch == "/" and nxt == "*":
            in_block_comment = True; buf.append("/*"); i += 2; continue
        if ch in ("'", '"'):
            quote = ch; buf.append(ch); i += 1; continue
        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []; i += 1; continue

        buf.append(ch); i += 1

    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    # a fragment that is only a comment is not a statement
    return [s for s in out if any(
        ln.strip() and not ln.strip().startswith("--") for ln in s.splitlines())]


class Connection:
    """sqlite3.Connection-shaped wrapper over psycopg."""

    def __init__(self, dsn: str = DSN, autocommit: bool = False):
        self._c = psycopg.connect(dsn, autocommit=autocommit, row_factory=_row_factory)
        self.row_factory = Row          # accepted and ignored: rows are always Row
        self._changes = 0
        # Set False around a multi-statement read-modify-write that must stay in
        # one transaction; otherwise reads release their snapshot immediately.
        self._auto_release = not autocommit

        # Belt and braces: even if some path forgets, Postgres will not let a
        # forgotten transaction hold locks forever.
        try:
            self._c.execute("SET idle_in_transaction_session_timeout = '30s'")
            self._c.commit()
        except psycopg.Error:
            pass

    # -- sqlite-style helpers ------------------------------------------------
    # Statements that only read. After one of these the transaction is finished
    # as far as the caller is concerned.
    _READ_ONLY = re.compile(r"^\s*(SELECT|WITH|SHOW|EXPLAIN|PRAGMA)\b", re.I)

    def execute(self, query: str, params: Sequence | None = None) -> Cursor:
        cur = Cursor(self._c.cursor(), self)
        cur.execute(query, params)
        self._changes += max(cur.rowcount, 0)
        # Release the snapshot after a read.
        #
        # Callers commit after writes but never after reads, so every read left
        # the connection "idle in transaction" — holding locks and an open
        # snapshot for the life of the process. That blocked DDL outright: an
        # ALTER TABLE waited behind API connections that were doing nothing.
        if self._auto_release and self._READ_ONLY.match(query):
            try:
                self._c.commit()
            except psycopg.Error:
                pass
        return cur

    def executemany(self, query: str, seq: Iterable[Sequence]) -> Cursor:
        cur = Cursor(self._c.cursor(), self)
        cur.executemany(query, seq)
        self._changes += max(cur.rowcount, 0)
        return cur

    def executescript(self, script: str) -> "Connection":
        """
        Run a multi-statement DDL script.

        Each statement is committed independently so one 'already exists' does
        not abort the rest — Postgres aborts the whole transaction on any error,
        unlike SQLite.
        """
        for stmt in split_statements(script):
            if _skip_ddl(translate(stmt)):
                continue
            try:
                self._c.execute(translate(stmt))
                self._c.commit()
            except psycopg.errors.DuplicateTable:
                self._c.rollback()
            except psycopg.errors.DuplicateObject:
                self._c.rollback()
            except psycopg.Error:
                self._c.rollback()
                raise
        return self

    def cursor(self) -> Cursor:
        return Cursor(self._c.cursor(), self)

    def commit(self):
        self._c.commit()

    def rollback(self):
        self._c.rollback()

    def close(self):
        self._c.close()

    def in_transaction_block(self) -> bool:
        """True when a SAVEPOINT is legal — i.e. a transaction is already open.

        In autocommit mode each statement is its own transaction, so a failed
        probe poisons nothing and there is nothing to protect.
        """
        try:
            return self._c.info.transaction_status in (
                psycopg.pq.TransactionStatus.INTRANS,
                psycopg.pq.TransactionStatus.INERROR)
        except Exception:                            # noqa: BLE001 — fall back to the safe answer
            return False

    def rollback_savepoint(self):
        """Recover from a failed probe when no transaction was open to protect.

        Kept for that case only. Callers inside a transaction use a real
        SAVEPOINT — see Cursor.execute — because this loses every uncommitted
        write, not just the probe.
        """
        self._c.rollback()

    @property
    def total_changes(self) -> int:
        return self._changes

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        if exc[0]:
            self.rollback()
        else:
            self.commit()


def connect(dsn: str = DSN) -> Connection:
    return Connection(dsn)
