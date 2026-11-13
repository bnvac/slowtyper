"""slowtyper: type text into whatever window has focus, at a human pace."""
from __future__ import annotations

import argparse
import os
import random
import sys
import threading
import time
from typing import Callable, List, Optional, TextIO

from . import __version__
from .engine import (Action, Options, estimate_ms, format_duration, normalize_text,
                     plan, total_ms, wpm_for_duration)

PAUSE_KEY = "f8"
STOP_KEY = "f9"


# --- Keyboard backends ---------------------------------------------------------

class X11Unicode:
    """Types characters that aren't on the keyboard layout (é, —, “, ’) on X11.

    pynput packs up to four borrowed characters onto one spare keycode and
    picks them with modifier levels 3/4, which many setups can't reach, so the
    wrong character comes out ("ñ ü" -> "ñ ñ"). Instead, like xdotool, map the
    character to all four levels of a spare keycode, rotating through the free
    keycodes so one is never remapped back-to-back. Original (empty) mappings
    are restored on close().
    """

    def __init__(self):
        from Xlib import X, display
        from Xlib.ext import xtest
        self.X, self.xtest = X, xtest
        self.d = display.Display()
        lo, hi = self.d.display.info.min_keycode, self.d.display.info.max_keycode
        mapping = self.d.get_keyboard_mapping(lo, hi - lo + 1)
        self.free = [lo + i for i, syms in enumerate(mapping) if not any(syms)]
        if not self.free:
            raise RuntimeError("no free keycodes")
        self.width = len(mapping[0])
        self.n = 0
        self.used = set()

    @staticmethod
    def keysym(ch: str) -> int:
        cp = ord(ch)
        # Latin-1 keysyms equal the code point; everything else uses the
        # Unicode keysym range.
        return cp if 0x20 <= cp <= 0x7E or 0xA0 <= cp <= 0xFF else 0x01000000 | cp

    def type(self, ch: str, hold: float) -> None:
        kc = self.free[self.n % len(self.free)]
        self.n += 1
        self.used.add(kc)
        self.d.change_keyboard_mapping(kc, [(self.keysym(ch),) * self.width])
        self.d.sync()
        time.sleep(0.005)  # let clients see the MappingNotify first
        self.xtest.fake_input(self.d, self.X.KeyPress, kc)
        self.d.sync()
        time.sleep(hold)
        self.xtest.fake_input(self.d, self.X.KeyRelease, kc)
        self.d.sync()

    def close(self) -> None:
        for kc in self.used:
            self.d.change_keyboard_mapping(kc, [(0,) * self.width])
        self.used.clear()
        self.d.sync()


class PynputKeyboard:
    """Sends real OS key events with pynput (Windows, macOS, Linux/X11)."""

    def __init__(self, newline: str = "enter"):
        try:
            from pynput.keyboard import Controller, Key
        except Exception as e:  # ImportError, or no display on Linux
            raise SystemExit(
                "slowtyper: could not load the keyboard library (pynput).\n"
                f"  {e}\n"
                "  Install it with:  pip install pynput\n"
                "  On Linux you need a graphical X11 session (DISPLAY set)."
            )
        self.kb = Controller()
        self.Key = Key
        self.newline = newline
        self.skipped: List[str] = []
        self.x11 = None
        if sys.platform.startswith("linux"):
            try:
                self.x11 = X11Unicode()
            except Exception:
                self.x11 = None  # fall back to pynput's own method

    def _tap(self, key, hold: float) -> None:
        self.kb.press(key)
        time.sleep(hold)
        self.kb.release(key)

    def type_char(self, ch: str, hold: float) -> None:
        K = self.Key
        if ch == "\n":
            if self.newline == "shift-enter":
                with self.kb.pressed(K.shift):
                    self._tap(K.enter, hold)
            else:
                self._tap(K.enter, hold)
        elif ch == "\t":
            self._tap(K.tab, hold)
        elif ch == " ":
            self._tap(K.space, hold)
        elif ch.isascii() and ch.isalnum():
            # Real press/hold/release so key-down time looks human.
            if ch.isupper():
                with self.kb.pressed(K.shift):
                    self._tap(ch.lower(), hold)
            else:
                self._tap(ch, hold)
        elif self.x11 and not (ch.isascii() and ch.isprintable()):
            self.x11.type(ch, hold)
        else:
            # Symbols, accents, emoji: let pynput pick the right method per OS.
            try:
                self.kb.type(ch)
            except Exception:
                self.skipped.append(ch)  # keep going rather than abort mid-text

    def backspace(self, hold: float) -> None:
        self._tap(self.Key.backspace, hold)

    def release_all(self) -> None:
        for k in (self.Key.shift, self.Key.ctrl, self.Key.alt):
            try:
                self.kb.release(k)
            except Exception:
                pass
        if self.x11:
            try:
                self.x11.close()
            except Exception:
                pass


