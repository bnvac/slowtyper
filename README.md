# SlowTyper

A Chrome/Edge/Brave and Firefox extension (Manifest V3) that types a string into whatever text box you've clicked, at a pace you choose, so it reads like someone typing by hand:

- **Speed**: set words per minute, or "finish in N minutes". The estimated time is shown before you start and counts down while it types.
- **Variation**: each keystroke's timing is randomized, skewed toward slightly slow keys like real typing.
- **Bursts**: fast runs of keys followed by a short gap.
- **Natural pauses**: longer after commas, sentences, and new lines, plus occasional "thinking" pauses between words.
- **Typos**: a mistyped neighboring key or swapped letters, sometimes noticed a key or two late, then backspaced and fixed.

The WPM covers everything, including pauses and typo fixes. So 500 characters at 50 WPM takes 2 minutes.

## Install
Run `npm run build` (Node 18+). This writes `dist/chrome/`, `dist/firefox/` and a zip of each.

**Chrome / Edge / Brave**
1. Open `chrome://extensions`, turn on **Developer mode**, and click **Load unpacked**.
2. Select `dist/chrome` (or the repo root, which works too). Reload any tabs that were already open.

**Firefox (142+)**
- To try it: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and pick `dist/firefox/manifest.json`. It stays until Firefox restarts.
- To keep it installed: release Firefox needs a Mozilla-signed add-on. Upload `dist/slowtyper-firefox-<version>.zip` to [addons.mozilla.org](https://addons.mozilla.org/developers/) as an **unlisted** add-on. It's signed automatically and you get an `.xpi` to install. Or use Firefox Developer Edition/Nightly with `xpinstall.signatures.required` set to `false`.
- If the popup shows **Allow on all sites**, click it. Firefox lets you withhold site access, and SlowTyper can't type without it.

## Use
1. Click into the text box on the page.
2. Open SlowTyper from the toolbar, paste your text, and set the speed and options.
3. Press **Start typing**. The popup closes, a countdown runs, then typing begins.
4. Use the floating control (bottom-right of the page), or **Alt+Shift+P**, to pause, resume, or stop.

If you click out of the box, typing pauses by itself. Click back into the same box and it continues.

## Methods
| Method | How it works | Use for |
|---|---|---|
| Standard | Fires key events, then inserts each character with the browser's own editing command. The page sees normal `insertText` input and no paste events. | Ordinary inputs, textareas, most rich editors (Google Forms, LMS boxes, etc.) |
| Trusted keys (Chrome only) | Sends real key presses through Chrome's DevTools protocol (`chrome.debugger`). | Editors that ignore synthetic events, such as Google Docs. Chrome shows a "started debugging this browser" bar while it runs. Firefox has no equivalent API, so the option is hidden there. |

## Develop
```
npm test              # engine unit tests (node:test, no deps)
npm run build         # dist/chrome, dist/firefox + zips
npm run e2e           # Chromium via Playwright (CHROMIUM_PATH optional)
npm run e2e:firefox   # Firefox via puppeteer-core; set FIREFOX_PATH
                      # (get one with: npx @puppeteer/browsers install firefox@stable)
```
Both browsers share one codebase. `scripts/build.mjs` derives the Firefox manifest from `manifest.json`. It switches to background scripts instead of a service worker, drops `debugger`, adds `host_permissions`, and adds the gecko id.
Layout: `src/engine.js` (pure planner, shared everywhere), `src/content.js` (focus tracking, typing, overlay), `src/background.js` (message routing, trusted mode), `popup/`.
