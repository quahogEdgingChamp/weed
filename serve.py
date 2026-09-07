#!/usr/bin/env python3
"""Serve the weed chart, with weed_chart.json as the shared source of truth.

The file stays plain, hand-editable JSON in the same shape the app exports.
Its mtime doubles as the revision, so edits made directly to the file are
picked up by open browsers without any bookkeeping fields.
"""

from __future__ import annotations

import argparse
import http.server
import json
import socketserver
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_PORT = 3002
DEFAULT_HOST = "127.0.0.1"
DATA_FILE = "weed_chart.json"


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


def read_products(data_path: Path) -> list[Any]:
    if not data_path.exists():
        return []

    try:
        with data_path.open("r", encoding="utf-8") as data_file:
            data = json.load(data_file)
    except OSError as error:
        raise DataFileError(f"cannot read {DATA_FILE}: {error}") from error
    except json.JSONDecodeError as error:
        raise DataFileError(f"{DATA_FILE} is not valid JSON: {error}") from error

    if isinstance(data, list):
        return data

    if isinstance(data, dict) and isinstance(data.get("products"), list):
        return data["products"]

    raise DataFileError(f"{DATA_FILE} has no 'products' list")


def write_products(data_path: Path, products: list[Any]) -> None:
    payload = {
        "version": 1,
        "exportedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "products": products,
    }

    temporary_path = data_path.with_suffix(data_path.suffix + ".tmp")
    with temporary_path.open("w", encoding="utf-8") as data_file:
        json.dump(payload, data_file, indent=2)
        data_file.write("\n")

    temporary_path.replace(data_path)


def make_handler(site_dir: Path, data_path: Path):
    state_lock = threading.Lock()

    class WeedHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(site_dir), **kwargs)

        def do_GET(self) -> None:
            if self.path == "/api/state":
                self.send_state()
                return

            super().do_GET()

        def do_PUT(self) -> None:
            self.save_state()

        def do_POST(self) -> None:
            self.save_state()

        def send_state(self) -> None:
            with state_lock:
                try:
                    products = read_products(data_path)
                except DataFileError as error:
                    # Never report "empty" for a broken file: the browser would
                    # happily sync that emptiness back and destroy the data.
                    self.send_error(500, str(error))
                    return

                revision = revision_of(data_path)

            self.send_json({"products": products, "revision": revision})

        def save_state(self) -> None:
            if self.path != "/api/state":
                self.send_error(404)
                return

            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error(400, "Invalid Content-Length")
                return

            try:
                body = self.rfile.read(content_length).decode("utf-8")
                incoming = json.loads(body or "{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_error(400, "Invalid JSON")
                return

            products = incoming.get("products") if isinstance(incoming, dict) else incoming
            if not isinstance(products, list):
                self.send_error(400, "Expected a 'products' list")
                return

            with state_lock:
                write_products(data_path, products)
                revision = revision_of(data_path)

            self.send_json({"products": products, "revision": revision})

        def end_headers(self) -> None:
            # Static assets are edited in place, so a browser must never hold a
            # stale copy. "no-cache" still allows 304s via Last-Modified.
            if not getattr(self, "_cache_control_sent", False):
                self.send_header("Cache-Control", "no-cache")

            super().end_headers()

        def send_json(self, payload: dict[str, Any]) -> None:
            self._cache_control_sent = True
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(200)
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
