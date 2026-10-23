# NOTES

## Architecture
- `engine.plan(text, opts, rand)` builds the whole keystroke list up front and scales the delays so total time = chars × 60000/(wpm×5). That makes the ETA exact.
- The content script runs in every frame. Each frame reports `focus` to the background, which remembers the last focused frame per tab (in `storage.session`). `start` goes to that frame.
- The engine frame sends `status` to the background. The background stores it and forwards it to frame 0, which draws the overlay. This keeps the overlay visible when typing happens in a hidden iframe (Google Docs).
- Typing checks focus before every keystroke and auto-pauses if the box loses focus, so it never types into the wrong place.
- Standard executor: synthetic keydown/keypress, then `execCommand('insertText'|'delete'|'insertParagraph')`, falling back to `setRangeText` plus an InputEvent. If the page calls preventDefault on keydown, the character is skipped, as a real browser would do.

<!-- MEMORY_UPDATE_START -->
### Update: 2026-10-23
* **Decisions/Changes**: Initial MV3 extension. WPM is calibrated to cover pauses and typos. Two methods: standard (execCommand) and trusted (chrome.debugger Input.dispatchKeyEvent). The on-page overlay lives in the top frame only.
* **Known Bugs/Gaps**: Google Docs only tested by design, not live (use Trusted mode). Chrome only, no Firefox (it has no chrome.debugger). Tabs open before install need a reload. Typos only on ASCII letters with a US QWERTY layout. Synthetic keydown events have isTrusted=false in Standard mode.
<!-- MEMORY_UPDATE_END -->

<!-- MEMORY_UPDATE_START -->
### Update: 2026-10-23 (Firefox)
* **Decisions/Changes**: Firefox support from the same source. scripts/build.mjs generates the Firefox manifest (background.scripts, no debugger, host_permissions, gecko id slowtyper@bnvac.github.io, min 142, data_collection none). Code uses `globalThis.browser || chrome`. Trusted mode is hidden when `api.debugger` is missing. The popup offers a grant button if `<all_urls>` was withheld. Fixed: popup crashed on load (grant/access elements missing from the els map); a run that errored at start left the tab stuck in "Already typing".
* **Known Bugs/Gaps**: Firefox has no trusted mode, so Google Docs likely won't work there. Release Firefox needs AMO signing (unlisted is fine). web-ext lint gives 5 harmless warnings for the guarded chrome.debugger calls; moving CDP code into a Chrome-only file would silence them. Not tested on Firefox for Android.
<!-- MEMORY_UPDATE_END -->
