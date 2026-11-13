import io
import random
import threading
import unittest

from slowtyper import engine as E
from slowtyper.cli import RecordingKeyboard, Runner, main

SAMPLE = "The quick brown fox jumps over the lazy dog. Then it rests, briefly!\nNew paragraph here."


def rng(seed):
    return random.Random(seed).random


class EngineTests(unittest.TestCase):
    def test_replay_reproduces_text(self):
        for seed in range(200):
            actions = E.plan(SAMPLE, E.Options(typo_rate=10), rng(seed))
            self.assertEqual(E.replay(actions), SAMPLE)

    def test_crlf_and_unicode(self):
        actions = E.plan("Café ☕\r\nnaïve 👍 ok", E.Options(typo_rate=10), rng(7))
        self.assertEqual(E.replay(actions), "Café ☕\nnaïve 👍 ok")

    def test_total_time_matches_wpm(self):
        for wpm in (20, 45, 120):
            actions = E.plan(SAMPLE, E.Options(wpm=wpm), rng(3))
            expected = len(E.normalize_text(SAMPLE)) * E.base_delay(wpm)
            ratio = E.total_ms(actions) / expected
            self.assertTrue(0.97 < ratio < 1.05, f"wpm {wpm}: {ratio}")

    def test_no_typos_no_backspaces(self):
        actions = E.plan(SAMPLE, E.Options(typo_rate=0), rng(11))
        self.assertTrue(all(a.kind == "type" for a in actions))

    def test_typo_rate_roughly_right(self):
        actions = E.plan("abcdefghij" * 500, E.Options(typo_rate=5), rng(5))
        n = sum(a.kind == "backspace" for a in actions)
        self.assertTrue(100 < n < 900, n)

    def test_variation(self):
        flat = E.Options(variance=0, bursts=False, pauses=False, typo_rate=0)
        self.assertEqual(len({a.delay for a in E.plan("a" * 20, flat, rng(1))}), 1)
        bumpy = E.Options(variance=80, bursts=False, pauses=False, typo_rate=0)
        self.assertGreater(len({a.delay for a in E.plan("a" * 20, bumpy, rng(1))}), 10)

    def test_indices_in_order(self):
        actions = E.plan(SAMPLE, E.Options(typo_rate=8), rng(9))
        self.assertEqual([a.index for a in actions if a.index is not None],
                         list(range(len(E.normalize_text(SAMPLE)))))

    def test_neighbors(self):
        self.assertIn("a", E.NEIGHBORS["s"])
        self.assertNotIn("p", E.NEIGHBORS["s"])
        r = rng(2)
        for _ in range(50):
            self.assertTrue(E.neighbor_key("G", r).isupper())

    def test_helpers(self):
        self.assertEqual(E.wpm_for_duration("a" * 500, 2), 50)
        self.assertEqual(E.format_duration(65000), "1m 05s")
        self.assertEqual(E.format_duration(3_725_000), "1h 2m")


class RunnerTests(unittest.TestCase):
    def test_runner_types_full_text(self):
        kb = RecordingKeyboard()
        actions = E.plan(SAMPLE, E.Options(typo_rate=8), rng(4))
        r = Runner(actions, kb, len(SAMPLE), sleep=lambda s: None)
        self.assertTrue(r.run())
        self.assertEqual(kb.text, SAMPLE)
        self.assertIn("\b", kb.events)
        self.assertEqual(r.remaining_ms, 0)

    def test_stop_midway(self):
        kb = RecordingKeyboard()
        actions = E.plan(SAMPLE, E.Options(typo_rate=0), rng(4))
        r = Runner(actions, kb, len(SAMPLE), sleep=lambda s: None)
        r.on_progress = lambda run: run.stop() if run.typed == 10 else None
        self.assertFalse(r.run())
        self.assertEqual(kb.text, SAMPLE[:10])

    def test_pause_blocks_until_resume(self):
        kb = RecordingKeyboard()
        actions = E.plan("hello world", E.Options(wpm=600, typo_rate=0), rng(1))
        r = Runner(actions, kb, 11)
        r.pause()
        t = threading.Thread(target=r.run)
        t.start()
        t.join(0.5)
        self.assertEqual(kb.text, "")  # nothing typed while paused
        r.resume()
        t.join(5)
        self.assertEqual(kb.text, "hello world")

    def test_corner_abort(self):
        kb = RecordingKeyboard()
        actions = E.plan(SAMPLE, E.Options(typo_rate=0), rng(4))
        r = Runner(actions, kb, len(SAMPLE), sleep=lambda s: None, should_abort=lambda: True)
        self.assertFalse(r.run())
        self.assertEqual(kb.text, "")
        self.assertIn("corner", r.abort_reason)


class CliTests(unittest.TestCase):
    def run_cli(self, argv, stdin_text=""):
        err = io.StringIO()
        kb = RecordingKeyboard()
        code = main(argv, stdin=io.StringIO(stdin_text), out=io.StringIO(), err=err, keyboard=kb)
        return code, kb, err.getvalue()

    def test_args_text(self):
        code, kb, err = self.run_cli(["Hi", "there!", "--wpm", "1000", "--delay", "0", "--seed", "1"])
        self.assertEqual(code, 0)
        self.assertEqual(kb.text, "Hi there!")
        self.assertIn("Done", err)

    def test_stdin_trailing_newline_dropped(self):
        code, kb, _ = self.run_cli(["--wpm", "1000", "-d", "0", "-t", "10"], "line one\nline two\n")
        self.assertEqual(code, 0)
        self.assertEqual(kb.text, "line one\nline two")

    def test_minutes_sets_speed(self):
        code, _, err = self.run_cli(["--dry-run", "--minutes", "1", "x" * 500])
        self.assertEqual(code, 0)
        self.assertIn("100 WPM", err)
        self.assertIn("about 1m 00s", err)

    def test_speed_out_of_range(self):
        code, _, err = self.run_cli(["--minutes", "0.001", "x" * 50])
        self.assertEqual(code, 2)
        self.assertIn("out of range", err)

    def test_dry_run(self):
        code, kb, err = self.run_cli(["--dry-run", "-t", "10"], SAMPLE)
        self.assertEqual(code, 0)
        self.assertEqual(kb.text, "")  # nothing sent to the real keyboard
        self.assertIn("matches", err)
        self.assertIn("words", err)

    def test_empty_input(self):
        code, _, err = self.run_cli([], "")
        self.assertEqual(code, 2)
        self.assertIn("no text", err)


if __name__ == "__main__":
    unittest.main()