class RecordingKeyboard:
    """Fake keyboard for --dry-run and tests: records what would be typed."""

    def __init__(self):
        self.buffer: List[str] = []
        self.events: List[str] = []
        self.skipped: List[str] = []

    def type_char(self, ch: str, hold: float) -> None:
        self.buffer.append(ch)
        self.events.append(ch)

    def backspace(self, hold: float) -> None:
        if self.buffer:
            self.buffer.pop()
        self.events.append("\b")

    def release_all(self) -> None:
        pass

    @property
    def text(self) -> str:
        return "".join(self.buffer)


# --- Runner --------------------------------------------------------------------

class Runner:
    """Plays a plan through a keyboard. pause()/resume()/stop() are thread-safe
    so a global hotkey listener can call them."""

    def __init__(self, actions: List[Action], keyboard, total_chars: int,
                 sleep: Callable[[float], None] = time.sleep,
                 on_progress: Optional[Callable[["Runner"], None]] = None,
                 should_abort: Optional[Callable[[], bool]] = None,
                 rand: Callable[[], float] = random.random):
        self.actions = actions
        self.kb = keyboard
        self.total_chars = total_chars
        self.sleep = sleep
        self.on_progress = on_progress or (lambda r: None)
        self.should_abort = should_abort or (lambda: False)
        self.rand = rand
        self.i = 0
        self.typed = 0
        self.paused = threading.Event()
        self.stopped = threading.Event()
        self.abort_reason = ""
        # suffix[i] = ms left from action i to the end
        self.suffix = [0] * (len(actions) + 1)
        for j in range(len(actions) - 1, -1, -1):
            self.suffix[j] = self.suffix[j + 1] + actions[j].delay

    @property
    def remaining_ms(self) -> int:
        return self.suffix[self.i]

    def pause(self) -> None:
        self.paused.set()
        self.on_progress(self)

    def resume(self) -> None:
        self.paused.clear()
        self.on_progress(self)

    def toggle(self) -> None:
        self.resume() if self.paused.is_set() else self.pause()

    def stop(self, reason: str = "Stopped") -> None:
        self.abort_reason = self.abort_reason or reason
        self.stopped.set()
        self.paused.clear()

    def _wait(self, ms: float) -> None:
        left = ms / 1000
        while left > 0 and not self.stopped.is_set():
            if self.should_abort():
                self.stop("Stopped: mouse moved to the top-left corner")
                return
            if self.paused.is_set():
                self.sleep(0.1)
                continue
            step = min(left, 0.1)
            self.sleep(step)
            left -= step

    def run(self) -> bool:
        """Returns True if the whole text was typed."""
        try:
            while self.i < len(self.actions) and not self.stopped.is_set():
                a = self.actions[self.i]
                # Key-down time comes out of the delay so the ETA stays exact.
                hold_ms = min(35 + self.rand() * 60, a.delay * 0.4)
                self._wait(a.delay - hold_ms)
                hold = hold_ms / 1000
                if self.stopped.is_set():
                    break
                if a.kind == "type":
                    self.kb.type_char(a.char, hold)
                else:
                    self.kb.backspace(hold)
                if a.index is not None:
                    self.typed = a.index + 1
                self.i += 1
                self.on_progress(self)
        finally:
            self.kb.release_all()
        return self.i >= len(self.actions)


# --- Terminal UI -----------------------------------------------------------------

