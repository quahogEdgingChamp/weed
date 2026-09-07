#!/usr/bin/env python3
"""Serve the weed chart, with weed_chart.json as the shared source of truth.

The file stays plain, hand-editable JSON in the same shape the app exports.
Its mtime doubles as the revision, so edits made directly to the file are
picked up by open browsers without any bookkeeping fields.

Two endpoints sit alongside the static files:

    GET/PUT /api/state   the collection and the shopping list
    GET     /api/lookup  ?url=<ocs.ca product link> -> prefilled fields
"""

from __future__ import annotations

import argparse
import http.server
import json
import socketserver
import threading
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import ocs

DEFAULT_PORT = 3002
DEFAULT_HOST = "127.0.0.1"
DATA_FILE = "weed_chart.json"
MAX_BODY_BYTES = 16_000_000


class ReusableTcpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class DataFileError(Exception):
    """The data file exists but could not be parsed."""


def revision_of(data_path: Path) -> int:
    try:
        return data_path.stat().st_mtime_ns
    except OSError:
        return 0


def read_state(data_path: Path) -> tuple[list[Any], list[Any]]:
    """Return (products, wishlist) from the data file.

    A bare list is still accepted: that was the original export shape, and a
    hand-written file is allowed to leave "wishlist" out entirely.
    """
    if not data_path.exists():
        return [], []

    try:
        with data_path.open("r", encoding="utf-8") as data_file:
            data = json.load(data_file)
    except OSError as error:
        raise DataFileError(f"cannot read {DATA_FILE}: {error}") from error
    except json.JSONDecodeError as error:
        raise DataFileError(f"{DATA_FILE} is not valid JSON: {error}") from error

    if isinstance(data, list):
        return data, []

    if isinstance(data, dict) and isinstance(data.get("products"), list):
        wishlist = data.get("wishlist")
        return data["products"], wishlist if isinstance(wishlist, list) else []

    raise DataFileError(f"{DATA_FILE} has no 'products' list")


def write_state(data_path: Path, products: list[Any], wishlist: list[Any]) -> None:
    payload = {
        "version": 1,
        "exportedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "products": products,
        "wishlist": wishlist,
    }

    temporary_path = data_path.with_suffix(data_path.suffix + ".tmp")
    with temporary_path.open("w", encoding="utf-8") as data_file:
        json.dump(payload, data_file, indent=2, ensure_ascii=False)
        data_file.write("\n")

    temporary_path.replace(data_path)


def make_handler(site_dir: Path, data_path: Path):
    state_lock = threading.Lock()

    class WeedHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(site_dir), **kwargs)

        def do_GET(self) -> None:
            route = urllib.parse.urlparse(self.path).path

            if route == "/api/state":
                self.send_state()
                return

            if route == "/api/lookup":
                self.send_lookup()
                return

            super().do_GET()

        def do_PUT(self) -> None:
            self.save_state()

        def do_POST(self) -> None:
            self.save_state()

        def send_state(self) -> None:
            with state_lock:
                try:
                    products, wishlist = read_state(data_path)
                except DataFileError as error:
                    # Never report "empty" for a broken file: the browser would
                    # happily sync that emptiness back and destroy the data.
                    self.send_error(500, str(error))
                    return

                revision = revision_of(data_path)

            self.send_json({"products": products, "wishlist": wishlist, "revision": revision})

        def send_lookup(self) -> None:
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            url = (query.get("url") or [""])[0]

            try:
                item = ocs.lookup(url)
            except ocs.LinkError as error:
                self.send_json({"error": str(error)}, status=error.status)
                return

            self.send_json({"item": item})

        def save_state(self) -> None:
            if urllib.parse.urlparse(self.path).path != "/api/state":
                self.send_error(404)
                return

            incoming = self.read_json_body()
            if incoming is None:
                return

            products = incoming.get("products") if isinstance(incoming, dict) else incoming
            if not isinstance(products, list):
                self.send_error(400, "Expected a 'products' list")
                return

            wishlist = incoming.get("wishlist") if isinstance(incoming, dict) else []
            if not isinstance(wishlist, list):
                wishlist = []

            with state_lock:
                write_state(data_path, products, wishlist)
                revision = revision_of(data_path)

            self.send_json({"products": products, "wishlist": wishlist, "revision": revision})

        def read_json_body(self) -> Any:
            """Decode the request body, answering the client on any failure."""
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error(400, "Invalid Content-Length")
                return None

            if content_length > MAX_BODY_BYTES:
                self.send_error(413, "Payload too large")
                return None

            try:
                body = self.rfile.read(content_length).decode("utf-8")
                return json.loads(body or "{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_error(400, "Invalid JSON")
                return None

        def end_headers(self) -> None:
            # Static assets are edited in place, so a browser must never hold a
            # stale copy. "no-cache" still allows 304s via Last-Modified.
            if not getattr(self, "_cache_control_sent", False):
                self.send_header("Cache-Control", "no-cache")

            super().end_headers()

        def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
            self._cache_control_sent = True
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(encoded)

    return WeedHandler


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the weed chart.")
    parser.add_argument("-p", "--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    args = parser.parse_args()

    site_dir = Path(__file__).resolve().parent
    data_path = site_dir / DATA_FILE
    handler = make_handler(site_dir, data_path)

    with ReusableTcpServer((args.host, args.port), handler) as server:
        print(f"Serving weed chart on http://{args.host}:{args.port}/")
        print(f"Data file: {data_path}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
