"""How to start (start.py), offline: the model, the archive and Reddit are
stand-ins, and the guides' threads are written into a temporary cache."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import llm  # noqa: E402
import research  # noqa: E402
import start  # noqa: E402
from test_research import GUIDE, fake_state  # noqa: E402


def setUpModule() -> None:
    patcher = mock.patch.object(research.hibuddy, "fetch_page", side_effect=research.hibuddy.Unavailable("offline"))
    patcher.start()
    unittest.addModuleCleanup(patcher.stop)


ADVICE = "Start with one small puff and wait ten minutes before you take another, it creeps up on you."
SEARCHED = {"id": "s1", "row": {"title": "New to carts, how many hits?", "sub": "Carts", "score": 40, "comments": 12,
                                "date": "2026-05-01"},
            "title": "New to carts, how many hits?", "text": "First cart ever, how many hits should I take?",
            "comments": [{"id": "k1", "body": ADVICE, "score": 30, "author": "a"}]}

SECTION = {
    "summary": "One or two short puffs, then wait 10–15 minutes.",
    "first_time": "One short puff.", "wait": "10–15 minutes.",
    "timeline": {"onset": "2–10 minutes", "peak": "about 30 minutes", "lasts": "2–4 hours"},
    "steps": [{"title": "Take one puff", "body": "Short, two seconds.", "basis": "threads", "threads": ["t:s1", "nope"]},
              {"title": "Somewhere safe", "body": "Nowhere to drive.", "basis": "general", "threads": []}],
    "with_tolerance": "Carts hit harder per puff than a joint.",
    "first_picks": [{"product": "x", "why": "people call it gentle"}, {"product": "missing", "why": "not in the guide"},
                    {"product": "x", "why": "twice"}],
    "mistakes": [{"title": "A long first pull", "body": "Fresh carts hit hard.", "threads": ["s1"]}],
    "too_much": ["It passes.", "Water and a snack.", " "],
    "quotes": [{"text": "wait ten minutes before you take another", "thread": "t:wrong", "comment": "c:k1"},
               {"text": "an invented quote nobody wrote at all", "thread": "s1", "comment": "k1"}],
    "evidence": "moderate", "evidence_note": "A few threads give the same advice.",
}


def answer(data=None, calls=None):
    def ask(provider, *, prompt, schema, **_):
        if calls is not None:
            calls.append((schema is start.SCHEMA, prompt))
        body = SECTION if schema is start.SCHEMA else GUIDE
        return {"data": json.loads(json.dumps(data if data is not None else body)), "model": f"{provider}-model",
                "cost": 0.05, "tokens": {"input": 10, "output": 2}, "seconds": 1}
    return ask


class WeightTest(unittest.TestCase):
    def test_dosing_talk_counts_and_praise_does_not(self) -> None:
        self.assertGreaterEqual(start.weight("take 2 small puffs and wait 10 minutes"), 2)
        self.assertGreaterEqual(start.weight("I greened out on half a gummy"), 2)
        self.assertEqual(start.weight("this cart hits hard and tastes great"), 0)
        self.assertLess(start.weight("first time trying iris labs, it leaked"), 2)

    def test_a_custom_topic_searches_its_own_words(self) -> None:
        form = start.form_for({"key": "custom", "label": "cold cure", "query": "cold cure"}, ["TheOCS"])
        self.assertIn("cold cure", form["searches"])
        self.assertEqual(form["general"], ("TheOCS", "trees"))
        self.assertIsNotNone(start.re.search(form["match"], "my first cold cure was great"))
        self.assertIsNone(start.re.search(form["match"], "cold weather"))


class EvidenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name)
        (self.cache / "threads").mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_own_threads_keep_only_starting_talk(self) -> None:
        research.write_json(self.cache / "threads" / "t1.json", {"complete": True, "comments": [
            {"id": "c1", "body": ADVICE, "score": 4, "author": "a"},
            {"id": "c2", "body": "The flavour on this one is unreal, best cart I've had.", "score": 50, "author": "b"}]})
        # Older caches are a bare list.
        research.write_json(self.cache / "threads" / "t2.json", [
            {"id": "c3", "body": "Price went up again at my store this week, annoying.", "score": 1, "author": "c"}])
        own = start.own_evidence(self.cache, {"t1": {"title": "A cart"}, "t2": {"title": "B"}, "t3": {"title": "gone"}})
        self.assertEqual([t["id"] for t in own], ["t1"])
        self.assertEqual([c["id"] for c in own[0]["comments"]], ["c1"])

    def test_search_keeps_on_topic_threads_with_comments(self) -> None:
        posts = {
            "Carts": [{"id": "a1", "title": "First cart, how many hits?", "selftext": "", "num_comments": 9, "score": 5},
                      {"id": "a2", "title": "Look at my battery collection", "selftext": "", "num_comments": 30, "score": 90}],
            "trees": [{"id": "b1", "title": "Greened out last night", "selftext": "it was an edible", "num_comments": 50},
                      {"id": "b2", "title": "Greened out on a cart", "selftext": "", "num_comments": 20},
                      {"id": "b3", "title": "Greened out on my vape pen", "selftext": "", "num_comments": 1}],
            "TheOCS": [{"id": "own", "title": "New to carts?", "selftext": "", "num_comments": 40}],
            "CanadianCannabisLPs": [],
        }
        form = start.FORMS["live-carts"]
        comments = {"a1": [{"id": "x1", "body": ADVICE, "score": 3, "author": "a"}],
                    "b2": [{"id": "x2", "body": "Way too high after three long rips, never again.", "score": 2, "author": "b"}]}
        with mock.patch.object(start, "listing", side_effect=lambda sub, *a: [{**p, "subreddit": sub} for p in posts[sub]]), \
                mock.patch.object(start, "archive_finds", return_value=([], 0)), \
                mock.patch.object(research, "thread_comments", side_effect=lambda post, *a: comments.get(post["id"], [])):
            found, info = start.find_threads(form, {"own"}, self.cache, None, lambda _m: None)
        # a1: a dedicated subreddit, so no form words needed. b1 is about an
        # edible, b3 has too few comments, a2 isn't about starting, "own" is
        # the guide's own thread already.
        self.assertEqual(sorted(t["id"] for t in found), ["a1", "b2"])
        self.assertEqual(info["subreddits"], ["Carts", "trees", "TheOCS", "CanadianCannabisLPs"])

    def test_the_packet_fits_its_budget_and_lists_what_it_holds(self) -> None:
        own = [{"id": f"t{i}", "row": {"title": f"thread {i}", "sub": "TheOCS", "date": "2026-01-01"}, "text": "",
                "comments": [{"id": f"c{i}-{j}", "body": ADVICE + " " * j, "score": j} for j in range(40)]}
               for i in range(10)]
        packet, counts, corpus, texts, thread_of = start.build_packet(own, [SEARCHED], 12_000)
        self.assertLessEqual(len(packet), 12_000)
        self.assertIn("## A. ", packet)
        self.assertIn("## B. ", packet)
        self.assertIn("[t:s1]", packet)
        self.assertEqual(counts["searchedThreads"], 1)
        self.assertEqual(len(corpus), counts["ownComments"] + counts["searchedComments"])
        self.assertIn("s1", texts)
        self.assertEqual(thread_of["k1"], "s1")


class AddStartTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        self.name = "hash-20260101T000000Z.json"
        guide = json.loads(json.dumps(GUIDE))
        guide["products"][0]["good_for"] = ["beginners"]
        research.write_json(self.out / "reports" / self.name, {
            "format": 2, "topic": {"key": "live-carts", "label": "Live resin & live rosin carts"},
            "subreddits": ["TheOCS"], "guide": guide, "threads": {"t1": {"title": "thread 1", "sub": "TheOCS"}},
            "writer": {"by": "claude"}, "createdAt": "2026-01-01T00:00:00Z"}, indent=1)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_writes_the_section_with_checked_quotes_picks_and_sources(self) -> None:
        calls = []
        with mock.patch.object(start, "find_threads", return_value=([SEARCHED], {"subreddits": ["Carts"]})), \
                mock.patch.object(llm, "ask", answer(calls=calls)):
            method = start.add_start(self.out, self.name, provider="claude", model="opus", effort="high",
                                     log=lambda _m: None)
        document = research.read_report(self.out, self.name)
        section = document["guide"]["start"]
        # Labelled ids ("t:s1", "c:k1") are read without the label, and a
        # quote's thread is the one its comment is in.
        self.assertEqual([(q["thread"], q["comment"]) for q in section["quotes"]], [("s1", "k1")])
        self.assertEqual(method["quotes"], 1)
        self.assertEqual(method["quotesDropped"], 1)
        self.assertEqual([p["product"] for p in section["first_picks"]], ["x"])
        self.assertEqual(section["steps"][0]["threads"], ["s1"])
        self.assertEqual(section["too_much"], ["It passes.", "Water and a snack."])
        # The searched thread it cites can be linked to.
        self.assertEqual(document["threads"]["s1"]["sub"], "Carts")
        self.assertEqual(document["startMethod"]["searched"]["threads"], 1)
        self.assertEqual(document["startMethod"]["effort"], "high")
        self.assertTrue(research.list_reports(self.out)[0]["howToStart"])
        # The writer is told the form and the guide's products, and sees the evidence.
        prompt = calls[0][1]
        self.assertIn("510 thread", prompt)
        self.assertIn("x | B | N", prompt)
        self.assertIn(ADVICE, prompt)

    def test_nothing_found_means_no_section_and_no_model_call(self) -> None:
        calls = []
        with mock.patch.object(start, "find_threads", return_value=([], {})), \
                mock.patch.object(llm, "ask", answer(calls=calls)):
            self.assertIsNone(start.add_start(self.out, self.name, provider="claude", log=lambda _m: None))
        self.assertEqual(calls, [])
        self.assertNotIn("start", research.read_report(self.out, self.name)["guide"])

    def test_an_answer_to_a_question_gets_none(self) -> None:
        research.write_json(self.out / "reports" / "question-20260101T000000Z.json",
                            {"kind": "question", "guide": {"findings": []}, "threads": {}})
        with mock.patch.object(start, "find_threads", return_value=([SEARCHED], {})):
            self.assertIsNone(start.add_start(self.out, "question-20260101T000000Z.json", provider="claude",
                                              log=lambda _m: None))

    def test_a_limit_writes_nothing(self) -> None:
        def limited(*_a, **_k):
            raise llm.LimitError("You've hit your usage limit.", "claude")

        with mock.patch.object(start, "find_threads", return_value=([SEARCHED], {})), \
                mock.patch.object(llm, "ask", limited):
            with self.assertRaises(llm.LimitError):
                start.add_start(self.out, self.name, provider="claude", log=lambda _m: None)
        self.assertNotIn("start", research.read_report(self.out, self.name)["guide"])


class AfterGuideTest(unittest.TestCase):
    """A guide run writes How to start right after saving the guide."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_a_new_guide_gets_its_section(self) -> None:
        with mock.patch.object(start, "find_threads", return_value=([SEARCHED], {"subreddits": ["Carts"]})), \
                mock.patch.object(llm, "ask", answer()):
            path = research.write(fake_state(), provider="codex", model="m", effort="low", out_dir=self.out)
        document = json.loads(path.read_text())
        self.assertEqual(document["guide"]["start"]["summary"], SECTION["summary"])
        self.assertEqual(document["startMethod"]["by"], "codex")

    def test_a_limit_on_the_section_still_keeps_the_guide(self) -> None:
        def ask(provider, *, prompt, schema, **kwargs):
            if schema is start.SCHEMA:
                raise llm.LimitError("You've hit your usage limit. Try again at 7pm.", provider)
            return answer()(provider, prompt=prompt, schema=schema, **kwargs)

        lines = []
        with mock.patch.object(start, "find_threads", return_value=([SEARCHED], {})), \
                mock.patch.object(llm, "ask", ask):
            path = research.write(fake_state(), provider="claude", out_dir=self.out,
                                  progress=lambda stage, message, **_: lines.append(message))
        document = json.loads(path.read_text())
        self.assertEqual(document["guide"]["headline"], "H")
        self.assertNotIn("start", document["guide"])
        self.assertTrue(any("--how-to-start " + path.name in line for line in lines))

    def test_a_counts_only_guide_has_no_writer_for_it(self) -> None:
        with mock.patch.object(start, "add_start") as add:
            research.write(fake_state(), provider="none", out_dir=self.out)
        add.assert_not_called()


if __name__ == "__main__":
    unittest.main()
