/*
 * SlowTyper engine: pure functions that turn a string into a timed list of
 * keystroke actions. No DOM access here, so it runs in the content script,
 * the popup, the service worker and Node tests alike.
 *
 * Action shapes:
 *   { kind: 'type', ch, delay, index? }   index = position in the source text
 *                                         (absent for typo keystrokes)
 *   { kind: 'backspace', delay }
 * `delay` is the wait in ms BEFORE the action runs.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SlowTyperEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    wpm: 45,          // overall speed, including pauses and typo fixes
    variance: 35,     // 0-100: how uneven each keystroke is
    typoRate: 2,      // 0-10: % of letters that get a corrected mistake
    bursts: true,     // fast runs of keys followed by a short gap
    pauses: true,     // occasional "thinking" pauses between words
    startDelay: 3,    // seconds before typing begins
    method: 'standard', // 'standard' | 'trusted'
  });

  const MIN_DELAY = 12;

  // --- RNG ------------------------------------------------------------------

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rand) {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }

  // Log-normal multiplier centred on 1, so delays skew long like real typing.
  function jitter(variance, rand) {
    if (variance <= 0) return 1;
    const m = Math.exp(gaussian(rand) * variance * 0.7);
    return Math.min(4, Math.max(0.25, m));
  }

  // --- Keyboard layout --------------------------------------------------------

  const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const ROW_OFFSET = [0, 0.25, 0.75];

  const NEIGHBORS = (function build() {
    const pos = {};
    ROWS.forEach((row, r) => {
      for (let i = 0; i < row.length; i++) pos[row[i]] = { r, x: i + ROW_OFFSET[r] };
    });
    const out = {};
    for (const a of Object.keys(pos)) {
      out[a] = Object.keys(pos).filter((b) => {
        if (a === b) return false;
        const dr = Math.abs(pos[a].r - pos[b].r);
        const dx = Math.abs(pos[a].x - pos[b].x);
        return (dr === 0 && dx <= 1) || (dr === 1 && dx <= 0.8);
      }).join('');
    }
    return out;
  })();

  function isAsciiLetter(ch) {
    return typeof ch === 'string' && /^[a-z]$/i.test(ch);
  }

  function neighborKey(ch, rand) {
    const lower = ch.toLowerCase();
    const list = NEIGHBORS[lower];
    if (!list) return null;
    const pick = list[Math.floor(rand() * list.length)];
    return ch === lower ? pick : pick.toUpperCase();
  }

  // KeyboardEvent-style info for a character (US layout).
  const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';
  const PUNCT_CODES = {
    '`': 'Backquote', '~': 'Backquote', '-': 'Minus', _: 'Minus', '=': 'Equal', '+': 'Equal',
    '[': 'BracketLeft', '{': 'BracketLeft', ']': 'BracketRight', '}': 'BracketRight',
    '\\': 'Backslash', '|': 'Backslash', ';': 'Semicolon', ':': 'Semicolon',
    "'": 'Quote', '"': 'Quote', ',': 'Comma', '<': 'Comma', '.': 'Period', '>': 'Period',
    '/': 'Slash', '?': 'Slash',
    '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', $: 'Digit4', '%': 'Digit5',
    '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
  };
  const PUNCT_KEYCODES = {
    Backquote: 192, Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221,
    Backslash: 220, Semicolon: 186, Quote: 222, Comma: 188, Period: 190, Slash: 191,
  };

  function keyInfo(ch) {
    if (ch === '\n') return { key: 'Enter', code: 'Enter', keyCode: 13, shift: false, text: '\r' };
    if (ch === '\b') return { key: 'Backspace', code: 'Backspace', keyCode: 8, shift: false, text: '' };
    if (ch === '\t') return { key: 'Tab', code: 'Tab', keyCode: 9, shift: false, text: '\t' };
    if (ch === ' ') return { key: ' ', code: 'Space', keyCode: 32, shift: false, text: ' ' };
    if (isAsciiLetter(ch)) {
      const up = ch.toUpperCase();
      return { key: ch, code: 'Key' + up, keyCode: up.charCodeAt(0), shift: ch === up, text: ch };
    }
    if (/^[0-9]$/.test(ch)) {
      return { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), shift: false, text: ch };
    }
    const code = PUNCT_CODES[ch];
    if (code) {
      const keyCode = code.startsWith('Digit') ? code.charCodeAt(5) : PUNCT_KEYCODES[code];
      return { key: ch, code, keyCode, shift: SHIFTED.includes(ch), text: ch };
    }
    // Accented letters, emoji, etc.: no physical key on a US layout.
    return { key: ch, code: '', keyCode: 0, shift: false, text: ch };
  }

  // --- Planning ---------------------------------------------------------------

  function normalizeText(text) {
    return Array.from(String(text || '').replace(/\r\n?/g, '\n'));
  }

  function baseDelay(wpm) {
    return 60000 / (Math.max(1, wpm) * 5);
  }

  // Extra time spent before `ch` given what came before it.
  function contextPause(prev, ch, base, o, rand) {
    let extra = 0;
    if (ch === '\n' || prev === '\n') extra += base * (5 + rand() * 10);
    else if (/[.!?]/.test(prev) && ch === ' ') extra += base * (3 + rand() * 6);
    else if (/[,;:]/.test(prev) && ch === ' ') extra += base * (1.5 + rand() * 3);
    else if (prev === ' ') extra += base * rand() * 0.8; // word start
    if (o.pauses && (prev === ' ' || prev === '\n') && rand() < 0.02) {
      extra += 700 + rand() * 2800; // stopping to think
    }
    return extra;
  }

  /**
   * Build the full keystroke plan for `text`.
   * Delays are scaled so the plan's total time equals what the WPM promises:
   * chars / 5 / wpm minutes.
   */
  function plan(text, options, rand) {
    const o = Object.assign({}, DEFAULTS, options);
    rand = rand || Math.random;
    const chars = normalizeText(text);
    const base = baseDelay(o.wpm);
    const v = Math.min(100, Math.max(0, o.variance)) / 100;
    const typoP = Math.min(10, Math.max(0, o.typoRate)) / 100;
    const key = () => base * jitter(v, rand);
    const actions = [];

    let burstLeft = 0;
    let burstFactor = 1;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const prev = i > 0 ? chars[i - 1] : null;

      let d = key();
      if (o.bursts) {
        if (burstLeft > 0) {
          d *= burstFactor;
          burstLeft--;
          if (burstLeft === 0) d += base * (0.8 + rand() * 1.5); // gap after a burst
        } else if (rand() < 0.07) {
          burstLeft = 4 + Math.floor(rand() * 18);
          burstFactor = 0.45 + rand() * 0.3;
        }
      }
      if (prev !== null) d += contextPause(prev, ch, base, o, rand);

      if (isAsciiLetter(ch) && rand() < typoP) {
        const next = chars[i + 1];
        let wrong;
        if (isAsciiLetter(next) && next.toLowerCase() !== ch.toLowerCase() && rand() < 0.2) {
          wrong = [next, ch]; // transposed pair, e.g. "teh"
        } else {
          const nb = neighborKey(ch, rand);
          wrong = nb ? [nb] : null;
        }
        if (wrong) {
          // Sometimes keep going a key or two before noticing the mistake.
          let extra = wrong.length === 1 ? Math.floor(rand() * 3) : 0;
          let k = 0;
          while (k < extra && chars[i + 1 + k] !== undefined && chars[i + 1 + k] !== '\n') k++;
          extra = k;

          actions.push({ kind: 'type', ch: wrong[0], delay: d });
          for (let w = 1; w < wrong.length; w++) actions.push({ kind: 'type', ch: wrong[w], delay: key() });
          for (let e = 1; e <= extra; e++) actions.push({ kind: 'type', ch: chars[i + e], delay: key() });

          const fixes = wrong.length + extra;
          actions.push({ kind: 'backspace', delay: base * 1.2 + 200 + rand() * 450 });
          for (let b = 1; b < fixes; b++) actions.push({ kind: 'backspace', delay: base * 0.5 * jitter(v, rand) });
          d = key() * 1.2;
        }
      }

      actions.push({ kind: 'type', ch, delay: d, index: i });
    }

    // Calibrate so the overall rate matches the chosen WPM.
    const raw = actions.reduce((s, a) => s + a.delay, 0);
    const target = chars.length * base;
    const scale = raw > 0 ? target / raw : 1;
    for (const a of actions) a.delay = Math.max(MIN_DELAY, Math.round(a.delay * scale));

    return actions;
  }

  function totalMs(actions) {
    return actions.reduce((s, a) => s + a.delay, 0);
  }

  // Fast estimate without building a plan (the plan is calibrated to this).
  function estimateMs(text, options) {
    const o = Object.assign({}, DEFAULTS, options);
    return normalizeText(text).length * baseDelay(o.wpm) + o.startDelay * 1000;
  }

  // WPM needed to finish `text` in `minutes` (not counting the start delay).
  function wpmForDuration(text, minutes) {
    const n = normalizeText(text).length;
    if (!n || !(minutes > 0)) return null;
    return n / 5 / minutes;
  }

  // Replay a plan into a plain string. Used by tests and as a sanity check.
  function replay(actions) {
    const out = [];
    for (const a of actions) {
      if (a.kind === 'type') out.push(a.ch);
      else out.pop();
    }
    return out.join('');
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
    return `${sec}s`;
  }

  return {
    DEFAULTS, NEIGHBORS, mulberry32, jitter, keyInfo, isAsciiLetter, neighborKey,
    normalizeText, baseDelay, plan, totalMs, estimateMs, wpmForDuration, replay, formatDuration,
  };
});
