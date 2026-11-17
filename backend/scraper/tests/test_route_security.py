"""
The authorization contract, enforced as a test: every route in the app rejects
an anonymous request and a forged token — except the surface that is open by
design (health, auth status/login/bootstrap/logout, OAuth callbacks).

Runs in-process against the real app. Only unauthenticated requests are sent,
so no handler body ever executes and the live database is never written.
Needs the database reachable (dependencies consult auth state), so it skips
itself on machines without one.
"""
import os

import pytest

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

try:
    from regulatory_ingestion.db import connect
    connect().execute("SELECT 1").fetchone()
    _DB = True
except Exception:
    _DB = False

pytestmark = pytest.mark.skipif(not _DB, reason="no database on this machine")

OPEN = {
    ("GET", "/api/health"),
    ("GET", "/api/auth/status"),
    ("POST", "/api/auth/login"),          # rate-limited at nginx; constant-fail in auth.py
    ("POST", "/api/auth/bootstrap"),      # refuses once users exist
    ("POST", "/api/auth/logout"),
    ("GET", "/api/auth/me"),              # returns 401 itself; asserted below anyway
}


def _client():
    from fastapi.testclient import TestClient
    from regulatory_ingestion.api import app
    return TestClient(app, raise_server_exceptions=False), app


def _api_routes(app):
    """Every APIRoute the app will actually serve, included routers and all.

    FastAPI 0.141 stopped flattening `include_router` into `app.routes`: an
    included router is now one lazy `_IncludedRouter` entry that resolves its
    own routes at request time. Walking `app.routes` and keeping only APIRoute
    therefore stopped seeing ANY router-based route — which here is 22 routers
    and all but sixteen endpoints in the product.

    The tests below still passed. They were checking that a handful of
    locally-declared routes reject anonymous callers, and silently not checking
    the auth router, the integrations router, the agent router or any other. The
    one bug this file exists to catch — a router shipped without a capability,
    answering 200 to anyone who can reach the port — had no coverage at all.

    Both shapes are handled so the suite does not depend on the FastAPI version.
    """
    from fastapi.routing import APIRoute
    try:
        from fastapi.routing import _IncludedRouter
    except ImportError:                       # pre-0.141: routes are flattened
        _IncludedRouter = ()

    def walk(routes, prefix=""):
        for r in routes:
            if isinstance(r, APIRoute):
                yield prefix + r.path, r
            elif _IncludedRouter and isinstance(r, _IncludedRouter):
                ctx = getattr(r, "include_context", None)
                yield from walk(r.original_router.routes,
                                prefix + (getattr(ctx, "prefix", "") or ""))

    seen = set()
    for path, route in walk(app.routes):
        key = (path, frozenset(route.methods))
        if key not in seen:
            seen.add(key)
            yield path, route


def _requests(app):
    for template, r in _api_routes(app):
        path = template
        for part in list({p for p in path.split("/") if p.startswith("{")}):
            path = path.replace(part, "1")
        for m in sorted(r.methods - {"HEAD", "OPTIONS"}):
            yield m, template, path


def test_every_route_rejects_anonymous():
    client, app = _client()
    leaks = []
    for method, template, path in _requests(app):
        if (method, template) in OPEN:
            continue
        res = client.request(method, path, json={} if method in ("POST", "PUT", "PATCH") else None)
        if res.status_code not in (401, 403):
            leaks.append(f"{method} {template} -> {res.status_code}")
    assert not leaks, "routes reachable without a session:\n  " + "\n  ".join(leaks)


def test_every_route_rejects_forged_token():
    client, app = _client()
    leaks = []
    headers = {"Authorization": "Bearer forged-token-000000000000"}
    for method, template, path in _requests(app):
        if (method, template) in OPEN:
            continue
        res = client.request(method, path, headers=headers,
                             json={} if method in ("POST", "PUT", "PATCH") else None)
        if res.status_code not in (401, 403):
            leaks.append(f"{method} {template} -> {res.status_code}")
    assert not leaks, "routes reachable with a forged token:\n  " + "\n  ".join(leaks)


def test_open_surface_is_exactly_as_designed():
    client, app = _client()
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/auth/status").status_code == 200
    assert client.get("/api/auth/me").status_code == 401
