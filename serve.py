#!/usr/bin/env python3
"""Serve the weed chart, with weed_chart.json as the shared source of truth.

The file stays plain, hand-editable JSON in the same shape the app exports.
Its revision is a hash of its bytes, so edits made directly to the file are
picked up by open browsers without any bookkeeping fields.

Endpoints alongside the page's own files:

    GET  /api/state             the whole document plus its revision
    PUT  /api/state             replace it - only if baseRevision still matches
    GET  /api/snapshots         dated copies kept before risky writes
    GET  /api/snapshots/<name>  one of those copies, for preview and restore
    GET  /api/lookup            ?url=<ocs.ca product link> -> prefilled fields
    GET  /api/research          topics, whether Claude is available, the current
                                run and the saved reports
    GET  /api/research/models   ?provider=claude|codex[&refresh=1] -> the CLI's models
                                and thinking levels (asks the CLI; sends no prompt)
    POST /api/research/jobs     start a run: {topic, query, depth, provider, model, effort}
    POST /api/research/cancel   stop the current run (what was read is kept)
    POST /api/research/resume   continue a paused run: {checkpoint, provider, model, effort}
    DELETE /api/research/checkpoints/<id>   discard a paused run
    POST /api/research/reports/<name>/archive   {archived: true|false}
    GET  /api/research/reports/<name>   one saved report
    DELETE /api/research/reports/<name>

Nothing else in the directory is served: not the data file, not .git, not
this script, not the backups.
"""

from __future__ import annotations

import argparse
import email.utils
import hashlib
import http.server
import json
import math
import re
import shutil
import socketserver
import threading
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import llm
import ocs
import research

DEFAULT_PORT = 3002
DEFAULT_HOST = "127.0.0.1"
DATA_FILE = "weed_chart.json"
BACKUP_DIR = "backups"
SCHEMA_VERSION = 2
MAX_BODY_BYTES = 16_000_000

# A snapshot is taken before any write that follows a quiet spell, and always
# before an import, restore or clear. Only the newest SNAPSHOT_LIMIT are kept.
SNAPSHOT_INTERVAL_SECONDS = 15 * 60
SNAPSHOT_LIMIT = 100
SNAPSHOT_REASONS = frozenset({"auto", "import", "restore", "clear", "migration"})
SNAPSHOT_NAME = re.compile(r"weed_chart-\d{8}T\d{12}Z-[a-z]+\.json")

# The only files a browser may fetch, and the type each is served as.
STATIC_FILES: dict[str, tuple[str, str]] = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/core.js": ("core.js", "text/javascript; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/research.js": ("research.js", "text/javascript; charset=utf-8"),
    "/sw.js": ("sw.js", "text/javascript; charset=utf-8"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
    "/fonts/bricolage-grotesque-latin.woff2": ("fonts/bricolage-grotesque-latin.woff2", "font/woff2"),
}

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
    ),
}

COLLECTIONS = ("products", "wishlist", "experiences", "trash")


class ReusableTcpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class DataFileError(Exception):
    """The data file exists but could not be parsed."""


# ── The data file ──────────────────────────────────────────────────────────


def revision_of(data_path: Path) -> str:
    """An opaque revision: a hash of the file's bytes, or "" if there is none.

    A content hash rather than the mtime, because two writes inside one clock
    tick would otherwise share a revision and let a stale client through.
    """
    try:
        return hashlib.sha256(data_path.read_bytes()).hexdigest()[:20]
    except FileNotFoundError:
        return ""
    except OSError as error:
        raise DataFileError(f"cannot read {data_path.name}: {error}") from error


def reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


def load_json(text: str) -> Any:
    return json.loads(text, parse_constant=reject_constant)


def read_raw(data_path: Path) -> dict[str, Any] | None:
    """Return the file as a dict, None if it does not exist.

    A bare list is still accepted: that was the original export shape.
    """
    if not data_path.exists():
        return None

    try:
        data = load_json(data_path.read_text(encoding="utf-8"))
    except OSError as error:
        raise DataFileError(f"cannot read {data_path.name}: {error}") from error
    except (json.JSONDecodeError, ValueError) as error:
        raise DataFileError(f"{data_path.name} is not valid JSON: {error}") from error

    if isinstance(data, list):
        return {"products": data}

    if isinstance(data, dict) and (isinstance(data.get("products"), list) or isinstance(data.get("wishlist"), list)):
        return data

    raise DataFileError(f"{data_path.name} has no 'products' list")