class Progress:
    def __init__(self, stream: TextIO, hotkeys: bool):
        self.stream = stream
        self.last = 0.0
        self.hint = f"  {PAUSE_KEY.upper()} pause · {STOP_KEY.upper()} stop" if hotkeys else "  Ctrl+C stop"
        self.tty = stream.isatty()

    def __call__(self, r: Runner, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self.last < 0.25 and not r.paused.is_set():
            return
        self.last = now
        pct = int(r.typed * 100 / r.total_chars) if r.total_chars else 100
        width = 24
        fill = int(width * pct / 100)
        bar = "█" * fill + "░" * (width - fill)
        state = "PAUSED" if r.paused.is_set() else f"{format_duration(r.remaining_ms)} left"
        line = f"[{bar}] {pct:3d}%  {r.typed}/{r.total_chars} chars  {state}{self.hint}"
        if self.tty:
            self.stream.write("\r\033[K" + line)
        elif force:
            self.stream.write(line + "\n")
        self.stream.flush()

    def done(self, msg: str) -> None:
        self.stream.write(("\r\033[K" if self.tty else "") + msg + "\n")
        self.stream.flush()


def start_hotkeys(runner: Runner, err: TextIO):
    """Global F8/F9 hotkeys that work while another window has focus."""
    try:
        from pynput import keyboard
    except Exception:
        return None
    pause_k = getattr(keyboard.Key, PAUSE_KEY)
    stop_k = getattr(keyboard.Key, STOP_KEY)

    def on_press(key):
        if key == pause_k:
            runner.toggle()
        elif key == stop_k:
            runner.stop()

    try:
        listener = keyboard.Listener(on_press=on_press)
        listener.daemon = True
        listener.start()
        return listener
    except Exception as e:
        err.write(f"(hotkeys unavailable: {e}; use Ctrl+C in this terminal to stop)\n")
        return None


def corner_failsafe():
    """Returns a check that is True when the mouse is in the top-left corner."""
    try:
        from pynput.mouse import Controller
        mouse = Controller()
    except Exception:
        return None

    def check() -> bool:
        try:
            x, y = mouse.position
            return x <= 2 and y <= 2
        except Exception:
            return False
    return check


def platform_warnings() -> List[str]:
    notes = []
    if sys.platform == "darwin":
        notes.append("macOS: allow your terminal app under System Settings → Privacy & Security → "
                     "Accessibility (and Input Monitoring for the F8/F9 hotkeys), or nothing gets typed.")
    if sys.platform.startswith("linux") and os.environ.get("XDG_SESSION_TYPE") == "wayland":
        notes.append("Wayland session detected: typing only reaches X11/XWayland apps. "
                     "Log in with an X11 (\"Xorg\") session if nothing appears.")
    return notes


# --- Input -----------------------------------------------------------------------

def read_text(args, stdin: TextIO, err: TextIO) -> str:
    if args.file:
        if args.file == "-":
            return stdin.read()
        with open(args.file, encoding="utf-8") as f:
            return f.read()
    if args.text:
        return " ".join(args.text)
    if not stdin.isatty():
        return stdin.read()
    eof = "Ctrl+Z then Enter" if os.name == "nt" else "Ctrl+D"
    err.write(f"Paste or type your text, then press {eof} on an empty line:\n")
    err.flush()
    return stdin.read()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="slowtyper",
        description="Type text into whatever window has focus, at a human pace "
                    "(variation, bursts, pauses and corrected typos).",
        epilog="Examples:\n"
               "  slowtyper                          # paste text when asked\n"
               "  slowtyper -f essay.txt --minutes 20\n"
               "  pbpaste | slowtyper --wpm 60       # macOS clipboard\n"
               "  slowtyper \"Hello there\" --delay 3\n\n"
               f"While typing: {PAUSE_KEY.upper()} pauses/resumes, {STOP_KEY.upper()} stops, or move the "
               "mouse to the top-left corner of the screen to stop.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("text", nargs="*", help="text to type (or use -f, a pipe, or paste when asked)")
    p.add_argument("-f", "--file", help="read text from a file ('-' for stdin)")
    speed = p.add_mutually_exclusive_group()
    speed.add_argument("-w", "--wpm", type=float, default=45, help="overall speed in words per minute (default 45)")
    speed.add_argument("-m", "--minutes", type=float, help="finish in this many minutes instead of a fixed WPM")
    p.add_argument("-v", "--variance", type=float, default=35, help="timing variation 0-100 (default 35)")
    p.add_argument("-t", "--typos", type=float, default=2, help="%% of letters mistyped then fixed, 0-10 (default 2)")
    p.add_argument("--no-bursts", action="store_true", help="turn off fast typing bursts")
    p.add_argument("--no-pauses", action="store_true", help="turn off thinking pauses between words")
    p.add_argument("-d", "--delay", type=float, default=5, help="seconds to switch windows before typing (default 5)")
    p.add_argument("--newline", choices=["enter", "shift-enter"], default="enter",
                   help="key for line breaks; use shift-enter for chat boxes that send on Enter")
    p.add_argument("--seed", type=int, help="random seed (repeatable runs)")
    p.add_argument("--dry-run", action="store_true", help="show the plan and estimate without typing")
    p.add_argument("-y", "--yes", action="store_true", help="skip the 'press Enter to start' prompt")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def main(argv: Optional[List[str]] = None, stdin: TextIO = sys.stdin,
         out: TextIO = sys.stdout, err: TextIO = sys.stderr, keyboard=None) -> int:
    args = build_parser().parse_args(argv)
    text = read_text(args, stdin, err)
    # Drop the single trailing newline most pastes and files end with.
    if text.endswith("\n") and not args.text:
        text = text[:-1]
        if text.endswith("\r"):
            text = text[:-1]
    chars = len(normalize_text(text))
    if not chars:
        err.write("slowtyper: no text to type\n")
        return 2

    wpm = args.wpm
    if args.minutes is not None:
        if args.minutes <= 0:
            err.write("slowtyper: --minutes must be greater than 0\n")
            return 2
        wpm = wpm_for_duration(text, args.minutes)
    if not 1 <= wpm <= 1000:
        err.write(f"slowtyper: speed of {wpm:.0f} WPM is out of range (1-1000)\n")
        return 2

    opts = Options(wpm=wpm, variance=args.variance, typo_rate=args.typos,
                   bursts=not args.no_bursts, pauses=not args.no_pauses)
    rng = random.Random(args.seed)
    actions = plan(text, opts, rng.random)
    words = len(text.split())
    backspaces = sum(1 for a in actions if a.kind == "backspace")
    err.write(f"{words} words, {chars} chars at {wpm:.0f} WPM → about "
              f"{format_duration(estimate_ms(text, wpm))} ({backspaces} typo corrections planned)\n")

    if args.dry_run:
        rec = RecordingKeyboard()
        Runner(actions, rec, chars, sleep=lambda s: None).run()
        ok = rec.text == "".join(normalize_text(text))
        err.write(f"Dry run: {len(actions)} keystrokes, {format_duration(total_ms(actions))}, "
                  f"output {'matches' if ok else 'DOES NOT match'} the input.\n")
        return 0 if ok else 1

    for note in platform_warnings():
        err.write("Note: " + note + "\n")

    kb = keyboard or PynputKeyboard(newline=args.newline)

    if not args.yes and stdin.isatty():
        err.write("Press Enter to start the countdown…")
        err.flush()
        stdin.readline()

    for left in range(int(round(args.delay)), 0, -1):
        err.write(f"\r\033[KClick into the window you want to type in… starting in {left}s")
        err.flush()
        time.sleep(1)
    err.write("\r\033[K")

    abort_check = corner_failsafe() if keyboard is None else None
    progress = Progress(err, hotkeys=keyboard is None)
    runner = Runner(actions, kb, chars, on_progress=progress, should_abort=abort_check, rand=rng.random)
    if keyboard is None:
        start_hotkeys(runner, err)

    try:
        finished = runner.run()
    except KeyboardInterrupt:
        runner.stop()
        finished = False
    progress(runner, force=True)
    skipped = getattr(kb, "skipped", [])
    if skipped:
        uniq = "".join(sorted(set(skipped)))
        err.write(f"\nNote: {len(skipped)} character(s) couldn't be typed on this system and were skipped: {uniq}\n")
    if finished:
        progress.done(f"Done: typed {chars} chars.")
        return 0
    progress.done(f"{runner.abort_reason or 'Stopped'} after {runner.typed}/{chars} chars.")
    return 130
