"""Keystroke planner: turns text into a timed list of key actions.

Python port of src/engine.js (the browser extension's planner). Keep the two
in step: same constants, same model.

An action is a tuple (kind, char, delay_ms, index):
  kind   'type' or 'backspace'
  char   the character to type ('' for backspace)
  delay  ms to wait BEFORE the action
  index  position in the source text for correct keystrokes, else None
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Callable, List, NamedTuple, Optional


@dataclass
class Options:
    wpm: float = 45          # overall speed, including pauses and typo fixes
    variance: float = 35     # 0-100: how uneven each keystroke is
    typo_rate: float = 2     # 0-10: % of letters that get a corrected mistake
    bursts: bool = True      # fast runs of keys followed by a short gap
    pauses: bool = True      # occasional "thinking" pauses between words


class Action(NamedTuple):
    kind: str
    char: str
    delay: int
    index: Optional[int]


MIN_DELAY = 12

ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
ROW_OFFSET = [0, 0.25, 0.75]


def _build_neighbors() -> dict:
    pos = {}
    for r, row in enumerate(ROWS):
        for i, ch in enumerate(row):
            pos[ch] = (r, i + ROW_OFFSET[r])
    out = {}
    for a, (ra, xa) in pos.items():
        near = []
        for b, (rb, xb) in pos.items():
            if a == b:
                continue
            dr, dx = abs(ra - rb), abs(xa - xb)
            if (dr == 0 and dx <= 1) or (dr == 1 and dx <= 0.8):
                near.append(b)
        out[a] = "".join(near)
    return out


NEIGHBORS = _build_neighbors()


def is_ascii_letter(ch: Optional[str]) -> bool:
    return bool(ch) and len(ch) == 1 and ch.isascii() and ch.isalpha()


def neighbor_key(ch: str, rand: Callable[[], float]) -> Optional[str]:
    lower = ch.lower()
    near = NEIGHBORS.get(lower)
    if not near:
        return None
    pick = near[int(rand() * len(near))]
    return pick if ch == lower else pick.upper()


def normalize_text(text: str) -> List[str]:
    return list((text or "").replace("\r\n", "\n").replace("\r", "\n"))


def base_delay(wpm: float) -> float:
    return 60000 / (max(1.0, wpm) * 5)


def _gaussian(rand: Callable[[], float]) -> float:
    u = 0.0
    while u == 0.0:
        u = rand()
    return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * rand())


def jitter(variance: float, rand: Callable[[], float]) -> float:
    """Log-normal multiplier around 1, so delays skew long like real typing."""
    if variance <= 0:
        return 1.0
    m = math.exp(_gaussian(rand) * variance * 0.7)
    return min(4.0, max(0.25, m))


def _context_pause(prev: str, ch: str, base: float, o: Options, rand) -> float:
    extra = 0.0
    if ch == "\n" or prev == "\n":
        extra += base * (5 + rand() * 10)
    elif prev in ".!?" and ch == " ":
        extra += base * (3 + rand() * 6)
    elif prev in ",;:" and ch == " ":
        extra += base * (1.5 + rand() * 3)
    elif prev == " ":
        extra += base * rand() * 0.8  # start of a word
    if o.pauses and prev in (" ", "\n") and rand() < 0.02:
        extra += 700 + rand() * 2800  # stopping to think
    return extra


def plan(text: str, opts: Optional[Options] = None,
         rand: Optional[Callable[[], float]] = None) -> List[Action]:
    """Build the whole keystroke plan. Delays are scaled so the total time is
    exactly chars / 5 / wpm minutes."""
    o = opts or Options()
    rand = rand or random.random
    chars = normalize_text(text)
    base = base_delay(o.wpm)
    v = min(100.0, max(0.0, o.variance)) / 100
    typo_p = min(10.0, max(0.0, o.typo_rate)) / 100

    def key() -> float:
        return base * jitter(v, rand)

    raw: list = []  # [kind, char, delay, index]
    burst_left = 0
    burst_factor = 1.0

    for i, ch in enumerate(chars):
        prev = chars[i - 1] if i > 0 else None

        d = key()
        if o.bursts:
            if burst_left > 0:
                d *= burst_factor
                burst_left -= 1
                if burst_left == 0:
                    d += base * (0.8 + rand() * 1.5)  # gap after a burst
            elif rand() < 0.07:
                burst_left = 4 + int(rand() * 18)
                burst_factor = 0.45 + rand() * 0.3
        if prev is not None:
            d += _context_pause(prev, ch, base, o, rand)

        if is_ascii_letter(ch) and rand() < typo_p:
            nxt = chars[i + 1] if i + 1 < len(chars) else None
            wrong = None
            if is_ascii_letter(nxt) and nxt.lower() != ch.lower() and rand() < 0.2:
                wrong = [nxt, ch]  # swapped pair, like "teh"
            else:
                nb = neighbor_key(ch, rand)
                wrong = [nb] if nb else None
            if wrong:
                # Sometimes keep going a key or two before noticing.
                extra = int(rand() * 3) if len(wrong) == 1 else 0
                k = 0
                while k < extra and i + 1 + k < len(chars) and chars[i + 1 + k] != "\n":
                    k += 1
                extra = k

                raw.append(["type", wrong[0], d, None])
                for w in wrong[1:]:
                    raw.append(["type", w, key(), None])
                for e in range(1, extra + 1):
                    raw.append(["type", chars[i + e], key(), None])

                fixes = len(wrong) + extra
                raw.append(["backspace", "", base * 1.2 + 200 + rand() * 450, None])
                for _ in range(1, fixes):
                    raw.append(["backspace", "", base * 0.5 * jitter(v, rand), None])
                d = key() * 1.2

        raw.append(["type", ch, d, i])

    total = sum(a[2] for a in raw)
    target = len(chars) * base
    scale = target / total if total > 0 else 1.0
    return [Action(k, c, max(MIN_DELAY, round(d * scale)), idx) for k, c, d, idx in raw]


def total_ms(actions: List[Action]) -> int:
    return sum(a.delay for a in actions)


def estimate_ms(text: str, wpm: float) -> float:
    return len(normalize_text(text)) * base_delay(wpm)


def wpm_for_duration(text: str, minutes: float) -> Optional[float]:
    n = len(normalize_text(text))
    if not n or minutes <= 0:
        return None
    return n / 5 / minutes


def replay(actions: List[Action]) -> str:
    out: List[str] = []
    for a in actions:
        if a.kind == "type":
            out.append(a.char)
        elif out:
            out.pop()
    return "".join(out)


def format_duration(ms: float) -> str:
    s = max(0, round(ms / 1000))
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    if h:
        return f"{h}h {m}m"
    if m:
        return f"{m}m {sec:02d}s"
    return f"{sec}s"
