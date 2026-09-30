#!/usr/bin/env python3
"""Write one small research guide into a research folder, offline.

The browser test (tests/e2e.js) opens it: research.write runs for real, with
the model call replaced by a canned answer, so no network or model is used.

    python3 tests/make_guide.py <research dir>    # prints the guide's file name
"""

import json
import sys
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import llm  # noqa: E402
import research  # noqa: E402
from test_research import GUIDE, fake_state  # noqa: E402


def ask(provider, *, prompt, schema, **_):
    return {"data": json.loads(json.dumps(GUIDE)), "model": f"{provider}-model", "cost": 0.1,
            "tokens": {"input": 10, "output": 2}, "seconds": 1}


def main() -> None:
    out = Path(sys.argv[1])
    state = fake_state()
    state["id"] = "hash-20260102T000000Z"  # apart from the paused run e2e.js plants
    with mock.patch.object(llm, "ask", ask):
        path = research.write(state, provider="codex", out_dir=out, progress=lambda *args, **counts: None)
    print(path.name)


if __name__ == "__main__":
    main()