def as_state(raw: dict[str, Any] | None) -> dict[str, Any]:
    """The document as the API returns it: every collection present."""
    raw = raw or {}
    state: dict[str, Any] = {"datasetId": raw.get("datasetId") if isinstance(raw.get("datasetId"), str) else None}

    for name in COLLECTIONS:
        value = raw.get(name)
        state[name] = value if isinstance(value, list) else []

    settings = raw.get("settings")
    state["settings"] = settings if isinstance(settings, dict) else {}
    return state


def write_state(data_path: Path, state: dict[str, Any]) -> None:
    payload = {
        "version": SCHEMA_VERSION,
        "datasetId": state.get("datasetId") or str(uuid.uuid4()),
        "exportedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }

    for name in COLLECTIONS:
        payload[name] = state.get(name) or []

    payload["settings"] = state.get("settings") or {}

    temporary_path = data_path.with_suffix(data_path.suffix + ".tmp")
    with temporary_path.open("w", encoding="utf-8") as data_file:
        json.dump(payload, data_file, indent=2, ensure_ascii=False)
        data_file.write("\n")

    temporary_path.replace(data_path)


# ── Snapshots ─────────────────────────────────────────────────────────────


def list_snapshots(backup_dir: Path) -> list[Path]:
    if not backup_dir.is_dir():
        return []

    return sorted(
        (path for path in backup_dir.iterdir() if SNAPSHOT_NAME.fullmatch(path.name)),
        key=lambda path: path.name,
        reverse=True,
    )


def snapshot_created_at(path: Path) -> datetime | None:
    stamp = path.name.split("-")[1]
    try:
        return datetime.strptime(stamp, "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def take_snapshot(data_path: Path, backup_dir: Path, reason: str, *, force: bool) -> Path | None:
    """Copy the data file aside before it is replaced.

    Without `force`, only when the newest snapshot is older than the interval,
    so a burst of small edits costs one snapshot rather than hundreds.
    """
    if not data_path.exists():
        return None

    existing = list_snapshots(backup_dir)
    if not force and existing:
        newest = snapshot_created_at(existing[0])
        if newest and (datetime.now(timezone.utc) - newest).total_seconds() < SNAPSHOT_INTERVAL_SECONDS:
            return None

    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    target = backup_dir / f"weed_chart-{stamp}-{reason}.json"
    shutil.copy2(data_path, target)

    for old in list_snapshots(backup_dir)[SNAPSHOT_LIMIT:]:
        old.unlink(missing_ok=True)

    return target


def describe_snapshot(path: Path) -> dict[str, Any]:
    created = snapshot_created_at(path)
    summary: dict[str, Any] = {
        "name": path.name,
        "createdAt": created.isoformat().replace("+00:00", "Z") if created else None,
        "reason": path.stem.rsplit("-", 1)[-1],
        "bytes": path.stat().st_size,
    }

    try:
        state = as_state(read_raw(path))
        summary["counts"] = {name: len(state[name]) for name in ("products", "wishlist", "experiences")}
    except DataFileError:
        summary["counts"] = None

    return summary


# ── Validation ────────────────────────────────────────────────────────────

URL_FIELDS = frozenset({"sourceUrl", "url", "image"})
LIST_FIELDS = frozenset({"tags", "terpenes", "sizes", "effects"})
NUMBER_FIELDS = frozenset(
    {"thc", "cbd", "terpenePercent", "price", "rating", "targetPrice", "thcMin", "thcMax", "cbdMin", "cbdMax"}
)
MAX_STRING = 10_000
MAX_RECORDS = 10_000


def check_value(key: str, value: Any, where: str, problems: list[str]) -> None:
    if key in URL_FIELDS:
        if not isinstance(value, str) or (value and urllib.parse.urlparse(value).scheme not in ("http", "https")):
            problems.append(f"{where}.{key} must be an http(s) link")
        return

    if key in NUMBER_FIELDS:
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            problems.append(f"{where}.{key} must be a number or null")
        return

    if key in LIST_FIELDS and isinstance(value, list):
        if len(value) > 50 or not all(isinstance(item, str) and len(item) <= 200 for item in value):
            problems.append(f"{where}.{key} must be a short list of short strings")
        return

    if value is None or isinstance(value, bool):
        return

    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            problems.append(f"{where}.{key} must be finite")
        return

    if isinstance(value, str):
        if len(value) > MAX_STRING:
            problems.append(f"{where}.{key} is longer than {MAX_STRING} characters")
        return

    problems.append(f"{where}.{key} has an unsupported type")


def check_record(record: Any, where: str, problems: list[str], *, needs_name: bool) -> str | None:
    if not isinstance(record, dict):
        problems.append(f"{where} is not an object")
        return None

    record_id = record.get("id")
    if not isinstance(record_id, str) or not 0 < len(record_id) <= 100:
        problems.append(f"{where}.id must be a string of 1-100 characters")
        record_id = None

    if needs_name:
        name = record.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            problems.append(f"{where}.name must be non-empty text of at most 200 characters")

    for key, value in record.items():
        if key == "item":
            continue
        check_value(key, value, where, problems)

    return record_id


def validate_state(incoming: Any) -> tuple[dict[str, Any] | None, list[str]]:
    """Check a PUT body. Returns (state, problems); state is None if rejected."""
    problems: list[str] = []

    if not isinstance(incoming, dict):
        return None, ["expected a JSON object"]

    if not isinstance(incoming.get("products"), list):
        return None, ["expected a 'products' list"]

    state: dict[str, Any] = {}
    for name in COLLECTIONS:
        records = incoming.get(name, [])
        if not isinstance(records, list):
            problems.append(f"'{name}' must be a list")
            continue

        if len(records) > MAX_RECORDS:
            problems.append(f"'{name}' has more than {MAX_RECORDS} records")
            continue

        seen: set[str] = set()
        for index, record in enumerate(records):
            where = f"{name}[{index}]"
            record_id = check_record(record, where, problems, needs_name=name in ("products", "wishlist"))

            if name == "trash" and isinstance(record, dict):
                kind = record.get("kind")
                if kind not in ("product", "wishlist", "experience"):
                    problems.append(f"{where}.kind is not a known record kind")
                check_record(record.get("item"), f"{where}.item", problems, needs_name=kind in ("product", "wishlist"))

            key = f"{record.get('kind')}:{record_id}" if name == "trash" and isinstance(record, dict) else record_id
            if key is not None:
                if key in seen:
                    problems.append(f"{where}.id is used twice")
                seen.add(key)

            if len(problems) >= 20:
                return None, problems

        state[name] = records

    settings = incoming.get("settings", {})
    if not isinstance(settings, dict):
        problems.append("'settings' must be an object")
    else:
        for key, value in settings.items():
            check_value(key, value, "settings", problems)
        state["settings"] = settings

    return (None, problems) if problems else (state, [])


# ── HTTP ──────────────────────────────────────────────────────────────────


def make_handler(site_dir: Path, data_path: Path, backup_dir: Path, research_dir: Path | None = None):
    state_lock = threading.Lock()
    research_dir = research_dir or data_path.parent / "research"
    jobs = research.Jobs(research_dir)

    def ensure_dataset() -> tuple[dict[str, Any], str, bool]:
        """Read the file, giving it a datasetId (after a snapshot) if it lacks one.

        The id lets a browser tell "this collection was deliberately emptied"
        apart from "this is a brand-new server", so a stale device cannot
        resurrect data that was cleared on purpose. Call with state_lock held.
        """
        raw = read_raw(data_path)
        if raw is None:
            return as_state(None), "", False

        state = as_state(raw)
        if not state["datasetId"] or raw.get("version") != SCHEMA_VERSION:
            take_snapshot(data_path, backup_dir, "migration", force=True)
            state["datasetId"] = state["datasetId"] or str(uuid.uuid4())
            write_state(data_path, state)

        return state, revision_of(data_path), True

    class WeedHandler(http.server.BaseHTTPRequestHandler):
        server_version = "Cloudline/2"

        # ── routing ──

        def do_GET(self) -> None:
            self.route(head=False)

        def do_HEAD(self) -> None:
            self.route(head=True)

        def route(self, *, head: bool) -> None:
            path = urllib.parse.urlparse(self.path).path

            if path == "/api/state":
                self.send_state()
            elif path == "/api/snapshots":
                self.send_snapshot_list()
            elif path.startswith("/api/snapshots/"):
                self.send_snapshot(path.removeprefix("/api/snapshots/"))
            elif path == "/api/lookup":
                self.send_lookup()
            elif path == "/api/research":
                self.send_research_overview()
            elif path == "/api/research/models":
                self.send_models()
            elif path.startswith("/api/research/reports/"):
                self.send_report(path.removeprefix("/api/research/reports/"))
            elif path in STATIC_FILES:
                self.send_static(*STATIC_FILES[path], head=head)
            else:
                self.send_json({"error": "Not found"}, status=404)

        def do_PUT(self) -> None:
            if urllib.parse.urlparse(self.path).path != "/api/state":
                self.send_json({"error": "Not found"}, status=404)
                return

            self.save_state()

        def do_POST(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/research/jobs":
                if self.same_origin():
                    self.start_research()
            elif path.startswith("/api/research/reports/") and path.endswith("/archive"):
                if self.same_origin():
                    self.archive_report(urllib.parse.unquote(path.removeprefix("/api/research/reports/").removesuffix("/archive")))
            elif path == "/api/research/resume":
                if self.same_origin():
                    self.resume_research()
            elif path == "/api/research/cancel":
                if self.same_origin():
                    jobs.stop()
                    self.send_json({"job": jobs.snapshot()})
            else:
                self.do_PUT()

        def do_DELETE(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            if path.startswith("/api/research/checkpoints/"):
                if self.same_origin():
                    self.discard_checkpoint(urllib.parse.unquote(path.removeprefix("/api/research/checkpoints/")))
                return
            if not path.startswith("/api/research/reports/"):
                self.send_json({"error": "Not found"}, status=404)
            elif self.same_origin():
                name = urllib.parse.unquote(path.removeprefix("/api/research/reports/"))
                if research.delete_report(research_dir, name):
                    self.send_json({"deleted": name})
                else:
                    self.send_json({"error": "Not found"}, status=404)

        def same_origin(self) -> bool:
            """Refuse requests another site's page makes on the visitor's behalf.

            A research run spends the owner's Claude usage, so a random web
            page must not be able to start one through the browser.
            """
            site = self.headers.get("Sec-Fetch-Site")
            origin = self.headers.get("Origin")
            host = self.headers.get("Host", "")
            if site and site not in ("same-origin", "none"):
                ok = False
            elif origin:
                ok = urllib.parse.urlparse(origin).netloc == host
            else:
                ok = True
            if not ok:
                self.send_json({"error": "Cross-site request refused."}, status=403)
            return ok

        # ── static files ──

        def send_static(self, name: str, content_type: str, *, head: bool) -> None:
            path = site_dir / name
            try:
                stat = path.stat()
                body = b"" if head else path.read_bytes()
            except OSError:
                self.send_json({"error": "Not found"}, status=404)
                return

            last_modified = email.utils.formatdate(stat.st_mtime, usegmt=True)
            since = self.headers.get("If-Modified-Since")
            if since:
                try:
                    if int(stat.st_mtime) <= email.utils.parsedate_to_datetime(since).timestamp():
                        self.send_response(304)
                        self.send_header("Last-Modified", last_modified)
                        self.send_header("Cache-Control", "no-cache")
                        self.end_headers()
                        return
                except (TypeError, ValueError, OverflowError):
                    pass

            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(stat.st_size))
            self.send_header("Last-Modified", last_modified)
            # Assets are edited in place, so a browser must never hold a stale
            # copy. "no-cache" still allows the 304 above.
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if not head:
                self.wfile.write(body)

        # ── state ──

        def state_payload(self, state: dict[str, Any], revision: str, exists: bool) -> dict[str, Any]:
            return {"schema": SCHEMA_VERSION, "exists": exists, "revision": revision, **state}

        def send_state(self) -> None:
            with state_lock:
                try:
                    state, revision, exists = ensure_dataset()
                except DataFileError as error:
                    # Never report "empty" for a broken file: the browser would
                    # happily sync that emptiness back and destroy the data.
                    self.send_json({"error": str(error)}, status=500)
                    return

            self.send_json(self.state_payload(state, revision, exists))

        def save_state(self) -> None:
            incoming = self.read_json_body()
            if incoming is None:
                return

            state, problems = validate_state(incoming)
            if state is None:
                self.send_json({"error": "The data was rejected.", "problems": problems}, status=400)
                return

            base_revision = incoming.get("baseRevision")
            reason = incoming.get("reason") if incoming.get("reason") in SNAPSHOT_REASONS else "auto"

            with state_lock:
                try:
                    current, revision, exists = ensure_dataset()
                except DataFileError as error:
                    self.send_json({"error": str(error)}, status=500)
                    return

                # Someone else wrote since this client last read: hand back the
                # newer copy so the client can merge and try again.
                if not isinstance(base_revision, str) or base_revision != revision:
                    self.send_json(
                        {"error": "conflict", "state": self.state_payload(current, revision, exists)},
                        status=409,
                    )
                    return

                state["datasetId"] = current["datasetId"] or str(uuid.uuid4())
                take_snapshot(data_path, backup_dir, reason, force=reason != "auto")
                write_state(data_path, state)
                revision = revision_of(data_path)

            self.send_json(self.state_payload(state, revision, True))

        # ── snapshots ──

        def send_snapshot_list(self) -> None:
            with state_lock:
                snapshots = [describe_snapshot(path) for path in list_snapshots(backup_dir)]

            self.send_json({"snapshots": snapshots})

        def send_snapshot(self, name: str) -> None:
            name = urllib.parse.unquote(name)
            if not SNAPSHOT_NAME.fullmatch(name):
                self.send_json({"error": "Not found"}, status=404)
                return

            path = backup_dir / name
            try:
                state = as_state(read_raw(path))
            except DataFileError as error:
                self.send_json({"error": str(error)}, status=500)
                return

            if not path.exists():
                self.send_json({"error": "Not found"}, status=404)
                return

            self.send_json({"snapshot": describe_snapshot(path), "state": state})

        # ── lookup ──

        def send_lookup(self) -> None:
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            url = (query.get("url") or [""])[0]

            try:
                item = ocs.lookup(url)
            except ocs.LinkError as error:
                self.send_json({"error": str(error)}, status=error.status)
                return

            item["lookedUpAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            self.send_json({"item": item})

        # ── research ──

        def send_research_overview(self) -> None:
            self.send_json({
                "topics": research.topic_list(),
                "depths": {name: {"days": d["days"], "threads": d["threads"], "mode": d["mode"]}
                           for name, d in research.DEPTHS.items()},
                "llm": {k: v for k, v in research.llm_status().items() if k != "providers"},
                "providers": llm.status(),
                "job": jobs.snapshot(),
                "reports": research.list_reports(research_dir),
                "checkpoints": research.list_checkpoints(research_dir),
            })

        def send_models(self) -> None:
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            provider = (query.get("provider") or [""])[0]
            if provider not in llm.PROVIDERS:
                self.send_json({"error": "Unknown provider."}, status=400)
                return
            self.send_json({"provider": provider, **llm.models(provider, refresh=(query.get("refresh") or [""])[0] == "1")})

        def send_report(self, name: str) -> None:
            document = research.read_report(research_dir, urllib.parse.unquote(name))
            if document is None:
                self.send_json({"error": "Not found"}, status=404)
            else:
                self.send_json({"name": name, "report": document})

        def archive_report(self, name: str) -> None:
            body = self.read_json_body()
            if body is None:
                return
            archived = isinstance(body, dict) and body.get("archived") is True
            if research.set_archived(research_dir, name, archived):
                self.send_json({"name": name, "archived": archived})
            else:
                self.send_json({"error": "Not found"}, status=404)

        def resume_research(self) -> None:
            body = self.read_json_body()
            if body is None:
                return
            if not isinstance(body, dict) or not isinstance(body.get("checkpoint"), str):
                self.send_json({"error": "Which run should continue?"}, status=400)
                return
            provider = body.get("provider") if body.get("provider") in llm.PROVIDERS else ""
            model = body.get("model") if isinstance(body.get("model"), str) else ""
            effort = body.get("effort") if isinstance(body.get("effort"), str) else ""
            try:
                job = jobs.resume(body["checkpoint"], provider or "none", model, effort)
            except ValueError as error:
                self.send_json({"error": str(error)}, status=400)
                return
            except RuntimeError as error:
                self.send_json({"error": str(error), "job": jobs.snapshot()}, status=409)
                return
            self.send_json({"job": job}, status=202)

        def discard_checkpoint(self, name: str) -> None:
            current = jobs.snapshot()
            if current and current["status"] == "running" and current.get("checkpoint") == name:
                self.send_json({"error": "That run is going right now; stop it first."}, status=409)
            elif research.delete_checkpoint(research_dir, name):
                self.send_json({"deleted": name})
            else:
                self.send_json({"error": "Not found"}, status=404)

        def start_research(self) -> None:
            body = self.read_json_body()
            if body is None:
                return
            if not isinstance(body, dict):
                self.send_json({"error": "expected a JSON object"}, status=400)
                return

            topic = body.get("topic") if isinstance(body.get("topic"), str) else ""
            query = body.get("query") if isinstance(body.get("query"), str) else ""
            depth = body.get("depth") if isinstance(body.get("depth"), str) else "quick"
            provider = body.get("provider")
            if provider not in (*llm.PROVIDERS, "none"):
                # Pages from before providers existed send {"llm": true|false}.
                provider = "claude" if body.get("llm") is not False else "none"
            model = body.get("model") if isinstance(body.get("model"), str) else ""
            effort = body.get("effort") if isinstance(body.get("effort"), str) else ""
            try:
                job = jobs.start(topic, query[:120], depth, provider, model, effort)
            except ValueError as error:
                self.send_json({"error": str(error)}, status=400)
                return
            except RuntimeError as error:
                self.send_json({"error": str(error), "job": jobs.snapshot()}, status=409)
                return
            self.send_json({"job": job}, status=202)

        # ── plumbing ──

        def read_json_body(self) -> Any:
            """Decode the request body, answering the client on any failure."""
            try:
                content_length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self.send_json({"error": "Missing or invalid Content-Length"}, status=411)
                return None

            if content_length < 0:
                self.send_json({"error": "Invalid Content-Length"}, status=400)
                return None

            if content_length > MAX_BODY_BYTES:
                self.send_json({"error": "Payload too large"}, status=413)
                return None

            try:
                body = self.rfile.read(content_length).decode("utf-8")
                return load_json(body or "{}")
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
                self.send_json({"error": "Invalid JSON"}, status=400)
                return None

        def end_headers(self) -> None:
            for header, value in SECURITY_HEADERS.items():
                self.send_header(header, value)

            super().end_headers()

        def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(encoded)

        def log_message(self, format: str, *args: Any) -> None:
            # Lookups carry product links in the query string; keep the log to
            # the method, path and status.
            if args and isinstance(args[0], str):
                args = (args[0].split("?", 1)[0], *args[1:])
            super().log_message(format, *args)

    return WeedHandler


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the weed chart.")
    parser.add_argument("-p", "--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--data", type=Path, help=f"data file (default: {DATA_FILE} next to this script)")
    parser.add_argument("--backups", type=Path, help=f"snapshot folder (default: {BACKUP_DIR}/ next to the data file)")
    parser.add_argument("--research", type=Path, help="research reports and cache (default: research/ next to the data file)")
    args = parser.parse_args()

    site_dir = Path(__file__).resolve().parent
    data_path = (args.data or site_dir / DATA_FILE).resolve()
    backup_dir = (args.backups or data_path.parent / BACKUP_DIR).resolve()
    research_dir = (args.research or data_path.parent / "research").resolve()
    handler = make_handler(site_dir, data_path, backup_dir, research_dir)

    with ReusableTcpServer((args.host, args.port), handler) as server:
        print(f"Serving weed chart on http://{args.host}:{args.port}/")
        print(f"Data file: {data_path}")
        print(f"Snapshots: {backup_dir}")
        print(f"Research: {research_dir}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
