"""
Operational self-checks — alerting that works with zero external services.

  probe   every 10 minutes: is the site serving, is the API answering, is the
          database reachable? Failure -> CRITICAL notification (+ webhook if
          ALERT_WEBHOOK_URL is set) and a non-zero exit, which systemd's
          OnFailure= turns into a root-side restart of the API service.
          Recovery -> one "recovered" notice, never a stream.
  daily   a morning digest: disk, memory, swap, the nightly units' last exit
          status and run time, and yesterday's error count from the journal.
          Bad numbers raise severity; good numbers stay quiet in one row.

Notifications land in the app's own notification centre (admin role), so the
alert channel needs nothing the box does not already have. A webhook URL in
/etc/company-brain/env extends the same alerts to Slack/ntfy/anything later.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

from . import notifications
from .db import connect

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
STATE = Path(__file__).parent.parent / "output" / "opscheck.state.json"
SITE = os.environ.get("OPSCHECK_ORIGIN", "http://187.77.188.114")


def _webhook(payload: dict) -> None:
    url = os.environ.get("ALERT_WEBHOOK_URL")
    if not url:
        return
    try:
        requests.post(url, json=payload, timeout=10)
    except requests.RequestException:
        pass                                  # the in-app notification already exists


def _state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {}


def _save(d: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(d))


# ------------------------------------------------------------------ probe
# A slow answer and a dead service are not the same thing, and treating them
# the same caused real harm: on 2026-09-09 the API was restarted 701 times in a
# day because /api/health took longer than the probe's 15 s timeout on a host
# that was giving this guest ~6% of a CPU. Each restart killed whatever was
# in flight — including a 414-file folder upload, which surfaced to the user as
# HTTP 502.
#
# So failures are now classified:
#   HARD — refused, reset, 5xx, database down. The service really is broken;
#          heal immediately, as before.
#   SOFT — a timeout. The service answered too slowly to wait for, which on a
#          starved box is normal. Alert, but only heal after SOFT_STREAK
#          consecutive probes, so one slow minute cannot restart a working API.
PROBE_TIMEOUT = 90          # was 15; a loaded box legitimately takes ~16 s
SOFT_STREAK = 3             # consecutive slow probes before a restart is earned


def _classify(exc_name: str) -> str:
    return "soft" if "Timeout" in exc_name else "hard"


def probe() -> int:
    failures: list[str] = []
    soft: list[str] = []
    try:
        r = requests.get(f"{SITE}/api/health", timeout=PROBE_TIMEOUT)
        if r.status_code != 200 or not r.json().get("ok"):
            failures.append(f"/api/health -> HTTP {r.status_code}")
    except Exception as e:  # noqa: BLE001
        name = type(e).__name__
        (soft if _classify(name) == "soft" else failures).append(f"/api/health -> {name}")
    try:
        r = requests.get(f"{SITE}/", timeout=PROBE_TIMEOUT)
        if r.status_code != 200:
            failures.append(f"/ -> HTTP {r.status_code}")
    except Exception as e:  # noqa: BLE001
        name = type(e).__name__
        (soft if _classify(name) == "soft" else failures).append(f"/ -> {name}")
    con = None
    try:
        con = connect()
        con.execute("SELECT 1").fetchone()
    except Exception as e:  # noqa: BLE001
        failures.append(f"database -> {type(e).__name__}")

    st = _state()

    # A soft-only result: the service answered, just slowly. Count it, alert,
    # and let systemd see success so nothing is restarted underneath a user.
    if soft and not failures:
        streak = int(st.get("soft_streak", 0)) + 1
        st["soft_streak"] = streak
        st["last_slow"] = {"at": _now(), "checks": soft}
        _save(st)
        print(f"SLOW ({streak}/{SOFT_STREAK}):", "; ".join(soft))
        if streak < SOFT_STREAK:
            _webhook({"event": "health_slow", "checks": soft, "streak": streak, "at": _now()})
            return 0
        # sustained slowness — treat it as a real failure from here
        failures = soft + [f"slow for {streak} consecutive probes"]
    elif not soft:
        st["soft_streak"] = 0

    if failures:
        st["failing_since"] = st.get("failing_since") or _now()
        st["last_failure"] = {"at": _now(), "checks": failures}
        _save(st)
        if con is not None:
            notifications.push(
                con, kind="ops", severity="critical", role="admin",
                title=f"Health check failing: {'; '.join(failures)[:120]}",
                body=f"Failing since {st['failing_since']}. systemd will restart the API once via OnFailure.",
                dedupe_key=f"ops-fail-{st['failing_since']}")
        _webhook({"event": "health_failed", "checks": failures, "since": st["failing_since"], "at": _now()})
        print("FAIL:", "; ".join(failures))
        return 1

    if st.get("failing_since"):
        since = st.pop("failing_since", None)
        _save(st)
        notifications.push(
            con, kind="ops", severity="info", role="admin",
            title="Health check recovered",
            body=f"All checks passing again (had been failing since {since}).",
            dedupe_key=f"ops-recovered-{since}")
        _webhook({"event": "health_recovered", "was_failing_since": since, "at": _now()})
    print("ok")
    return 0


# ------------------------------------------------------------------ daily
def _unit(name: str) -> str:
    try:
        out = subprocess.run(
            ["systemctl", "show", name, "-p", "ExecMainStatus", "-p", "ExecMainExitTimestamp"],
            capture_output=True, text=True, timeout=10).stdout
        kv = dict(l.split("=", 1) for l in out.strip().splitlines() if "=" in l)
        status = kv.get("ExecMainStatus", "?")
        at = kv.get("ExecMainExitTimestamp", "") or "never ran"
        return f"{name}: exit {status} · {at}"
    except Exception as e:  # noqa: BLE001
        return f"{name}: unreadable ({type(e).__name__})"


def _journal_errors() -> str:
    try:
        out = subprocess.run(
            ["journalctl", "-u", "company-brain", "--since", "-24h", "-p", "err", "-q", "--no-pager"],
            capture_output=True, text=True, timeout=15)
        if out.returncode != 0:
            return "journal unreadable (add the service user to systemd-journal)"
        n = len([l for l in out.stdout.splitlines() if l.strip()])
        return f"{n} error-level journal line(s) in 24h"
    except Exception as e:  # noqa: BLE001
        return f"journal scan failed ({type(e).__name__})"


def daily() -> int:
    du = shutil.disk_usage("/")
    disk_pct = round(du.used / du.total * 100)
    mem = Path("/proc/meminfo").read_text()
    kv = {l.split(":")[0]: int(l.split()[1]) for l in mem.splitlines() if ":" in l and l.split()[1].isdigit()}
    mem_free_pct = round(kv.get("MemAvailable", 0) / kv.get("MemTotal", 1) * 100)
    swap_used_mb = (kv.get("SwapTotal", 0) - kv.get("SwapFree", 0)) // 1024
    lines = [
        f"disk {disk_pct}% used · memory {mem_free_pct}% available · swap {swap_used_mb} MB in use",
        _unit("company-brain-watcher.service"),
        _unit("company-brain-backup.service"),
        _journal_errors(),
    ]
    bad = disk_pct > 85 or mem_free_pct < 10
    con = connect()
    notifications.push(
        con, kind="ops", severity="warning" if bad else "info", role="admin",
        title=("Ops digest — attention needed" if bad else "Ops digest — all quiet"),
        body="\n".join(lines),
        dedupe_key=f"ops-daily-{_now()[:10]}")
    if bad:
        _webhook({"event": "ops_digest_warning", "lines": lines, "at": _now()})
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "probe"
    raise SystemExit(probe() if cmd == "probe" else daily())
