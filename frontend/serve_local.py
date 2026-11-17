"""
Serve the built UI and forward /api to an API instance.

A development convenience, not a server: one host, no TLS, bound to localhost.
It exists so a build can be opened against a scratch database — the same thing
nginx does in production, so the bundle needs no rebuild.

    LOCAL_API=http://127.0.0.1:8790 PORT=8791 python serve_local.py
"""
from __future__ import annotations

import http.server
import os
import socketserver
import urllib.error
import urllib.request
from pathlib import Path

DIST = Path(__file__).resolve().parent / "dist"
API = os.environ.get("LOCAL_API", "http://127.0.0.1:8787")
PORT = int(os.environ.get("PORT", "5180"))
HOP_BY_HOP = {"transfer-encoding", "connection", "content-length", "content-encoding"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def _proxy(self) -> None:
        body = None
        if self.headers.get("Content-Length"):
            body = self.rfile.read(int(self.headers["Content-Length"]))
        req = urllib.request.Request(API + self.path, data=body, method=self.command)
        for h in ("Authorization", "Content-Type", "Accept"):
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data, status, headers = r.read(), r.status, r.headers
        except urllib.error.HTTPError as e:
            data, status, headers = e.read(), e.code, e.headers
        except Exception as e:                      # the API is down: say so as JSON
            data, status, headers = str(e).encode(), 502, {}
        self.send_response(status)
        for k, v in (headers.items() if headers else []):
            if k.lower() not in HOP_BY_HOP:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path.startswith("/api"):
            return self._proxy()
        # a single-page app: any unknown path is a route, not a missing file
        if not (DIST / self.path.lstrip("/").split("?")[0]).is_file() and "." not in self.path.rsplit("/", 1)[-1]:
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:
        self._proxy()

    do_PUT = do_PATCH = do_DELETE = do_POST

    def log_message(self, *a) -> None:      # quiet: the API logs what matters
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    print(f"UI {DIST} on http://127.0.0.1:{PORT}  ->  API {API}", flush=True)
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()
