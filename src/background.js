/*
 * Service worker: routes messages between the popup, the frame being typed
 * into, and the top-frame overlay. Also drives "trusted" typing through the
 * chrome.debugger (DevTools protocol) API.
 */
// Chrome runs this as a service worker; Firefox loads engine.js first as a
// background script (see scripts/build.mjs), so importScripts isn't needed there.
if (typeof importScripts === 'function') importScripts('engine.js');
const E = globalThis.SlowTyperEngine;
// Firefox's promise-based namespace; Chrome's chrome.* also returns promises.
const api = globalThis.browser || chrome;
const hasDebugger = !!api.debugger;

// Per-tab state lives in session storage so it survives worker restarts.
async function getTab(tabId) {
  const key = 'tab:' + tabId;
  const got = await api.storage.session.get(key);
  return got[key] || {};
}
// Writes are chained so concurrent read-modify-writes don't drop fields.
let writeChain = Promise.resolve();
function setTab(tabId, patch) {
  const key = 'tab:' + tabId;
  writeChain = writeChain.then(async () => {
    const cur = await getTab(tabId);
    await api.storage.session.set({ [key]: Object.assign(cur, patch) });
  }).catch(() => {});
  return writeChain;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  api.storage.session.remove('tab:' + tabId);
  attached.delete(tabId);
});

function toFrame(tabId, frameId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId }, (res) => {
      const err = chrome.runtime.lastError;
      resolve(err ? { ok: false, error: err.message } : res);
    });
  });
}

// --- Trusted typing via DevTools protocol ------------------------------------

const attached = new Set();

async function cdpAttach(tabId) {
  if (!hasDebugger) throw new Error('Trusted mode is not available in this browser. Use Standard.');
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(e.message)) throw e;
  }
  attached.add(tabId);
}

async function cdpDetach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (_) { /* already detached */ }
}

if (hasDebugger) chrome.debugger.onDetach.addListener(async (source) => {
  if (!source.tabId || !attached.has(source.tabId)) return;
  attached.delete(source.tabId);
  const t = await getTab(source.tabId);
  if (t.runFrame !== undefined) toFrame(source.tabId, t.runFrame, { type: 'cdp-detached' });
});

function dispatch(tabId, params) {
  return chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', params);
}

async function cdpKey(tabId, ch) {
  await cdpAttach(tabId);
  const info = E.keyInfo(ch);
  const base = { key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode };

  if (ch === '\b') {
    await dispatch(tabId, Object.assign({ type: 'rawKeyDown' }, base));
    await dispatch(tabId, Object.assign({ type: 'keyUp' }, base));
    return;
  }
  // Characters with no key on a US layout (emoji, accents) are inserted as
  // IME-style text input, like an on-screen keyboard would.
  if (!info.code) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: ch });
    return;
  }
  const modifiers = info.shift ? 8 : 0;
  await dispatch(tabId, Object.assign({ type: 'keyDown', text: info.text, unmodifiedText: info.text, modifiers }, base));
  await dispatch(tabId, Object.assign({ type: 'keyUp', modifiers }, base));
}

// --- Message routing -----------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (e) => reply({ ok: false, error: e.message }));
  return true; // async reply
});

async function handle(msg, sender) {
  const tabId = msg.tabId ?? (sender.tab && sender.tab.id);
  switch (msg.type) {
    // From content scripts
    case 'focus':
      await setTab(tabId, { focusFrame: sender.frameId, focusLabel: msg.label });
      return { ok: true };

    case 'status': {
      const status = { state: msg.state, typed: msg.typed, total: msg.total, remainingMs: msg.remainingMs, message: msg.message, at: Date.now() };
      await setTab(tabId, { status, runFrame: sender.frameId });
      toFrame(tabId, 0, { type: 'overlay', status });
      return { ok: true };
    }

    case 'cdp-attach':
      await cdpAttach(tabId);
      return { ok: true };
    case 'cdp-key':
      await cdpKey(tabId, msg.ch);
      return { ok: true };
    case 'cdp-detach':
      await cdpDetach(tabId);
      return { ok: true };

    // From the popup or the overlay
    case 'start': {
      const t = await getTab(tabId);
      const frameId = t.focusFrame ?? 0;
      const res = await toFrame(tabId, frameId, { type: 'run', text: msg.text, opts: msg.opts });
      if (res && res.ok) await setTab(tabId, { runFrame: frameId });
      if (res && !res.ok && /Receiving end does not exist|Could not establish/i.test(res.error || '')) {
        return { ok: false, error: 'SlowTyper is not loaded on this page yet. Reload the page, click into the box, and try again.' };
      }
      return res || { ok: false, error: 'No response from the page.' };
    }

    case 'control': {
      const t = await getTab(tabId);
      if (t.runFrame === undefined) return { ok: false, error: 'Nothing is typing in this tab.' };
      return toFrame(tabId, t.runFrame, { type: 'control', action: msg.action });
    }

    case 'get-tab':
      return { ok: true, tab: await getTab(tabId) };

    default:
      return { ok: false, error: 'Unknown message: ' + msg.type };
  }
}

// Keyboard shortcut: pause/resume without opening the popup.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-pause' || !tab) return;
  await handle({ type: 'control', action: 'toggle', tabId: tab.id }, {});
});
