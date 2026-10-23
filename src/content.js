/*
 * Runs in every frame. Two jobs:
 *  1. Remember the last text box the user focused, and type into it on request.
 *  2. In the top frame only, show a small floating control with progress/ETA.
 */
(function () {
  'use strict';
  if (window.__slowTyperLoaded) return;
  window.__slowTyperLoaded = true;

  const E = globalThis.SlowTyperEngine;
  const isTop = window.top === window;

  // --- Focus tracking ---------------------------------------------------------

  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', '']);

  function editableFrom(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.tagName === 'TEXTAREA') return node.readOnly || node.disabled ? null : node;
    if (node.tagName === 'INPUT') {
      const t = (node.getAttribute('type') || '').toLowerCase();
      return TEXT_INPUT_TYPES.has(t) && !node.readOnly && !node.disabled ? node : null;
    }
    if (node.isContentEditable) {
      // Walk up to the editing host so focus checks compare the right element.
      let host = node;
      while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
      return host;
    }
    return null;
  }

  function deepActiveElement(doc) {
    let el = doc.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function isFieldFocused(el) {
    if (!el || !document.hasFocus()) return false;
    const active = deepActiveElement(document);
    return active === el || (el.contains && el.contains(active));
  }

  let target = null;

  document.addEventListener('focusin', (e) => {
    const el = editableFrom(e.composedPath ? e.composedPath()[0] : e.target);
    if (!el) return;
    target = el;
    send({ type: 'focus', label: describe(el) });
    if (run && run.state === 'paused' && run.pausedForFocus && el === run.el) {
      setTimeout(() => run && run.resume(), 500);
    }
  }, true);

  function describe(el) {
    const name = el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('name') || (el.isContentEditable ? 'rich text box' : el.tagName.toLowerCase());
    return String(name).slice(0, 60);
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (_) { /* extension reloaded; ignore */ }
  }

  // --- Typing executors -------------------------------------------------------

  function fireKey(el, type, info) {
    const ev = new KeyboardEvent(type, {
      key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode,
      charCode: type === 'keypress' ? (info.text || '').charCodeAt(0) || 0 : 0,
      shiftKey: info.shift, bubbles: true, cancelable: true, composed: true,
    });
    return el.dispatchEvent(ev); // false = page called preventDefault
  }

  function isSingleLine(el) {
    return el.tagName === 'INPUT';
  }

  function insertFallback(el, text) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  }

  function deleteFallback(el) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    if (start === end && start === 0) return true;
    el.setRangeText('', start === end ? start - 1 : start, end, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    return true;
  }

  // Standard mode: synthetic key events + execCommand. execCommand produces a
  // browser-native input event (inputType "insertText"), never a paste.
  const standardExecutor = {
    async type(el, ch) {
      if (ch === '\n' && isSingleLine(el)) ch = ' ';
      const info = E.keyInfo(ch);
      const doc = el.ownerDocument;
      const allowed = fireKey(el, 'keydown', info) && (ch === '\n' || fireKey(el, 'keypress', info));
      if (allowed) {
        let ok;
        if (ch === '\n') {
          ok = el.isContentEditable ? doc.execCommand('insertParagraph') : doc.execCommand('insertText', false, '\n');
        } else {
          ok = doc.execCommand('insertText', false, ch);
        }
        if (!ok) insertFallback(el, ch);
      }
      fireKey(el, 'keyup', info);
    },
    async backspace(el) {
      const info = E.keyInfo('\b');
      if (fireKey(el, 'keydown', info)) {
        if (!el.ownerDocument.execCommand('delete')) deleteFallback(el);
      }
      fireKey(el, 'keyup', info);
    },
    async done() {},
  };

  // Trusted mode: the service worker sends real key events through the
  // DevTools protocol. Works in editors that ignore synthetic events.
  function cdp(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!res || !res.ok) return reject(new Error((res && res.error) || 'Trusted typing failed'));
        resolve(res);
      });
    });
  }

  const trustedExecutor = {
    async prepare() { await cdp({ type: 'cdp-attach' }); },
    async type(el, ch) {
      if (ch === '\n' && isSingleLine(el)) ch = ' ';
      await cdp({ type: 'cdp-key', ch });
    },
    async backspace() { await cdp({ type: 'cdp-key', ch: '\b' }); },
    async done() { try { await cdp({ type: 'cdp-detach' }); } catch (_) { /* already gone */ } },
  };

  // --- Run controller ---------------------------------------------------------

  let run = null;

  class Run {
    constructor(el, text, opts) {
      this.el = el;
      this.opts = Object.assign({}, E.DEFAULTS, opts);
      this.actions = E.plan(text, this.opts);
      this.total = E.normalizeText(text).length;
      this.exec = this.opts.method === 'trusted' ? trustedExecutor : standardExecutor;
      // suffix[i] = ms left from action i to the end
      this.suffix = new Array(this.actions.length + 1).fill(0);
      for (let i = this.actions.length - 1; i >= 0; i--) this.suffix[i] = this.suffix[i + 1] + this.actions[i].delay;
      this.i = 0;
      this.typed = 0;
      this.state = 'countdown';
      this.stopped = false;
      this.pausedForFocus = false;
      this.message = '';
      this.resumeWaiters = [];
      this.lastReport = 0;
    }

    remainingMs() { return this.suffix[this.i]; }

    report(force) {
      const now = Date.now();
      if (!force && now - this.lastReport < 250) return;
      this.lastReport = now;
      send({
        type: 'status', state: this.state, typed: this.typed, total: this.total,
        remainingMs: this.remainingMs() + (this.countdownLeft || 0), message: this.message,
      });
    }

    pause(message, forFocus) {
      if (this.state === 'done' || this.state === 'stopped') return;
      this.state = 'paused';
      this.pausedForFocus = !!forFocus;
      this.message = message || 'Paused';
      this.report(true);
    }

    resume() {
      if (this.state !== 'paused') return;
      if (!isFieldFocused(this.el)) {
        try { this.el.focus(); } catch (_) { /* ignore */ }
      }
      if (!isFieldFocused(this.el)) {
        this.pause('Click back into the text box to continue', true);
        return;
      }
      this.state = 'typing';
      this.pausedForFocus = false;
      this.message = '';
      this.report(true);
      this.resumeWaiters.splice(0).forEach((r) => r());
    }

    stop() {
      this.stopped = true;
      this.state = 'stopped';
      this.message = 'Stopped';
      this.report(true);
      this.resumeWaiters.splice(0).forEach((r) => r());
    }

    waitResume() { return new Promise((r) => this.resumeWaiters.push(r)); }

    async sleep(ms) {
      let left = ms;
      while (left > 0 && !this.stopped) {
        if (this.state === 'paused') { await this.waitResume(); continue; }
        const step = Math.min(left, 150);
        await new Promise((r) => setTimeout(r, step));
        left -= step;
      }
    }

    async start() {
      try {
        if (this.exec.prepare) await this.exec.prepare();
      } catch (e) {
        this.state = 'error';
        this.message = e.message;
        this.report(true);
        return;
      }

      // Countdown so the popup can close and the page can take focus back.
      let left = Math.max(0, this.opts.startDelay * 1000);
      while (left > 0 && !this.stopped) {
        this.countdownLeft = left;
        this.message = `Starting in ${Math.ceil(left / 1000)}s…`;
        this.report(true);
        const step = Math.min(left, 250);
        await new Promise((r) => setTimeout(r, step));
        left -= step;
      }
      this.countdownLeft = 0;
      if (this.stopped) return this.finish();

      try { this.el.focus(); } catch (_) { /* ignore */ }
      this.state = 'typing';
      this.message = '';
      this.report(true);

      while (this.i < this.actions.length && !this.stopped) {
        const a = this.actions[this.i];
        await this.sleep(a.delay);
        if (this.stopped) break;
        if (!isFieldFocused(this.el)) {
          this.pause('Paused: the text box lost focus. Click back into it to continue.', true);
          await this.waitResume();
          continue; // re-check focus before typing
        }
        try {
          if (a.kind === 'type') await this.exec.type(this.el, a.ch);
          else await this.exec.backspace(this.el);
        } catch (e) {
          this.pause('Paused: ' + e.message, false);
          await this.waitResume();
          continue;
        }
        if (a.index !== undefined) this.typed = a.index + 1;
        this.i++;
        this.report(false);
      }
      this.finish();
    }

    async finish() {
      await this.exec.done();
      if (!this.stopped) {
        this.state = 'done';
        this.message = 'Done';
      }
      this.report(true);
      if (run === this) run = null;
    }
  }

  // --- Messages ---------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg && msg.type) {
      case 'run': {
        if (run) { reply({ ok: false, error: 'Already typing in this tab. Stop it first.' }); break; }
        if (!target || !target.isConnected) {
          reply({ ok: false, error: 'Click into the text box on the page first.' });
          break;
        }
        run = new Run(target, msg.text, msg.opts);
        run.start();
        reply({ ok: true, totalMs: run.remainingMs(), chars: run.total });
        break;
      }
      case 'control': {
        if (!run) { reply({ ok: false, error: 'Nothing is typing.' }); break; }
        if (msg.action === 'pause') run.pause('Paused');
        else if (msg.action === 'resume') run.resume();
        else if (msg.action === 'toggle') run.state === 'paused' ? run.resume() : run.pause('Paused');
        else if (msg.action === 'stop') run.stop();
        reply({ ok: true });
        break;
      }
      case 'cdp-detached': {
        if (run && run.opts.method === 'trusted') run.pause('Paused: trusted typing was cancelled. Press Stop and start again.');
        reply({ ok: true });
        break;
      }
      case 'overlay': {
        if (isTop) renderOverlay(msg.status);
        reply({ ok: true });
        break;
      }
      default:
        return false;
    }
    return false;
  });

  // --- Overlay (top frame only) -------------------------------------------------

  let overlay = null;

  function buildOverlay() {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .box{font:13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1d1f;background:#fff;
          border:1px solid #d9d9de;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.15);
          padding:10px 12px;width:260px}
        .row{display:flex;align-items:center;gap:8px}
        .title{font-weight:600;flex:1}
        .msg{color:#555;margin:6px 0 0;min-height:1em}
        .bar{height:6px;background:#eee;border-radius:3px;margin-top:8px;overflow:hidden}
        .fill{height:100%;width:0;background:#4f6bed;transition:width .25s}
        .meta{display:flex;justify-content:space-between;color:#666;font-size:12px;margin-top:4px}
        button{font:inherit;border:1px solid #ccc;background:#f6f6f8;border-radius:7px;padding:3px 9px;cursor:pointer}
        button:hover{background:#ececf0}
        .x{border:none;background:none;font-size:16px;padding:0 4px;color:#888}
        @media (prefers-color-scheme: dark){
          .box{background:#1f1f23;color:#eee;border-color:#3a3a40}
          .msg,.meta{color:#aaa} .bar{background:#333}
          button{background:#2c2c31;border-color:#444;color:#eee} button:hover{background:#38383e}
        }
      </style>
      <div class="box">
        <div class="row">
          <span class="title">SlowTyper</span>
          <button data-a="toggle">Pause</button>
          <button data-a="stop">Stop</button>
          <button class="x" data-a="close" title="Hide">×</button>
        </div>
        <div class="msg"></div>
        <div class="bar"><div class="fill"></div></div>
        <div class="meta"><span class="count"></span><span class="eta"></span></div>
      </div>`;
    // pointerdown preventDefault keeps focus in the text box when clicking.
    root.addEventListener('pointerdown', (e) => e.preventDefault());
    root.addEventListener('mousedown', (e) => e.preventDefault());
    root.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('button') && e.target.closest('button').dataset.a;
      if (!a) return;
      if (a === 'close') { host.remove(); overlay = null; return; }
      send({ type: 'control', action: a });
    });
    document.documentElement.appendChild(host);
    return {
      host,
      toggle: root.querySelector('[data-a="toggle"]'),
      stop: root.querySelector('[data-a="stop"]'),
      msg: root.querySelector('.msg'),
      fill: root.querySelector('.fill'),
      count: root.querySelector('.count'),
      eta: root.querySelector('.eta'),
    };
  }

  let hideTimer = null;

  function renderOverlay(s) {
    if (!s) return;
    if (!overlay || !overlay.host.isConnected) overlay = buildOverlay();
    clearTimeout(hideTimer);
    const finished = s.state === 'done' || s.state === 'stopped' || s.state === 'error';
    const pct = s.total ? Math.round((s.typed / s.total) * 100) : 0;
    overlay.fill.style.width = pct + '%';
    overlay.count.textContent = `${s.typed} / ${s.total} chars (${pct}%)`;
    overlay.eta.textContent = finished ? '' : `${E.formatDuration(s.remainingMs)} left`;
    overlay.msg.textContent = s.message || (s.state === 'typing' ? 'Typing…' : '');
    overlay.toggle.textContent = s.state === 'paused' ? 'Resume' : 'Pause';
    overlay.toggle.style.display = finished ? 'none' : '';
    overlay.stop.style.display = finished ? 'none' : '';
    if (finished) {
      hideTimer = setTimeout(() => { if (overlay) { overlay.host.remove(); overlay = null; } }, 4000);
    }
  }
})();
