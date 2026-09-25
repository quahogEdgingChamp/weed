"""Run with: python3 -m unittest discover tests

Offline: nothing here talks to Reddit, OCS or Claude. The server tests use a
temporary folder for reports, and stub out the research run itself.
"""

from __future__ import annotations

import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import research  # noqa: E402
import serve  # noqa: E402


def product(handle="x", title="Thing", vendor="Brand", tags=(), price="39.95", size="1g", available=True):
    return {
        "handle": handle,
        "title": title,
        "vendor": vendor,
        "tags": list(tags),
        "variants": [{"title": size, "price": price, "available": available}],
        "images": [{"src": "//cdn.shopify.com/a.jpg"}],
    }


class TopicTest(unittest.TestCase):
    def test_custom_topic_needs_every_word(self) -> None:
        topic = research.resolve_topic("custom", "cold cure rosin")
        self.assertTrue(topic["regex"].search("Best cold cure? This rosin rules"))
        self.assertFalse(topic["regex"].search("cold rosin only"))

    def test_unknown_topic_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            research.resolve_topic("nope", "")
        with self.assertRaises(ValueError):
            research.resolve_topic("custom", "   ")

    def test_cart_relevance(self) -> None:
        topic = research.resolve_topic("live-carts", "")
        on = {"title": "Best live rosin cart right now?", "selftext": ""}
        off = {"title": "Pre-roll haul", "selftext": "some flower"}
        self.assertGreater(research.relevance(on, topic, None), 0)
        self.assertEqual(research.relevance(off, topic, None), 0)


class CatalogTest(unittest.TestCase):
    def test_products_json_prices_are_dollars(self) -> None:
        row = research.summarize_product(product(tags=["category--Vapes", "thc_content_min--70", "thc_content_max--80"]))
        self.assertEqual(row["price"], 39.95)
        self.assertEqual((row["thcMin"], row["thcMax"]), (70.0, 80.0))
        self.assertTrue(row["image"].startswith("https://"))

    def test_common_word_brands_only_match_capitalised(self) -> None:
        brands = research.build_brands([research.summarize_product(product(vendor="Status")),
                                        research.summarize_product(product(vendor="IRIS Labs"))])
        self.assertTrue(brands["status"]["regex"].search("Status carts are fine"))
        self.assertFalse(brands["status"]["regex"].search("what's the status of my order"))
        self.assertTrue(brands["iris"]["regex"].search("iris fantasm slaps"))


class QuoteTest(unittest.TestCase):
    def report(self, text, comment="c1"):
        return {"products": [{"name": "P", "quotes": [{"text": text, "thread": "t1", "comment": comment}]}]}

    def test_verbatim_quote_is_kept(self) -> None:
        guide = self.report("the hardware is leagues ahead")
        kept, dropped = research.verify_quotes(guide, {"c1": "Honestly the HARDWARE is leagues ahead of Tribal."}, {})
        self.assertEqual((kept, dropped), (1, []))

    def test_invented_quote_is_dropped(self) -> None:
        guide = self.report("best cart I have ever had in my life")
        kept, dropped = research.verify_quotes(guide, {"c1": "It was fine I guess."}, {})
        self.assertEqual(kept, 0)
        self.assertEqual(len(dropped), 1)
        self.assertEqual(guide["products"][0]["quotes"], [])

    def test_quote_with_link_text_matches_cleaned_comment(self) -> None:
        guide = self.report("bought it at the dispensary downtown")
        corpus = {"c1": "I bought it at [the dispensary](https://example.com/x) downtown &amp; loved it"}
        self.assertEqual(research.verify_quotes(guide, corpus, {})[0], 1)

    def test_wrong_comment_id_is_repaired(self) -> None:
        guide = self.report("smooth hits at 2.0 volts", comment="c1")
        research.verify_quotes(guide, {"c1": "unrelated", "c2": "Smooth hits at 2.0 volts every time"}, {})
        self.assertEqual(guide["products"][0]["quotes"][0]["comment"], "c2")


