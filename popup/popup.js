(function () {
  'use strict';
  const E = globalThis.SlowTyperEngine;
  const api = globalThis.browser || chrome;
  // Trusted mode needs chrome.debugger, which Firefox doesn't have.
  const canTrust = !!api.debugger;
  const $ = (id) => document.getElementById(id);

  const els = {
    text: $('text'), counts: $('counts'), target: $('target'),
    wpm: $('wpm'), wpmOut: $('wpmOut'), minutes: $('minutes'),
    variance: $('variance'), varianceOut: $('varianceOut'),
    typoRate: $('typoRate'), typoOut: $('typoOut'),
    bursts: $('bursts'), pauses: $('pauses'),
    startDelay: $('startDelay'), method: $('method'), methodHint: $('methodHint'),
    eta: $('eta'), runPanel: $('runPanel'), fill: $('fill'), progress: $('progress'),
    left: $('left'), runMsg: $('runMsg'),
    start: $('start'), toggle: $('toggle'), stop: $('stop'), error: $('error'),
    access: $('access'), grant: $('grant'),
  };

  let tabId = null;

  function readOpts() {
    return {
      wpm: Number(els.wpm.value),
      variance: Number(els.variance.value),
      typoRate: Number(els.typoRate.value),
      bursts: els.bursts.checked,
      pauses: els.pauses.checked,
      startDelay: Math.max(0, Number(els.startDelay.value) || 0),
      method: canTrust ? els.method.value : 'standard',
    };
  }

  function writeOpts(o) {
    els.wpm.value = o.wpm;
    els.variance.value = o.variance;
    els.typoRate.value = o.typoRate;
    els.bursts.checked = o.bursts;
    els.pauses.checked = o.pauses;
    els.startDelay.value = o.startDelay;
    els.method.value = canTrust ? o.method : 'standard';
  }

  function refresh() {
    const o = readOpts();
    els.wpmOut.textContent = o.wpm;
    els.varianceOut.textContent = o.variance;
    els.typoOut.textContent = o.typoRate;
    els.methodHint.hidden = o.method !== 'trusted';
    const text = els.text.value;
    const chars = E.normalizeText(text).length;
    const words = (text.match(/\S+/g) || []).length;
    els.counts.textContent = chars ? `(${words} words, ${chars} chars)` : '';
    els.eta.textContent = chars ? E.formatDuration(E.estimateMs(text, o)) : '–';
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.storage.local.set({ opts: readOpts(), text: els.text.value });
    }, 200);
  }

  function showError(msg) {
    els.error.textContent = msg || '';
    els.error.hidden = !msg;
  }

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(Object.assign({ tabId }, msg), (res) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : res || { ok: false });
      });
    });
  }

  function renderStatus(s) {
    const active = s && (s.state === 'countdown' || s.state === 'typing' || s.state === 'paused');
    els.runPanel.hidden = !s;
    els.start.hidden = !!active;
    els.toggle.hidden = !active;
    els.stop.hidden = !active;
    if (!s) return;
    const pct = s.total ? Math.round((s.typed / s.total) * 100) : 0;
    els.fill.style.width = pct + '%';
    els.progress.textContent = `${s.typed} / ${s.total} chars (${pct}%)`;
    els.left.textContent = active ? `${E.formatDuration(s.remainingMs)} left` : '';
    els.runMsg.textContent = s.message || (s.state === 'typing' ? 'Typing…' : '');
    els.toggle.textContent = s.state === 'paused' ? 'Resume' : 'Pause';
  }

  // Live status from the content script while the popup is open.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === 'status' && sender.tab && sender.tab.id === tabId) renderStatus(msg);
  });

  // --- Events -------------------------------------------------------------------

  for (const id of ['text', 'wpm', 'variance', 'typoRate', 'bursts', 'pauses', 'startDelay', 'method']) {
    els[id].addEventListener('input', () => { refresh(); save(); });
    els[id].addEventListener('change', () => { refresh(); save(); });
  }
  els.wpm.addEventListener('input', () => { els.minutes.value = ''; });
  els.minutes.addEventListener('input', () => {
    const wpm = E.wpmForDuration(els.text.value, Number(els.minutes.value));
    if (!wpm) return;
    els.wpm.value = Math.round(Math.min(200, Math.max(5, wpm)));
    refresh(); save();
  });

  els.start.addEventListener('click', async () => {
    showError('');
    const text = els.text.value;
    if (!E.normalizeText(text).length) return showError('Enter some text first.');
    els.start.disabled = true;
    const res = await send({ type: 'start', text, opts: readOpts() });
    els.start.disabled = false;
    if (!res.ok) return showError(res.error || 'Could not start.');
    // Close so focus returns to the page; the on-page control takes over.
    window.close();
  });
  els.toggle.addEventListener('click', () => send({ type: 'control', action: 'toggle' }));
  els.stop.addEventListener('click', () => send({ type: 'control', action: 'stop' }));

  // Firefox lets users withhold site access; without it the content script
  // never loads, so offer a one-click grant.
  const ALL_SITES = { origins: ['<all_urls>'] };
  async function checkAccess() {
    if (!api.permissions || !api.permissions.contains) return;
    let ok = true;
    try { ok = await api.permissions.contains(ALL_SITES); } catch (_) { /* assume ok */ }
    els.access.hidden = ok;
  }
  els.grant.addEventListener('click', async () => {
    // permissions.request must run straight from the click, before any await.
    const granted = await api.permissions.request(ALL_SITES).catch(() => false);
    els.access.hidden = granted;
    if (granted) showError('Access granted. Reload the page, click into the box, and press Start.');
  });

  // --- Init ---------------------------------------------------------------------

  (async function init() {
    const stored = await api.storage.local.get(['opts', 'text']);
    if (!canTrust) els.method.closest('label').hidden = true;
    writeOpts(Object.assign({}, E.DEFAULTS, stored.opts));
    checkAccess();
    els.text.value = stored.text || '';
    refresh();

    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id;
    const res = await send({ type: 'get-tab' });
    const t = (res && res.tab) || {};
    els.target.textContent = t.focusLabel ? `→ ${t.focusLabel}` : 'No text box selected yet';
    const s = t.status;
    const live = s && ['countdown', 'typing', 'paused'].includes(s.state);
    renderStatus(live ? s : null);
  })();
})();
