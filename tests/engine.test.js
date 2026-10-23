const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');

const SAMPLE = 'The quick brown fox jumps over the lazy dog. Then it rests, briefly!\nNew paragraph here.';

test('replaying a plan reproduces the text exactly', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const actions = E.plan(SAMPLE, { typoRate: 10 }, E.mulberry32(seed));
    assert.equal(E.replay(actions), SAMPLE);
  }
});

test('handles CRLF, emoji and accented text', () => {
  const text = 'Café ☕\r\nnaïve 👍🏽 ok';
  const actions = E.plan(text, { typoRate: 10 }, E.mulberry32(7));
  assert.equal(E.replay(actions), 'Café ☕\nnaïve 👍🏽 ok');
});

test('total time matches the chosen WPM', () => {
  for (const wpm of [20, 45, 120]) {
    const actions = E.plan(SAMPLE, { wpm }, E.mulberry32(3));
    const expected = E.normalizeText(SAMPLE).length * E.baseDelay(wpm);
    const ratio = E.totalMs(actions) / expected;
    assert.ok(ratio > 0.97 && ratio < 1.05, `wpm ${wpm}: ratio ${ratio}`);
  }
});

test('no typos means no backspaces', () => {
  const actions = E.plan(SAMPLE, { typoRate: 0 }, E.mulberry32(11));
  assert.ok(actions.every((a) => a.kind === 'type'));
  assert.equal(actions.length, E.normalizeText(SAMPLE).length);
});

test('typos appear at roughly the requested rate', () => {
  const text = 'abcdefghij'.repeat(500);
  const actions = E.plan(text, { typoRate: 5 }, E.mulberry32(5));
  const backspaces = actions.filter((a) => a.kind === 'backspace').length;
  assert.ok(backspaces > 100 && backspaces < 900, `backspaces: ${backspaces}`);
});

test('variation produces uneven delays; zero variation is steady', () => {
  const opts = { bursts: false, pauses: false, typoRate: 0 };
  const steady = E.plan('aaaaaaaaaaaaaaaaaaaa', Object.assign({ variance: 0 }, opts), E.mulberry32(1));
  assert.equal(new Set(steady.map((a) => a.delay)).size, 1);
  const uneven = E.plan('aaaaaaaaaaaaaaaaaaaa', Object.assign({ variance: 80 }, opts), E.mulberry32(1));
  assert.ok(new Set(uneven.map((a) => a.delay)).size > 10);
});

test('same seed gives the same plan', () => {
  const a = E.plan(SAMPLE, {}, E.mulberry32(42));
  const b = E.plan(SAMPLE, {}, E.mulberry32(42));
  assert.deepEqual(a, b);
});

test('every correct keystroke carries its source index in order', () => {
  const actions = E.plan(SAMPLE, { typoRate: 8 }, E.mulberry32(9));
  const idx = actions.filter((a) => a.index !== undefined).map((a) => a.index);
  assert.deepEqual(idx, [...Array(E.normalizeText(SAMPLE).length).keys()]);
});

test('neighbor keys are adjacent letters and keep case', () => {
  assert.ok(E.NEIGHBORS.s.includes('a') && E.NEIGHBORS.s.includes('d') && E.NEIGHBORS.s.includes('w'));
  assert.ok(!E.NEIGHBORS.s.includes('p'));
  const r = E.mulberry32(2);
  for (let i = 0; i < 50; i++) assert.match(E.neighborKey('G', r), /^[A-Z]$/);
});

test('keyInfo maps common keys', () => {
  assert.deepEqual(E.keyInfo('a'), { key: 'a', code: 'KeyA', keyCode: 65, shift: false, text: 'a' });
  assert.equal(E.keyInfo('A').shift, true);
  assert.equal(E.keyInfo('?').code, 'Slash');
  assert.equal(E.keyInfo('?').shift, true);
  assert.equal(E.keyInfo('!').keyCode, 49);
  assert.equal(E.keyInfo('\n').key, 'Enter');
  assert.equal(E.keyInfo('é').code, '');
});

test('duration helpers', () => {
  assert.equal(E.wpmForDuration('a'.repeat(500), 2), 50);
  assert.equal(E.formatDuration(65000), '1m 05s');
  assert.equal(E.formatDuration(3_725_000), '1h 2m');
  assert.equal(E.formatDuration(4000), '4s');
});