class AttachTest(unittest.TestCase):
    def test_prices_come_from_ocs_and_ids_are_unique(self) -> None:
        row = research.summarize_product(product(handle="h1", title="Fantasm Live Resin", vendor="IRIS Labs", price="44.95"))
        guide = {
            "products": [
                {"id": "fantasm", "ref": "h1", "brand": "IRIS Labs", "name": "Fantasm", "score": 12},
                {"id": "fantasm", "ref": "", "brand": "IRIS Labs", "name": "Fantasm again", "score": 7},
            ],
            "quick_picks": [{"product": "fantasm"}],
        }
        research.attach_catalog(guide, [row], [row])
        first, second = guide["products"]
        self.assertEqual(first["ocs"]["price"], 44.95)
        self.assertNotIn("haystack", first["ocs"])
        self.assertEqual(first["score"], 10.0)
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(guide["quick_picks"][0]["product"], "fantasm")


class DeepModeTest(unittest.TestCase):
    def test_comments_page_past_100(self) -> None:
        pages = [
            {"data": [{"id": f"a{i}", "body": "x" * 30, "created_utc": 1000 + i} for i in range(100)]},
            {"data": [{"id": f"b{i}", "body": "y" * 30, "created_utc": 1200 + i} for i in range(40)]},
        ]
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(research, "fetch_json", side_effect=pages) as fake:
            rows = research.thread_comments({"id": "t1", "created_utc": 0}, Path(tmp), None, lambda _m: None)
            self.assertEqual(len(rows), 140)
            self.assertEqual(fake.call_count, 2)
            self.assertNotIn("after=", fake.call_args_list[0].args[0])
            self.assertIn("after=1099", fake.call_args_list[1].args[0])
            # Cached as complete: no second fetch.
            again = research.thread_comments({"id": "t1", "created_utc": 0}, Path(tmp), None, lambda _m: None)
            self.assertEqual(len(again), 140)
            self.assertEqual(fake.call_count, 2)

    def test_old_capped_cache_is_refetched(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "threads" / "t1.json"
            cache.parent.mkdir()
            cache.write_text(json.dumps([{"id": str(i), "body": "z" * 30} for i in range(100)]))
            with mock.patch.object(research, "fetch_json", return_value={"data": []}) as fake:
                research.thread_comments({"id": "t1", "created_utc": 0}, Path(tmp), None, lambda _m: None)
            self.assertEqual(fake.call_count, 1)

    def test_batches_cover_every_thread_within_size(self) -> None:
        threads = [{"id": f"t{i}", "title": f"Thread {i}", "selftext": "", "created_utc": 0} for i in range(30)]
        comments = {t["id"]: [{"id": f"{t['id']}c{j}", "body": "word " * 60, "score": j} for j in range(20)]
                    for t in threads}
        batches = research.batch_evidence(threads, comments, [], 20_000, 900)
        self.assertGreater(len(batches), 1)
        self.assertEqual(sum(b["threads"] for b in batches), 30)
        self.assertEqual(sum(b["comments"] for b in batches), 600)
        self.assertTrue(all(b["chars"] <= 20_000 for b in batches))

    def test_single_packet_reports_what_fit(self) -> None:
        threads = [{"id": f"t{i}", "title": "T", "selftext": "", "created_utc": 0} for i in range(50)]
        comments = {t["id"]: [{"id": f"{t['id']}c", "body": "word " * 80, "score": 1}] for t in threads}
        analysis = {"brands": [], "months": [], "volume": []}
        _packet, threads_in, comments_in = research.build_packet(
            research.resolve_topic("hash", ""), threads, comments, [], analysis, 10_000, 10)
        self.assertLess(threads_in, 50)
        self.assertEqual(threads_in, comments_in)


class ChoiceTest(unittest.TestCase):
    def test_model_and_effort_are_checked(self) -> None:
        import llm
        self.assertEqual(llm.check_choice("claude", "claude-fable-5-1[1m]", "high"), ("claude-fable-5-1[1m]", "high"))
        with self.assertRaises(ValueError):
            llm.check_choice("claude", "opus; rm -rf ~", "")
        with self.assertRaises(ValueError):
            llm.check_choice("codex", "gpt-6-sol", "turbo")
        with self.assertRaises(ValueError):
            llm.check_choice("gemini", "", "")


class GrokTest(unittest.TestCase):
    def test_reply_envelope(self) -> None:
        import llm
        raw = json.dumps({"text": "{}", "structuredOutput": {"picks": ["blue"]}, "total_cost_usd": 0.02,
                          "usage": {"input_tokens": 10, "output_tokens": 3},
                          "modelUsage": {"grok-4.7-build-fast": {}}})
        result = llm._grok_result(raw, "", "", 2)
        self.assertEqual(result["data"], {"picks": ["blue"]})
        self.assertEqual(result["model"], "grok-4.7-build-fast")
        self.assertEqual(result["tokens"], {"input": 10, "output": 3})

    def test_reply_falls_back_to_text(self) -> None:
        import llm
        raw = json.dumps({"text": "```json\n{\"n\": 7}\n```"})
        self.assertEqual(llm._grok_result(raw, "", "", 1)["data"], {"n": 7})
        with self.assertRaises(llm.ModelError):
            llm._grok_result(json.dumps({"text": "sorry"}), "", "", 1)

    def test_doubled_json_is_read(self) -> None:
        import llm
        raw = json.dumps({"text": '{"products":[],"tips":["a"]}{"products":[],"tips":["a"]}'})
        self.assertEqual(llm._grok_result(raw, "", "", 1)["data"], {"products": [], "tips": ["a"]})

    def test_grok_gets_no_tools_and_cannot_see_its_prompt_file(self) -> None:
        import llm
        seen = {}

        def fake_run(args, stdin, cwd, path, cancel, log, timeout, label):
            seen["args"] = args
            prompt_file = Path(args[args.index("--prompt-file") + 1])
            workdir = Path(args[args.index("--cwd") + 1])
            seen["outside"] = workdir not in prompt_file.parents
            seen["cwd_empty"] = not any(workdir.iterdir())
            return json.dumps({"structuredOutput": {"ok": True}}), "", 1

        with mock.patch.object(llm, "binary", return_value="/bin/true"), mock.patch.object(llm, "_run", fake_run):
            llm.ask("grok", system="s", prompt="p", schema={"type": "object"})
        args = seen["args"]
        self.assertEqual(args[args.index("--tools") + 1], "todo_write")
        self.assertIn("search_tool", args[args.index("--disallowed-tools") + 1])
        self.assertTrue(seen["outside"])
        self.assertTrue(seen["cwd_empty"])

    def test_thinking_levels_by_version(self) -> None:
        import llm
        self.assertIn("xhigh", llm._grok_efforts("grok-4.7-build-fast"))
        self.assertNotIn("xhigh", llm._grok_efforts("grok-4.5"))
        self.assertEqual(llm._grok_efforts("mystery"), [])

    def test_usage_limit_is_recognised(self) -> None:
        import llm
        cases = {
            "Codex could not finish: You’ve hit your usage limit. Upgrade to Pro, visit https://x or try again at "
            "Sep 26th, 2026 7:21 PM.": "Sep 26th, 2026 7:21 PM",
            "Claude could not finish: 5-hour limit reached ∙ resets 3pm (America/Toronto)": "3pm (America/Toronto)",
            "Claude could not finish: You've hit your limit · resets Sep 25, 9am": "Sep 25, 9am",
            "Grok could not finish: 429 Too Many Requests": "",
        }
        for message, resets in cases.items():
            self.assertTrue(llm.is_limit(message), message)
            self.assertEqual(llm.reset_hint(message), resets)
        self.assertFalse(llm.is_limit("Codex could not finish: schema mismatch"))


def fake_state(parts: int = 0) -> dict:
    """The smallest state `research.write` accepts: no network, no model."""
    batches = [{"text": f"### [t:t{i}] thread {i}\n- [c:c{i} 3↑] great hash from part {i}", "threads": 1, "comments": 1}
               for i in range(1, parts + 1)]
    return {
        "version": 1, "id": "hash-20260101T000000Z",
        "topic": {"key": "hash", "label": "Hash & kief", "blurb": "", "focus": "melt", "query": ""},
        "depth": "deep" if parts else "quick", "mode": "batches" if parts else "single",
        "subreddits": ["TheOCS"], "sources": ["arctic"], "started": 1_790_000_000, "after": 1_760_000_000,
        "days": 365, "seconds": 5,
        "counts": {"postsScanned": 10, "postsRelevant": 3, "threadsFetched": max(parts, 1), "commentsFetched": max(parts, 1),
                   "brandSearchComments": 0, "brandSearchThreads": 0, "ocsProducts": 1, "ocsTopicProducts": 1},
        "analysis": {"months": [], "volume": [], "brands": []},
        "topicRows": [], "threadMeta": {f"t{i}": {"title": f"thread {i}", "subreddit": "TheOCS", "created_utc": 0}
                                        for i in range(1, max(parts, 1) + 1)},
        "chosenTop": [], "corpus": {f"c{i}": f"great hash from part {i}" for i in range(1, max(parts, 1) + 1)},
        "threadTexts": {}, "head": "# Topic\n", "packet": "" if parts else "### [t:t1] thread\n- [c:c1] great hash from part 1",
        "single": {"threads": 1, "comments": 1}, "batches": batches, "notes": {}, "skipped": [],
        "usage": {"calls": 0, "input": 0, "output": 0, "cost": 0.0, "costKnown": False},
    }


GUIDE = {"headline": "H", "lede": "", "quick_picks": [], "trends": [], "brands": [], "avoid": [], "tips": [],
         "glossary": [], "faq": [], "products": [{"id": "x", "ref": "", "brand": "B", "name": "N", "kind": "hash",
                                                  "tier": "A", "score": 8, "lean": "unknown", "flavour": "", "effects": "",
                                                  "verdict": "v", "pros": [], "cons": [], "threads": ["t1"],
                                                  "quotes": [{"text": "great hash from part 1", "thread": "t1", "comment": "c1"}]}]}


class PauseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def fake_ask(self, fail_parts=(), fail_final=False, calls=None):
        import llm

        def ask(provider, *, prompt, schema, **_):
            final = schema is research.REPORT_SCHEMA
            part = None if final else int(prompt.split("part ", 1)[1].split(" ", 1)[0])
            if calls is not None:
                calls.append((provider, "final" if final else part))
            if (final and fail_final) or part in fail_parts:
                raise llm.LimitError("You've hit your usage limit. Try again at Sep 26th, 7:21 PM.", provider)
            data = json.loads(json.dumps(GUIDE)) if final else {"products": [], "brands": [], "trends": [],
                                                                   "warnings": [], "questions": [], "tips": []}
            return {"data": data, "model": f"{provider}-model", "cost": 0.1, "tokens": {"input": 10, "output": 2},
                    "seconds": 1}
        return ask

    def test_limit_pauses_and_keeps_finished_parts(self) -> None:
        import llm
        with mock.patch.object(llm, "ask", self.fake_ask(fail_parts=(2,))):
            with self.assertRaises(research.Paused) as caught:
                research.write(fake_state(3), provider="codex", out_dir=self.out)
        self.assertEqual(caught.exception.checkpoint, "hash-20260101T000000Z")
        self.assertEqual(caught.exception.resets, "Sep 26th, 7:21 PM")
        saved = research.read_checkpoint(self.out, "hash-20260101T000000Z")
        self.assertEqual(saved["status"], "paused")
        self.assertEqual(sorted(saved["notes"]), ["1", "3"])
        meta = research.list_checkpoints(self.out)[0]
        self.assertEqual((meta["partsDone"], meta["parts"], meta["resets"]), (2, 3, "Sep 26th, 7:21 PM"))
        self.assertFalse(list((self.out / "reports").glob("*.json")) if (self.out / "reports").exists() else [])

    def test_resume_with_another_writer_reads_only_missing_parts(self) -> None:
        import llm
        with mock.patch.object(llm, "ask", self.fake_ask(fail_parts=(2,))):
            with self.assertRaises(research.Paused):
                research.write(fake_state(3), provider="codex", out_dir=self.out)
        calls = []
        with mock.patch.object(llm, "ask", self.fake_ask(calls=calls)):
            path = research.resume("hash-20260101T000000Z", provider="claude", out_dir=self.out)
        self.assertEqual(calls, [("claude", 2), ("claude", "final")])
        document = json.loads(path.read_text())
        self.assertEqual(document["writer"]["by"], "claude")
        self.assertEqual(document["stats"]["parts"], 3)
        self.assertIn("Codex (codex-model) ×2", document["writer"]["note"])
        self.assertEqual(len(document["guide"]["products"][0]["quotes"]), 1)
        self.assertEqual(research.list_checkpoints(self.out), [])

    def test_quick_run_paused_at_the_final_call_can_continue(self) -> None:
        import llm
        with mock.patch.object(llm, "ask", self.fake_ask(fail_final=True)):
            with self.assertRaises(research.Paused):
                research.write(fake_state(), provider="grok", out_dir=self.out)
        with mock.patch.object(llm, "ask", self.fake_ask()):
            path = research.resume("hash-20260101T000000Z", provider="grok", out_dir=self.out)
        self.assertEqual(json.loads(path.read_text())["writer"]["by"], "grok")

    def test_other_failures_still_fall_back_to_counts(self) -> None:
        import llm

        def broken(*_a, **_k):
            raise llm.ModelError("schema mismatch")

        with mock.patch.object(llm, "ask", broken):
            path = research.write(fake_state(), provider="claude", out_dir=self.out)
        self.assertEqual(json.loads(path.read_text())["writer"]["by"], "counts")
        self.assertEqual(research.list_checkpoints(self.out), [])

    def test_stop_keeps_what_was_read(self) -> None:
        import llm
        stop = threading.Event()

        def ask(provider, *, prompt, schema, **_):
            part = int(prompt.split("part ", 1)[1].split(" ", 1)[0])
            if part == 1:
                return {"data": {"products": [], "brands": [], "trends": [], "warnings": [], "questions": [], "tips": []},
                        "model": "m", "cost": None, "tokens": {}, "seconds": 1}
            stop.set()
            raise research.Cancelled()

        state = fake_state(2)
        research.DEPTHS["deep"]["parallel"], saved_parallel = 1, research.DEPTHS["deep"]["parallel"]
        try:
            with mock.patch.object(llm, "ask", ask):
                with self.assertRaises(research.Cancelled):
                    research.write(state, provider="codex", out_dir=self.out, cancel=stop)
        finally:
            research.DEPTHS["deep"]["parallel"] = saved_parallel
        saved = research.read_checkpoint(self.out, state["id"])
        self.assertEqual((saved["status"], sorted(saved["notes"])), ("stopped", ["1"]))

    def test_empty_guide_is_retried_then_refused(self) -> None:
        import llm
        calls = []

        def empty_guide(provider, *, prompt, schema, **_):
            calls.append("retry" if "Your previous answer was empty" in prompt else "first")
            data = json.loads(json.dumps(GUIDE))
            data["products"] = []
            data["headline"] = "Reading the rest of the packet"
            return {"data": data, "model": "m", "cost": None, "tokens": {}, "seconds": 1}

        with mock.patch.object(llm, "ask", empty_guide):
            path = research.write(fake_state(), provider="claude", out_dir=self.out)
        document = json.loads(path.read_text())
        self.assertEqual(calls, ["first", "retry"])
        self.assertEqual(document["writer"]["by"], "counts")
        self.assertIn("empty answer twice", document["writer"]["note"])

    def test_placeholder_then_real_guide_is_accepted(self) -> None:
        import llm
        answers = iter([dict(GUIDE, products=[]), GUIDE])

        def ask(provider, **_):
            return {"data": json.loads(json.dumps(next(answers))), "model": "m", "cost": None, "tokens": {}, "seconds": 1}

        with mock.patch.object(llm, "ask", ask):
            path = research.write(fake_state(), provider="claude", out_dir=self.out)
        self.assertEqual(len(json.loads(path.read_text())["guide"]["products"]), 1)

    def test_empty_notes_on_a_busy_part_are_retried(self) -> None:
        import llm
        state = fake_state(1)
        state["batches"][0]["comments"] = 40
        seen = []

        def ask(provider, *, prompt, schema, **_):
            final = schema is research.REPORT_SCHEMA
            seen.append("final" if final else ("retry" if "previous answer was empty" in prompt else "part"))
            if final:
                return {"data": json.loads(json.dumps(GUIDE)), "model": "m", "cost": None, "tokens": {}, "seconds": 1}
            empty = seen.count("part") == 1 and seen[-1] == "part"
            notes = {"products": [] if empty else [{"brand": "B", "name": "N"}], "brands": [], "trends": [],
                     "warnings": [], "questions": [], "tips": []}
            return {"data": notes, "model": "m", "cost": None, "tokens": {}, "seconds": 1}

        with mock.patch.object(llm, "ask", ask):
            research.write(state, provider="claude", out_dir=self.out)
        self.assertEqual(seen, ["part", "retry", "final"])

    def big_state(self, threads: int, comment_bytes: int, mode: str) -> dict:
        state = fake_state()
        blocks = [f"### [t:t{i}] thread {i}\n" + "".join(f"- [c:c{i}x{j} 3↑] {'word ' * (comment_bytes // 5)}\n"
                                                        for j in range(10)) for i in range(threads)]
        state["corpus"] = {}
        if mode == "single":
            state.update(mode="single", packet="# header\n## Threads\n" + "".join(blocks))
        else:
            state.update(mode="batches", depth="deep", batches=research.cut_blocks(blocks, 200_000))
        return state

    def grok_fake(self, sizes: list, notes_bytes: int = 200):
        import llm

        def ask(provider, *, prompt, schema, **_):
            size = len(prompt.encode())
            self.assertLessEqual(size, llm.PROMPT_LIMITS["grok"], "a Grok prompt went over the limit")
            sizes.append(size)
            if schema is research.REPORT_SCHEMA:
                return {"data": json.loads(json.dumps(GUIDE)), "model": "g", "cost": None, "tokens": {}, "seconds": 1}
            product = {"brand": "B", "name": "N", "ref": "", "kind": "k", "tone": "positive", "people": 3,
                       "points": ["p" * notes_bytes] * 3, "quotes": [], "threads": ["t1"]}
            return {"data": {"products": [product] * 15, "brands": [], "trends": [], "warnings": [], "questions": [],
                             "tips": []}, "model": "g", "cost": None, "tokens": {}, "seconds": 1}
        return ask

    def test_grok_one_pass_run_is_split_into_parts_that_fit(self) -> None:
        import llm
        sizes, counts = [], {}
        with mock.patch.object(llm, "ask", self.grok_fake(sizes)):
            path = research.write(self.big_state(40, 900, "single"), provider="grok", out_dir=self.out,
                                  progress=lambda stage, message, **c: counts.update(c))
        self.assertEqual(counts["parts"], counts["parts_done"], "the progress panel's totals must match the re-cut parts")
        document = json.loads(path.read_text())
        self.assertGreater(document["stats"]["parts"], 3)
        self.assertEqual(document["stats"]["commentsRead"], 400)

    def test_grok_recuts_big_parts_and_keeps_parts_already_read(self) -> None:
        import llm
        state = self.big_state(60, 900, "batches")
        self.assertTrue(any(len(b["text"].encode()) > 80_000 for b in state["batches"]))
        state["notes"] = {"1": {"data": {"products": [], "brands": [], "trends": [], "warnings": [], "questions": [],
                                         "tips": ["kept"]}, "by": "Claude (m)"}}
        first = state["batches"][0]["text"]
        with mock.patch.object(llm, "ask", self.grok_fake([])):
            research.write(state, provider="grok", out_dir=self.out)
        self.assertEqual(state["batches"][0]["text"], first)
        self.assertEqual(state["notes"]["1"]["by"], "Claude (m)")
        self.assertTrue(all(len(b["text"].encode()) <= 80_000 for b in state["batches"][1:]))

    def test_grok_notes_are_condensed_until_they_fit(self) -> None:
        import llm
        reports = []
        with mock.patch.object(llm, "ask", self.grok_fake([], notes_bytes=170)):
            research.write(self.big_state(120, 900, "single"), provider="grok", out_dir=self.out,
                           progress=lambda stage, message, **_: reports.append(message))
        self.assertTrue(any("condensing" in m for m in reports))

    def test_oversized_grok_prompt_is_refused_not_sent(self) -> None:
        import llm
        with mock.patch.object(llm, "binary", return_value="/bin/true"), mock.patch.object(llm, "_run") as run:
            with self.assertRaises(llm.ModelError):
                llm.ask("grok", system="s", prompt="x" * 90_000, schema={"type": "object"})
        run.assert_not_called()

    def test_checkpoint_names_are_checked(self) -> None:
        self.assertIsNone(research.read_checkpoint(self.out, "../../etc/passwd"))
        self.assertFalse(research.delete_checkpoint(self.out, "../x"))


class EstimateTest(unittest.TestCase):
    def job(self, **counts):
        return {"stage": "write", "llm": True, "counts": counts, "stageStarted": {}, "partSeconds": []}

    def test_uses_this_runs_pace_once_parts_finish(self) -> None:
        job = self.job(parts=29, parts_done=12, parallel=3, typical_part=None, typical_final=None)
        job["partSeconds"] = [600, 700, 800]
        estimate = research.estimate_seconds(job, 0)
        # 17 parts left, 3 at a time -> 6 rounds of the 700 s median, plus a final at 1.3x.
        self.assertEqual(estimate["seconds"], 6 * 700 + round(700 * 1.3))
        self.assertIn("3 parts so far", estimate["basis"])

    def test_falls_back_to_past_runs(self) -> None:
        job = self.job(parts=10, parts_done=0, parallel=3, typical_part=100, typical_final=200)
        self.assertEqual(research.estimate_seconds(job, 0), {"seconds": 4 * 100 + 200, "basis": "from past runs"})

    def test_no_basis_means_no_guess(self) -> None:
        self.assertIsNone(research.estimate_seconds(self.job(parts=10, parts_done=0), 0))

    def test_single_call_counts_down(self) -> None:
        job = self.job(typical_final=300)
        job["stageStarted"] = {"final": 1000}
        self.assertEqual(research.estimate_seconds(job, 1100)["seconds"], 200)

    def test_fetching_adds_fetch_pace(self) -> None:
        job = {"stage": "threads", "llm": False, "counts": {"threads_fetched": 50, "threads_total": 150},
               "stageStarted": {"threads": 0}}
        self.assertEqual(research.estimate_seconds(job, 100)["seconds"], 200)

    def test_brand_search_time_is_counted(self) -> None:
        job = {"stage": "threads", "llm": False, "counts": {"threads_fetched": 100, "threads_total": 100,
               "searches_done": 4, "searches_total": 24}, "stageStarted": {"threads": 0, "searches": 100}}
        # 4 searches in 60 s -> 15 s each, 20 left.
        self.assertEqual(research.estimate_seconds(job, 160)["seconds"], 300)

    def test_timing_history_is_kept_per_writer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            key = research.timing_key("grok", "grok-4.7", "xhigh")
            for seconds in (300, 900, 600):
                research.record_timing(out, key, "part", seconds)
            self.assertEqual(research.typical_timing(out, key, "part"), 600)
            self.assertIsNone(research.typical_timing(out, research.timing_key("claude", "", ""), "part"))


class ServerResearchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.research = root / "research"
        handler = serve.make_handler(Path(serve.__file__).resolve().parent, root / "d.json", root / "b", self.research)
        handler.log_message = lambda *args: None
        self.server = serve.ReusableTcpServer(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        payload = json.dumps(body).encode() if body is not None else None
        connection.request(method, path, body=payload, headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response.status, (json.loads(data) if data else None)

    def plant_report(self, name="hash-20260101T000000Z.json"):
        folder = self.research / "reports"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_text(json.dumps({"topic": {"label": "Hash"}, "guide": {"headline": "H", "products": []}}))
        return name

    def test_overview_lists_topics_and_reports(self) -> None:
        name = self.plant_report()
        status, body = self.request("GET", "/api/research")
        self.assertEqual(status, 200)
        self.assertIn("live-carts", [t["key"] for t in body["topics"]])
        self.assertEqual([r["name"] for r in body["reports"]], [name])
        self.assertNotIn("binary", body["llm"])

    def test_cross_site_start_is_refused(self) -> None:
        status, _ = self.request("POST", "/api/research/jobs", {"topic": "hash"}, {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.request("POST", "/api/research/jobs", {"topic": "hash"}, {"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)

    def test_bad_topic_is_400(self) -> None:
        status, body = self.request("POST", "/api/research/jobs", {"topic": "nope"})
        self.assertEqual(status, 400)
        self.assertIn("topic", body["error"])

    def test_report_names_are_checked(self) -> None:
        for bad in ("../d.json", "%2e%2e%2fd.json", "x.json"):
            self.assertEqual(self.request("GET", f"/api/research/reports/{bad}")[0], 404)
            self.assertEqual(self.request("DELETE", f"/api/research/reports/{bad}")[0], 404)

    def test_read_and_delete_a_report(self) -> None:
        name = self.plant_report()
        status, body = self.request("GET", f"/api/research/reports/{name}")
        self.assertEqual((status, body["report"]["guide"]["headline"]), (200, "H"))
        self.assertEqual(self.request("DELETE", f"/api/research/reports/{name}")[0], 200)
        self.assertEqual(self.request("GET", f"/api/research/reports/{name}")[0], 404)

    def test_archive_flag_is_stored_in_the_guide(self) -> None:
        name = self.plant_report()
        self.assertEqual(self.request("POST", f"/api/research/reports/{name}/archive", {"archived": True})[0], 200)
        reports = self.request("GET", "/api/research")[1]["reports"]
        self.assertTrue(reports[0]["archived"])
        self.assertTrue(json.loads((self.research / "reports" / name).read_text())["archived"])
        self.request("POST", f"/api/research/reports/{name}/archive", {"archived": False})
        self.assertFalse(self.request("GET", "/api/research")[1]["reports"][0]["archived"])
        self.assertEqual(self.request("POST", "/api/research/reports/nope.json/archive", {"archived": True})[0], 404)
        status, _ = self.request("POST", f"/api/research/reports/{name}/archive", {"archived": True},
                                 {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)

    def test_bad_model_is_400_and_unknown_provider_models_400(self) -> None:
        status, body = self.request("POST", "/api/research/jobs", {"topic": "hash", "provider": "claude", "model": "a b"})
        self.assertEqual(status, 400)
        self.assertEqual(self.request("GET", "/api/research/models?provider=gemini")[0], 400)

    def test_paused_runs_are_listed_resumed_and_discarded(self) -> None:
        state = fake_state(2)
        state.update(status="paused", reason="usage limit", resets="3pm", notes={"1": {"data": {}, "by": "Codex (m)"}})
        research.save_checkpoint(self.research, state)
        overview = self.request("GET", "/api/research")[1]
        self.assertEqual(overview["checkpoints"][0]["id"], state["id"])
        self.assertEqual(overview["checkpoints"][0]["partsDone"], 1)
        # Continuing needs a writer, and a real checkpoint.
        self.assertEqual(self.request("POST", "/api/research/resume", {"checkpoint": state["id"], "provider": "none"})[0], 400)
        self.assertEqual(self.request("POST", "/api/research/resume", {"checkpoint": "nope-20260101T000000Z",
                                                                       "provider": "claude"})[0], 400)
        status, _ = self.request("POST", "/api/research/resume", {"checkpoint": state["id"], "provider": "claude"},
                                 {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertEqual(self.request("DELETE", f"/api/research/checkpoints/{state['id']}")[0], 200)
        self.assertEqual(self.request("GET", "/api/research")[1]["checkpoints"], [])
        self.assertEqual(self.request("DELETE", "/api/research/checkpoints/..%2Fx")[0], 404)

    def test_job_runs_once_at_a_time_and_finishes(self) -> None:
        release = threading.Event()

        def fake_run(topic_key, query, *, out_dir, progress, cancel, **_):
            progress("reddit", "pretending", posts_scanned=5)
            release.wait(5)
            return Path(out_dir) / "reports" / self.plant_report()

        with mock.patch.object(research, "run", fake_run):
            status, body = self.request("POST", "/api/research/jobs", {"topic": "hash", "provider": "none"})
            self.assertEqual((status, body["job"]["status"]), (202, "running"))
            self.assertEqual(self.request("POST", "/api/research/jobs", {"topic": "flower"})[0], 409)
            release.set()
            for _ in range(50):
                job = self.request("GET", "/api/research")[1]["job"]
                if job["status"] != "running":
                    break
                time.sleep(0.05)
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["report"], "hash-20260101T000000Z.json")
        self.assertEqual(job["counts"]["posts_scanned"], 5)


if __name__ == "__main__":
    unittest.main()
