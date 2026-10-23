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
