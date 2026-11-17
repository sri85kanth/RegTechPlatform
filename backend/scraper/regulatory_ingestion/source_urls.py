"""
Where to actually fetch a stored document from.

The stored URL stays what the source gave us — it is the record of where the
document came from. But some sources move their files without changing the
links they handed out, and fetching the stored URL then fails for every one of
those documents at once.

TeamLease RegTech is one: ~27,000 regulations carry an `official_document_url`
on its Azure file store

    https://trplprodcompliance.blob.core.windows.net/actfiles/legalupdatedocs/<id>/<file>

which, since late 2026, answers `ResourceNotFound` for every file. TeamLease's
own article pages now open those same files through a proxy on its site:

    https://teamleaseregtech.com/filepdfproxy/?f=<url-encoded "legalupdatedocs/<id>/<file>">

(the page's own toProxyUrl() builds exactly this). Fetching through it returns
the real PDF, byte for byte the file the store used to serve.
"""
from __future__ import annotations

from urllib.parse import quote, unquote, urlsplit

TEAMLEASE_STORE = "trplprodcompliance.blob.core.windows.net"
TEAMLEASE_PROXY = "https://teamleaseregtech.com/filepdfproxy/?f="


def fetchable(url: str | None) -> str | None:
    """The URL to download a stored document from (the stored URL itself when nothing has moved)."""
    if not url:
        return url
    parts = urlsplit(url.strip())
    if (parts.hostname or "").lower() == TEAMLEASE_STORE:
        # decoded first, so a stored "%20" and a stored raw space both end up encoded once
        segs = [unquote(s) for s in parts.path.split("/") if s]
        # /actfiles/<container>/<id>/<file> -> "<container>/<id>/<file>", as TeamLease's page does
        if len(segs) >= 4 and segs[0] == "actfiles":
            return TEAMLEASE_PROXY + quote("/".join(segs[1:4]), safe="")
    return url


def moved(url: str | None) -> bool:
    """True when the document is fetched from somewhere other than its stored URL."""
    return bool(url) and fetchable(url) != url
