#!/usr/bin/env python3
"""Write a small research guide and a question's answer, offline.

The browser test (tests/e2e.js) opens both: research.write runs for real,
with the model calls, Reddit and the archive replaced by canned answers, so
no network or model is used.

    python3 tests/make_guide.py <research dir>    # prints both file names, one per line
"""

import json
import sys
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import ask  # noqa: E402
import llm  # noqa: E402
import research  # noqa: E402
import test_ask  # noqa: E402
from test_research import GUIDE, fake_state  # noqa: E402


def ask_guide(provider, *, prompt, schema, **_):
    return {"data": json.loads(json.dumps(GUIDE)), "model": f"{provider}-model", "cost": 0.1,
            "tokens": {"input": 10, "output": 2}, "seconds": 1}


def main() -> None:
    out = Path(sys.argv[1])
    state = fake_state()
    state["id"] = "hash-20260102T000000Z"  # apart from the paused run e2e.js plants
    with mock.patch.object(llm, "ask", ask_guide):
        path = research.write(state, provider="codex", out_dir=out, progress=lambda *args, **counts: None)
    print(path.name)

    # A question: the stand-ins test_ask.py uses, plus a few more sections.
    answer = json.loads(json.dumps(test_ask.ANSWER))
    answer["depends_on"] = [{"factor": "How much", "detail": "A small hit is fine for some.", "threads": ["p1"]}]
    answer["risks"] = [{"title": "Forgetting", "detail": "Recall suffers the next day.", "threads": ["p1"]}]
    answer["related"] = ["Does CBD help with focus?"]

    def ask_question(provider, *, prompt, schema, **_):
        data = test_ask.PLAN if schema is ask.PLAN_SCHEMA else answer
        return {"data": json.loads(json.dumps(data)), "model": f"{provider}-model", "cost": 0.1,
                "tokens": {"input": 10, "output": 2}, "seconds": 1}

    comment = {"id": "c1", "body": "I forget everything I study high, honestly every time", "score": 5, "author": "u",
               "created_utc": 1_780_000_100, "parent_id": None}
    with mock.patch.object(llm, "ask", ask_question), \
            mock.patch.object(ask, "archive_search", return_value=test_ask.POSTS[:2]), \
            mock.patch.object(ask, "reddit_search", return_value=[]), \
            mock.patch.object(ask, "recent_posts", return_value=[]), \
            mock.patch.object(research, "thread_comments", return_value=[comment]):
        path = ask.run("How do live resin carts affect studying?", provider="claude", out_dir=out,
                       progress=lambda *args, **counts: None)
    print(path.name)


if __name__ == "__main__":
    main()
