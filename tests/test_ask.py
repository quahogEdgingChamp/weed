"""Free questions (ask.py), offline: the model, Reddit and the archive are
all stand-ins, so nothing leaves the machine."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ask  # noqa: E402
import llm  # noqa: E402
import research  # noqa: E402

PLAN = {"title": "Live resin carts and studying", "restated": "How do live resin carts affect studying?",
        "subreddits": [{"name": "r/trees", "why": "big"}, {"name": "ADHD", "why": "focus"}, {"name": "bad name!", "why": ""},
                       {"name": "trees", "why": "duplicate"}],
        "searches": ["Studying high", "study  high", "focus \"sativa\"", ""],
        "aspects": ["memory", "focus"], "cannabis_products": False}

ANSWER = {"headline": "Mostly worse for memory", "short_answer": "Most say it hurts recall.", "confidence": "moderate",
          "confidence_why": "Many first-hand reports.",
          "findings": [{"title": "Recall suffers", "detail": "d", "how_common": "most", "people": 5, "stance": "supports",
                        "quotes": [{"text": "I forget everything I study high", "thread": "p1", "comment": "c1"},
                                   {"text": "an invented quote nobody wrote", "thread": "p1", "comment": "c1"}],
                        "threads": ["p1"]}],
          "depends_on": [], "disagreements": [], "risks": [], "tips": [],
          "products": [{"id": "x", "ref": "", "brand": "B", "name": "N", "kind": "cart", "tone": "mixed", "summary": "s",
                        "quotes": [], "threads": ["p2"]}],
          "caveats": ["anecdotes"], "faq": [], "related": []}


def post(pid, title, sub="trees", comments=12):
    return {"id": pid, "title": title, "selftext": "", "score": 10, "num_comments": comments,
            "created_utc": 1_780_000_000, "link_flair_text": None, "subreddit": sub, "author": "a"}


POSTS = [post("p1", "Studying high: does it work?"), post("p2", "Best cart for focus sativa"),
         post("p3", "Cute dog picture"), post("p4", "study while high tips", sub="ADHD")]


class QuestionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        self.calls = []
        self.limit_on = None
        patches = [
            mock.patch.object(llm, "ask", self.fake_ask),
            mock.patch.object(ask, "archive_search", side_effect=research.SourceError("Timeout. Maybe slow down a bit")),
            mock.patch.object(ask, "reddit_search", side_effect=lambda sub, words, *a, **k: [p for p in POSTS if p["subreddit"].lower() == sub.lower()][:2]),
            mock.patch.object(ask, "recent_posts", side_effect=lambda sub, *a, **k: [p for p in POSTS if p["subreddit"].lower() == sub.lower()]),
            mock.patch.object(research, "thread_comments", side_effect=lambda p, *a, **k: [
                {"id": "c1" if p["id"] == "p1" else f"c-{p['id']}", "body": "I forget everything I study high, honestly every time",
                 "score": 5, "author": "u", "created_utc": 1_780_000_100, "parent_id": None}]),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def fake_ask(self, provider, *, prompt, schema, system, **_):
        kind = "plan" if schema is ask.PLAN_SCHEMA else "notes" if schema is ask.NOTES_SCHEMA else "answer"
        self.calls.append(kind)
        if kind == self.limit_on:
            raise llm.LimitError("You've hit your limit · resets 3pm", provider)
        self.assertIs(system, ask.PLAN_SYSTEM if kind == "plan" else ask.SYSTEM)
        data = {"plan": PLAN, "answer": ANSWER,
                "notes": {"findings": [{"claim": "c", "detail": "d", "people": 3, "stance": "supports", "quotes": [],
                                        "threads": ["p1"]}], "factors": [], "disagreements": [], "risks": [],
                          "products": [], "tips": [], "questions": []}}[kind]
        return {"data": json.loads(json.dumps(data)), "model": "m", "cost": 0.1, "tokens": {"input": 1, "output": 1},
                "seconds": 1}

    def test_plan_is_cleaned(self) -> None:
        plan = ask.clean_plan(PLAN, "q?", ask.DEPTHS["quick"])
        self.assertEqual([s["name"] for s in plan["subreddits"]], ["trees", "ADHD"])
        self.assertEqual(plan["searches"], ["studying high", "study high", "focus sativa"])
        with self.assertRaises(llm.ModelError):
            ask.clean_plan({"subreddits": [], "searches": ["x"]}, "q?", ask.DEPTHS["quick"])
        with_ocs = ask.clean_plan({**PLAN, "cannabis_products": True}, "q?", ask.DEPTHS["quick"])
        self.assertIn("TheOCS", [s["name"] for s in with_ocs["subreddits"]])

    def test_question_answered_from_matching_threads(self) -> None:
        path = ask.run("How do live resin carts affect studying?", provider="claude", out_dir=self.out,
                       progress=lambda *a, **k: None)
        doc = json.loads(path.read_text())
        self.assertEqual(self.calls, ["plan", "answer"])
        self.assertEqual((doc["kind"], doc["topic"]["label"]), ("question", "Live resin carts and studying"))
        self.assertEqual(doc["question"], "How do live resin carts affect studying?")
        # The dog picture matched no search; the archive's search failed, so
        # Reddit's search and the newest posts were used.
        self.assertEqual(sorted(doc["threads"]), ["p1", "p2", "p4"])
        self.assertIn("reddit-search", doc["sources"])
        self.assertNotIn("arctic-search", doc["sources"])
        quotes = doc["guide"]["findings"][0]["quotes"]
        self.assertEqual([q["text"] for q in quotes], ["I forget everything I study high"])
        self.assertEqual(doc["writer"]["quotesDropped"], 1)
        self.assertIsNone(doc["guide"]["products"][0]["ocs"])
        rows = {r["name"]: r for r in research.list_reports(self.out)}
        self.assertEqual((rows[path.name]["kind"], rows[path.name]["findings"]), ("question", 1))
        self.assertFalse(research.list_checkpoints(self.out))

    def test_deep_question_reads_parts(self) -> None:
        path = ask.run("How do live resin carts affect studying?", depth="deep", provider="codex", out_dir=self.out,
                       progress=lambda *a, **k: None)
        self.assertEqual(self.calls[0], "plan")
        self.assertIn("notes", self.calls)
        self.assertEqual(self.calls[-1], "answer")
        self.assertEqual(json.loads(path.read_text())["stats"]["parts"], self.calls.count("notes"))

    def test_limit_while_planning_pauses_and_resumes(self) -> None:
        self.limit_on = "plan"
        with self.assertRaises(research.Paused) as caught:
            ask.run("Is a grinder card better than a grinder?", provider="claude", out_dir=self.out,
                    progress=lambda *a, **k: None)
        self.assertTrue(caught.exception.limit)
        meta = research.list_checkpoints(self.out)[0]
        self.assertEqual((meta["kind"], meta["status"], meta["topic"]["key"]), ("question", "paused", "question"))
        self.limit_on = None
        path = research.resume(meta["id"], provider="codex", out_dir=self.out, progress=lambda *a, **k: None)
        self.assertEqual(json.loads(path.read_text())["kind"], "question")
        self.assertEqual(self.calls, ["plan", "plan", "answer"])

    def test_limit_after_planning_keeps_the_plan(self) -> None:
        self.limit_on = "answer"
        with self.assertRaises(research.Paused):
            ask.run("Is a grinder card better than a grinder?", provider="claude", out_dir=self.out,
                    progress=lambda *a, **k: None)
        state = research.read_checkpoint(self.out, research.list_checkpoints(self.out)[0]["id"])
        self.assertTrue(state["prepared"])
        self.assertEqual(state["plan"]["title"], "Live resin carts and studying")
        self.limit_on = None
        research.resume(state["id"], provider="claude", out_dir=self.out, progress=lambda *a, **k: None)
        self.assertEqual(self.calls, ["plan", "answer", "answer"])  # no second plan, no second search

    def test_questions_need_a_writer_and_words(self) -> None:
        jobs = research.Jobs(self.out)
        with mock.patch.object(research.llm, "binary", return_value="/bin/true"):
            with self.assertRaises(ValueError):
                jobs.new_entry("question", "Is it good?", "quick", "none")
            with self.assertRaises(ValueError):
                jobs.new_entry("question", "why", "quick", "claude")
            entry = jobs.new_entry("question", "  How   do edibles affect sleep?  ", "quick", "claude")
        self.assertEqual((entry["topic"], entry["query"]), ("question", "How do edibles affect sleep?"))

    def test_search_words_match_forms(self) -> None:
        patterns = ask.search_patterns(["studying high"])
        self.assertEqual(ask.relevance({"title": "Anyone study while high?"}, patterns), 3)
        self.assertEqual(ask.relevance({"title": "Exam tips", "selftext": "I studied when high"}, patterns), 1.5)
        self.assertEqual(ask.relevance({"title": "Highway study"}, patterns), 0)


if __name__ == "__main__":
    unittest.main()
