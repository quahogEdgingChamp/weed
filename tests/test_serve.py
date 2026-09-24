"""Run with: python3 -m unittest discover tests

Every test runs a real server on a free port against a temporary data file,
never the live weed_chart.json.
"""

from __future__ import annotations

import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import serve  # noqa: E402


class ServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data = root / "weed_chart.json"
        self.backups = root / "backups"
        site = Path(serve.__file__).resolve().parent
        handler = serve.make_handler(site, self.data, self.backups)
        handler.log_message = lambda *args: None
        self.server = serve.ReusableTcpServer(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def request(self, method: str, path: str, body: object | None = None, raw: bytes | None = None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        connection.request(method, path, body=payload, headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        data = response.read()
        connection.close()
        try:
            parsed = json.loads(data) if data else None
        except json.JSONDecodeError:
            parsed = None
        return response.status, parsed, response

    def put(self, revision: str, products=None, **extra):
        body = {"baseRevision": revision, "products": products or [], "wishlist": [], **extra}
        return self.request("PUT", "/api/state", body)

    def test_empty_server_reports_missing_file(self) -> None:
        status, body, _ = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertFalse(body["exists"])
        self.assertEqual(body["revision"], "")
        self.assertEqual(body["schema"], 2)

    def test_write_then_conflict_on_stale_revision(self) -> None:
        status, first, _ = self.put("", [{"id": "a", "name": "A"}])
        self.assertEqual(status, 200)
        self.assertTrue(first["datasetId"])

        status, second, _ = self.put(first["revision"], [{"id": "a", "name": "A2"}])
        self.assertEqual(status, 200)

        # A client still holding the first revision must be refused, and told
        # what the current state is.
        status, conflict, _ = self.put(first["revision"], [{"id": "a", "name": "stale"}])
        self.assertEqual(status, 409)
        self.assertEqual(conflict["state"]["products"][0]["name"], "A2")
        self.assertEqual(conflict["state"]["revision"], second["revision"])
        self.assertEqual(json.loads(self.data.read_text())["products"][0]["name"], "A2")

    def test_missing_base_revision_is_a_conflict(self) -> None:
        self.put("", [{"id": "a", "name": "A"}])
        status, _, _ = self.request("PUT", "/api/state", {"products": []})
        self.assertEqual(status, 409)

    def test_dataset_id_survives_clearing(self) -> None:
        _, first, _ = self.put("", [{"id": "a", "name": "A"}])
        _, cleared, _ = self.put(first["revision"], [], reason="clear")
        self.assertEqual(cleared["datasetId"], first["datasetId"])
        _, state, _ = self.request("GET", "/api/state")
        self.assertTrue(state["exists"])
        self.assertEqual(state["products"], [])

    def test_hand_edits_change_the_revision(self) -> None:
        _, first, _ = self.put("", [{"id": "a", "name": "A"}])
        doc = json.loads(self.data.read_text())
        doc["products"][0]["name"] = "Edited by hand"
        self.data.write_text(json.dumps(doc))
        _, state, _ = self.request("GET", "/api/state")
        self.assertNotEqual(state["revision"], first["revision"])
        self.assertEqual(state["products"][0]["name"], "Edited by hand")

    def test_v1_file_is_migrated_after_a_snapshot(self) -> None:
        self.data.write_text(json.dumps({"version": 1, "products": [{"id": "a", "name": "A"}], "wishlist": []}))
        _, state, _ = self.request("GET", "/api/state")
        self.assertTrue(state["datasetId"])
        self.assertEqual(json.loads(self.data.read_text())["version"], 2)
        snapshots = list(self.backups.glob("*-migration.json"))
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(json.loads(snapshots[0].read_text())["version"], 1)

    def test_bare_list_file_still_loads(self) -> None:
        self.data.write_text(json.dumps([{"id": "a", "name": "A"}]))
        _, state, _ = self.request("GET", "/api/state")
        self.assertEqual(state["products"][0]["name"], "A")

    def test_broken_file_is_an_error_not_empty(self) -> None:
        self.data.write_text("{ not json")
        status, body, _ = self.request("GET", "/api/state")
        self.assertEqual(status, 500)
        status, _, _ = self.put("", [])
        self.assertEqual(status, 500)
        self.assertEqual(self.data.read_text(), "{ not json")

    def test_validation_rejects_bad_records(self) -> None:
        _, first, _ = self.put("", [{"id": "a", "name": "A"}])
        cases = [
            [{"id": "b", "name": ""}],
            [{"id": "b", "name": "B", "sourceUrl": "javascript:alert(1)"}],
            [{"id": "b", "name": "B", "price": "12"}],
            [{"id": "b", "name": "B"}, {"id": "b", "name": "dup"}],
            [{"name": "no id"}],
            [{"id": "b", "name": "B", "notes": "x" * 20001}],
            [{"id": "b", "name": "B", "nested": {"a": 1}}],
        ]
        for products in cases:
            with self.subTest(products=str(products)[:60]):
                status, body, _ = self.put(first["revision"], products)
                self.assertEqual(status, 400)
                self.assertTrue(body["problems"])
        self.assertEqual(json.loads(self.data.read_text())["products"][0]["name"], "A")

    def test_trash_items_are_validated(self) -> None:
        trash = [{"id": "x", "kind": "product", "deletedAt": "2026-01-01", "position": 0, "item": {"id": "x", "name": "X"}}]
        status, _, _ = self.put("", [], trash=trash)
        self.assertEqual(status, 200)
        bad = [{"id": "x", "kind": "spell", "item": {"id": "x", "name": "X"}}]
        _, state, _ = self.request("GET", "/api/state")
        status, _, _ = self.put(state["revision"], [], trash=bad)
        self.assertEqual(status, 400)

    def test_nan_and_negative_length_are_rejected(self) -> None:
        status, _, _ = self.request("PUT", "/api/state", raw=b'{"baseRevision": "", "products": [], "x": NaN}')
        self.assertEqual(status, 400)
        status, _, _ = self.request("PUT", "/api/state", raw=b"{}", headers={"Content-Length": "-1"})
        self.assertEqual(status, 400)

    def test_snapshots_before_risky_writes(self) -> None:
        _, first, _ = self.put("", [{"id": "a", "name": "A"}])
        self.assertEqual(list(self.backups.glob("*.json")), [])  # nothing to copy yet
        _, second, _ = self.put(first["revision"], [{"id": "b", "name": "B"}], reason="import")
        _, third, _ = self.put(second["revision"], [], reason="clear")

        status, listing, _ = self.request("GET", "/api/snapshots")
        self.assertEqual(status, 200)
        reasons = [item["reason"] for item in listing["snapshots"]]
        self.assertEqual(reasons, ["clear", "import"])

        name = listing["snapshots"][1]["name"]
        status, snapshot, _ = self.request("GET", f"/api/snapshots/{name}")
        self.assertEqual(status, 200)
        self.assertEqual(snapshot["state"]["products"][0]["name"], "A")

    def test_auto_snapshots_are_throttled(self) -> None:
        _, state, _ = self.put("", [{"id": "a", "name": "A"}])
        for index in range(5):
            _, state, _ = self.put(state["revision"], [{"id": "a", "name": f"A{index}"}])
        self.assertEqual(len(list(self.backups.glob("*-auto.json"))), 1)

    def test_snapshot_names_are_checked(self) -> None:
        for name in ["../weed_chart.json", "..%2Fweed_chart.json", "weed_chart-x.json"]:
            status, _, _ = self.request("GET", f"/api/snapshots/{name}")
            self.assertEqual(status, 404)

    def test_only_public_files_are_served(self) -> None:
        self.put("", [{"id": "a", "name": "secret"}])
        for path in ["/", "/index.html", "/app.js", "/core.js", "/styles.css", "/sw.js", "/manifest.webmanifest", "/icon.svg"]:
            with self.subTest(path=path):
                status, _, response = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
        for path in ["/weed_chart.json", "/serve.py", "/ocs.py", "/.git/config", "/backups/", "/tests/", "/%2e%2e/etc/passwd", "/README.md", "/.gitignore"]:
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, 404)

    def test_static_files_support_conditional_requests(self) -> None:
        _, _, response = self.request("GET", "/app.js")
        last_modified = response.getheader("Last-Modified")
        status, _, _ = self.request("GET", "/app.js", headers={"If-Modified-Since": last_modified})
        self.assertEqual(status, 304)


if __name__ == "__main__":
    unittest.main()
