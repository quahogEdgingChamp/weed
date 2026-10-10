#!/usr/bin/env python3
"""Copy the saved guides into published/research/ for the public site.

GitHub Pages has no serve.py, so the Research tab there reads these files
instead of /api/research (see READ_ONLY in js/30-research-setup.js):

    published/research/index.json          what GET /api/research returns,
                                           with no run, queue or writers
    published/research/reports/<name>      what GET /api/research/reports/<name>
                                           returns, one per saved guide

research/ itself stays out of git: its caches and checkpoints are working
files. Only the finished reports are published. Run this after a new guide
is written, then commit published/ and push:

    python3 publish_research.py
"""

import json
import shutil
from pathlib import Path

import research

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "research"
TARGET = ROOT / "published" / "research"


def write(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main() -> None:
    reports = research.list_reports(SOURCE)
    if TARGET.exists():
        shutil.rmtree(TARGET)
    (TARGET / "reports").mkdir(parents=True)

    for row in reports:
        document = research.read_report(SOURCE, row["name"])
        write(TARGET / "reports" / row["name"], {"name": row["name"], "report": document})

    write(TARGET / "index.json", {
        "topics": research.topic_list(),
        "depths": {name: {"days": d["days"], "threads": d["threads"], "mode": d["mode"]}
                   for name, d in research.DEPTHS.items()},
        "llm": {"available": False},
        "providers": {p: {"available": False, "label": label}
                      for p, label in (("claude", "Claude"), ("codex", "Codex"), ("grok", "Grok"))},
        "job": None,
        "queue": {"entries": [], "recent": []},
        "reports": reports,
        "checkpoints": [],
    })
    print(f"Published {len(reports)} guides to {TARGET.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
