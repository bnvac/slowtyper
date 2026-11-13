# SlowTyper CLI

Types text into **whatever window has focus** (Word, Google Docs, Pages, a desktop app, a browser form) using real OS keyboard events, at a human pace:

- **Speed:** set words per minute, or `--minutes N` to finish in N minutes. The estimate is shown up front and the time left counts down while it types.
- **Variation:** uneven key timing, and keys are held down for a realistic 35–95 ms.
- **Bursts:** fast runs of keys followed by short gaps.
- **Pauses:** longer after commas, sentences, and new lines, plus occasional "thinking" pauses between words.
- **Typos:** a wrong neighboring key or swapped letters, sometimes noticed a key or two late, then backspaced and fixed.

It's one typing model shared with the browser extension in this repo.

## Install

You need Python 3.8+.

```bash
# from the repo root
pipx install ./cli        # recommended: isolated, puts `slowtyper` on your PATH
# or
pip install ./cli
```

Per-OS setup:

| OS | What to do |
|---|---|
| **Windows** | Nothing extra. If an app runs as Administrator, run your terminal as Administrator too, or Windows blocks the keystrokes. |
| **macOS** | System Settings → Privacy & Security → **Accessibility**: allow your terminal (Terminal, iTerm, etc.). For the F8/F9 hotkeys, also allow it under **Input Monitoring**. Restart the terminal afterwards. Without this, nothing gets typed. |
| **Linux** | Needs an **X11** session. On Wayland, only XWayland apps receive keys, so pick "Xorg"/"X11" at the login screen if nothing appears. |

## Use

```bash
slowtyper                          # asks you to paste text, then Ctrl+D (Windows: Ctrl+Z, Enter)
slowtyper -f essay.txt --minutes 20
slowtyper "Short text here" --wpm 60
pbpaste | slowtyper -y             # macOS clipboard; Linux: xclip -o | slowtyper -y
```

1. Run it and give it the text.
2. Press **Enter**. A countdown starts (5 s by default; `-d` changes it).
3. **Click into the window and spot where you want the text** before the countdown ends.
4. Leave the cursor there. Progress and time left show in the terminal.

**While typing:**
- **F8** pauses and resumes (from any window).
- **F9** stops.
- Moving the mouse to the **top-left corner** of the screen stops it.
- **Ctrl+C** in the terminal stops it.

Pause before you click or type anywhere else, because keys go to whichever window is focused.

### Options

| Option | Default | |
|---|---|---|
| `-w, --wpm` | 45 | Overall speed, including pauses and fixes |
| `-m, --minutes` | | Finish in this many minutes (overrides `--wpm`) |
| `-v, --variance` | 35 | Timing unevenness, 0–100 |
| `-t, --typos` | 2 | % of letters mistyped then corrected, 0–10 |
| `--no-bursts`, `--no-pauses` | | Turn those off |
| `-d, --delay` | 5 | Countdown seconds before typing starts |
| `--newline` | enter | `shift-enter` for chat boxes that send on Enter |
| `-y, --yes` | | Skip "press Enter to start" |
| `--dry-run` | | Show the estimate and check the plan without typing |
| `--seed` | | Repeatable randomness |

## Tips

- **Turn off autocorrect and auto-formatting** in the target app if it changes things. Word and Docs may "fix" deliberate typos before the backspace lands, or turn `"` into curly quotes. The final text normally still comes out right.
- **Code editors** that auto-close brackets or auto-indent will add extra characters. Turn those features off first.
- Curly quotes, dashes, accented letters, and emoji are supported.

## Develop

```bash
cd cli && python3 -m unittest discover -s tests
```
