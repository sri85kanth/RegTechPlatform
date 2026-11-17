"""
Precision gate — stops generic entity names from matching everything.

"Compliance", "Credit" and "Operations" are real departments, but they are also
ordinary words in any regulatory text, so an exact-name match on them means
nothing. This measures how common each entity name is across the corpus and
demands a stronger signal from the common ones.

Also drops boilerplate clauses — short title, commencement, repeal — which
create obligations that bind nobody in particular.
"""
import re

# clauses that exist in every instrument and bind no specific entity
BOILERPLATE = re.compile(
    r"\b(short title|commencement|shall come into force|repeal and saving|"
    r"interpretation|definitions?|extent and application|these directions? shall be called)\b",
    re.I,
)

STOPWORDS = {
    "the", "a", "an", "of", "and", "or", "to", "in", "for", "by", "with", "on",
    "management", "system", "data", "policy", "process", "control", "report", "record",
}


def is_boilerplate(text: str) -> bool:
    """True when a clause is procedural rather than substantive."""
    head = (text or "")[:200]
    return bool(BOILERPLATE.search(head))


# Rows pulled per round trip while streaming the obligations table.
_SCAN_BATCH = 2000


def document_frequency(con, names: list[str]) -> dict[str, int]:
    """
    How many regulations mention each entity name, from ONE pass over the
    obligations table.

    This used to run a query per name — 1,143 of them, each a leading-wildcard
    LIKE that no index can serve, each a full scan. Measured on the deployment
    that was 14.6 seconds per name, so 4.6 hours for a single document, and the
    ingest looked like it was stuck on a slow download: a py-spy dump showed
    poll() on a socket, which is what a Postgres client waiting on a query and a
    web client waiting on a server both look like. It was the database.

    Same answer, same semantics — a name is counted once per regulation that
    mentions it in an obligation title or description — from a single scan.
    """
    wanted: dict[str, str] = {}
    for name in names:
        n = (name or "").strip()
        if n:
            wanted[n] = n.lower()
    if not wanted:
        return {}

    seen: dict[str, set] = {n: set() for n in wanted}
    probes = list(wanted.items())          # (original, lowered), ordered once
    cur = con.execute(
        "SELECT regulation_id, "
        "lower(coalesce(title,'') || ' ' || coalesce(description,'')) FROM obligations")
    while True:
        rows = cur.fetchmany(_SCAN_BATCH)
        if not rows:
            break
        for rid, text in rows:
            if not text:
                continue
            for original, needle in probes:
                if needle in text:
                    seen[original].add(rid)
    return {n: len(ids) for n, ids in seen.items()}


def generic_names(df: dict[str, int], corpus_size: int, threshold: float = 0.15) -> set[str]:
    """
    Names appearing in more than `threshold` of the corpus carry no signal on
    their own. Single-word names are judged harder than multi-word ones, since
    "Compliance" is ambiguous where "KYC Verification Control" is not.
    """
    out = set()
    for name, n in df.items():
        share = n / max(1, corpus_size)
        words = len(name.split())
        limit = threshold if words > 1 else threshold / 3
        if share > limit:
            out.add(name)
    return out


def accept(match: dict, entity_name: str, obligation_text: str, generic: set[str]) -> tuple[bool, str]:
    """
    Decide whether a candidate survives. Returns (keep, reason_if_dropped).
    A generic name needs more than its name to justify a link.
    """
    if is_boilerplate(obligation_text):
        return False, "boilerplate clause — binds no specific entity"

    signals = match.get("signals") or {}
    if isinstance(signals, str):
        import json
        try:
            signals = json.loads(signals)
        except Exception:
            signals = {}

    if entity_name in generic:
        # A common name needs the WHOLE name to appear, and a one-word name can
        # never satisfy that — "Compliance" appearing in a compliance document
        # is not evidence that this department is affected.
        #
        # This test used to accept any signal that was not exact/name_tokens,
        # which in practice meant the ontology keyword — the WEAKEST signal, and
        # one that fires for every obligation of a given type. So a generic name
        # was rejected on strong evidence and accepted on the weakest available.
        if len(entity_name.split()) < 2 or "exact" not in signals:
            return False, (f'"{entity_name}" is common across the corpus — it needs its full '
                           "multi-word name in the clause, not a keyword or partial match")

    if len(entity_name.split()) == 1 and len(entity_name) <= 4:
        return False, "entity name too short to match reliably"

    return True, ""
