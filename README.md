# overseer

One terminal that watches all your Claude Code sessions: which session works on
which project and task, where it is stuck, and for each problem a concrete fix
and next step. The overseer only reads. It never writes into a session, never
stops one and never steps in. Its suggestions are shown to you alone.

It has two parts:

1. **Reporter** (`hooks/`): a Claude Code mod that runs in every session. It
   writes the session's events as JSON Lines to
   `~/.claude/overseer/sessions/<session-id>.jsonl`, colours the iTerm2 tab
   per project and shows a coloured line above the prompt.
2. **Overseer** (`cli/overseer.mjs`): a Node script with no dependencies that you
   run in its own terminal. It follows those files and draws the overview.

## Install

**The reporter**, at the prompt of a Claude Code terminal session:

```
/plugin install overseer --marketplace DYAI2025/claude-overseer
```

Answer `y` to add the marketplace and choose the **user** scope, so the
reporter runs in every session from then on. From a shell:

```sh
claude plugin install overseer --marketplace DYAI2025/claude-overseer
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `DYAI2025/claude-overseer`, then Add
plugin.

Sessions started after the install report automatically; a running session
picks the plugin up with `/reload-plugins`. Uninstall:
`/plugin uninstall overseer@claude-overseer`.

**The overseer** is a Node script (Node 20 or later, no dependencies). Clone
the repository where the commands below expect it:

```sh
git clone https://github.com/DYAI2025/claude-overseer ~/Projects/claude-overseer
```

**Working on the code**: install from the clone instead, then edits arrive
through `/reload-plugins` with no reinstall:

```sh
claude plugin marketplace add ~/Projects/claude-overseer
claude plugin install overseer@claude-overseer --scope user
```

Mods (function hooks) are an early-access part of Claude Code. Built and tested
on Claude Code 2.1.310.

## Run the overseer

In a terminal of its own:

```sh
node ~/Projects/claude-overseer/cli/overseer.mjs
```

It redraws every 2 seconds and on each file change and fits the frame to the
window (problems that do not fit are counted as `+ N weitere`); `q` quits. A
problem that is new, or whose count goes up, rings the terminal bell (iTerm2
marks the tab); problems already there when the overseer starts do not.
`--quiet` turns the bell off.

| Option | Effect |
| --- | --- |
| `--once` | print one snapshot and exit |
| `--all` | also show sessions that ended over 10 min ago or went quiet over 1 h ago |
| `--no-color` | plain text |
| `--dir <path>` | read another sessions folder (default `~/.claude/overseer/sessions`, or `$OVERSEER_DIR`) |
| `--no-mouse` | leave the mouse to the terminal (its own text selection); the number keys still copy |

**Copying an answer**: a session that has answered shows a button `⧉1`, `⧉2`, …
at the start of its row. A click on it, or its number key, puts that session's
last answer on the clipboard (`pbcopy`), and a line under the sessions says
what was copied. The answer is the turn's final visible text as Claude Code
hands it to the mod, kept whole up to 64 KB and masked like everything else:
an e-mail address or a key in it arrives as `[EMAIL]`, `[REDACTED]` and the
like. While the overseer has the mouse, iTerm2 selects text with ⌥ held down.

An alias helps: `alias overseer='node ~/Projects/claude-overseer/cli/overseer.mjs'`.

**As a permanent window in iTerm2**: install the profile with

```sh
sed "s#__HOME__#$HOME#g" iterm2/overseer-profile.json > "$HOME/Library/Application Support/iTerm2/DynamicProfiles/overseer.json"
```

iTerm2 picks it up at once and lists a profile "Overseer" (red tab) that runs
the overseer with Homebrew's `node@24` (change the path in the file for
another Node). Then, in iTerm2:

- a hotkey: Settings → Profiles → Overseer → Keys → "A hotkey opens a
  dedicated window" — the overseer then drops down over everything on a key;
- at start: open an Overseer window, Window → Save Window Arrangement, and
  Settings → General → Startup → "Open default window arrangement"; add iTerm2
  to the macOS login items to have it after every login.

**Keeping it tidy**: `launchd/claude-overseer.cleanup.plist` deletes session
files and kept answers untouched for 14 days, daily at 4:00 and at login
(log: `~/.claude/overseer/cleanup.log`). A running session rewrites its file
every 30 s, so only ended sessions go. Install it with

```sh
sed "s#__HOME__#$HOME#g" launchd/claude-overseer.cleanup.plist > ~/Library/LaunchAgents/claude-overseer.cleanup.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/claude-overseer.cleanup.plist
```

and remove it with `launchctl bootout gui/$(id -u)/claude-overseer.cleanup`.

Start iTerm2 from the Dock or Spotlight, never from inside a Claude Code
session: launched from there it carries that session's environment, including
`CLAUDE_CODE_CHILD_SESSION`, and Claude Code sessions in it stop saving
transcripts.

## What you see

```
OVERSEER  · 2 aktiv / 3 Sessions · 2 Probleme  22:57:57
────────────────────────────────────────────────────────
⧉1  ● GELB    web-store    feature/login    e923  Fehler  vor 21 s   Run the command `node --test …
        ↳ Bash Run login test, run 3 of 3
⧉2  ● BLAU    order-api    main             e0bf  Fehler  vor 23 s   Run the command `ls /does-not…

PROBLEME (2)
✖ [GELB | web-store | e923] Tests schlagen 3x fehl (seit 46 s)
    Befund:   node --test login.test.mjs → not ok 1 - login redirects to /dashboard
    Vorschlag: …
    Nächster Schritt: Schreib der Session: "Stopp. Führ nur den ersten fehlschlagenden Test aus …"
```

Per session: colour, project (folder name), git branch, short session id,
status, last activity and the current task: the newest prompt that is not a
slash command and not made only of confirmations ("ok", "ja, mach weiter
bitte", "yes, go ahead").

**Status**

| Status | Meaning |
| --- | --- |
| läuft | a turn is running and moving |
| bereit | the turn is done, the session waits for your next prompt |
| wartet | a permission dialog or a question (AskUserQuestion, plan approval) waits for you |
| hängt | a turn has made no progress (no tool call, no answer) for over 10 min |
| Fehler | at least one problem of severity error |
| inaktiv | no heartbeat for over 5 min (heartbeats come every 30 s) |
| beendet | the session ended (shown for 10 min) |

**Problems detected**

| Problem | Rule |
| --- | --- |
| Tests schlagen Nx fehl | 2 or more test runs in a row failed since the last passing one (error from 3), the last within 15 min, and no newer prompt has been answered since |
| Gleicher Fehler Nx hintereinander | the newest 3+ tool results are errors with the same message (numbers folded), no success in between |
| Wiederholte Tool-Fehler | 5+ tool errors within 10 min, not counting failed test runs |
| Seit N min kein Fortschritt | a turn is running with no progress for over 10 min |
| Wartet auf deine Freigabe / Antwort | as above, while a permission dialog or a question is open |
| API-Fehler / Verweigerung | a turn ended with an API error or a refusal, and no answer has gone through since (a running turn that works again also clears it) |
| Kein Lebenszeichen | heartbeats stopped in the middle of a turn without the session ending |

A test run is recognised by the runner at the head of a command segment
(`pytest`, `npm test`, `./gradlew test`, `uv run pytest`, `cd x && npm t`, …),
not by a word anywhere in the line, so `pip install pytest` or
`git commit -m "fix jest"` are no test runs. Whether it failed comes from the
runner's own verdict in the output (`3 failed`, `not ok`, `# fail 2`, …); the
exit status counts only where it is the runner's, so `npm test | tail` and
`npm test && git commit` are judged by the output alone.

A tool call you or a hook denied is never counted as an error: the reporter
marks it, and the overseer also recognises the wording of a denial from the
permission dialog, a PreToolUse hook or Esc. The fix suggestion is chosen from
the error message only, never from the command or a file name. Each problem names the
session as `[COLOUR | project | id]` and carries a finding, a fix and a next
step; the next step is often a sentence to paste into that session. The rules
are in `cli/lib/analyze.mjs` and `cli/lib/suggest.mjs`.

## The reporter

Events, one JSON object per line, each with `v`, `ts` (ms) and `type`:

| type | fields |
| --- | --- |
| `session_start` | `sid`, `short`, `cwd`, `pkey` (hash of the folder), `project`, `branch`, `colorIndex`, `color`, `hex`, `source` (`startup`, `reload`, `clear`, `resume`), `previous` (the id before a /clear or /resume), `interactive`, `terminal`, `iterm` |
| `user_prompt` | `text` (cut to 300 characters), `command` for a slash command |
| `tool_call` | `id`, `tool`, `desc` (short description), `cmd` (Bash only), `agent` (subagent) |
| `tool_ok` / `tool_error` | `id`, `tool`; `error` (head and tail, 400 characters), `denied`; `out` on `tool_ok` for Bash commands that may run tests (tail, 300 characters) |
| `turn_start` / `turn_end` | `reason`, `ms` |
| `error` | `kind` (`api_error`, `refusal`), `error` |
| `attention` | `kind` (`permission_prompt`, `idle_prompt`, …), `text` |
| `heartbeat` | every 30 s with the current `branch`; consecutive ones are folded into one line |
| `meta` | `branch` when it changes |
| `session_end` | `reason` |

Beside them, `answers/<session-id>.md` holds the session's last main-loop
answer for the copy button, rewritten at the end of each answered turn.

`tool_ok`, `turn_start`/`turn_end`, `attention` and `meta` go beyond the minimum:
without them "hängt" and "wartet auf Freigabe" could not be told apart from a
session that is simply done.

**Secrets** are masked before anything is written (`hooks/lib/redact.ts`,
cases in `tests/redact.test.ts`): PEM and PGP private key blocks; Anthropic,
OpenAI, GitHub, GitLab, Hugging Face, Slack, npm, SendGrid, AWS, Google and
Stripe tokens; JWTs; `Bearer`/`Basic` headers; credentials in URLs, webhook
URLs (Slack, Discord, Telegram) and signed-URL parameters; `curl -u user:pw`,
`mysql -pPW`, `echo pw | sudo -S`, SQL `PASSWORD '…'`; assignments whose name
ends in password, Passwort, Kennwort, secret, token, key and the like, quoted
values with spaces included; `--password`, `--client-secret`, `--auth-token`
style flags. They become `[REDACTED]`; e-mail addresses become `[EMAIL]`, in
folder paths too. This is pattern matching: a secret in a format it does not
know is not caught.

**Never in the way**: hooks do not wait for git, the store or the disk;
`session.start` and every prompt return at once, and the file is written beside
the session. Lines the overseer judges by (errors, turn ends) are written at
once, the rest 750 ms later. Only `session.end` waits, within its own 1.5 s
bound, for the last write and the tab reset. Every failure goes to the debug
log (`claude --debug`), nothing is thrown, and a failing write cannot block a
tool call (tested). Redaction runs on at most 16 KB per text, so a long output
costs milliseconds. A file keeps at most 1500 lines (the first `session_start`
and the newest). After `/clear` or `/resume` the reporter continues in a new
file under the new session id.

**Colours**: 8 colours (BLAU, ORANGE, GRÜN, LILA, GELB, TÜRKIS, PINK, BRAUN;
red is kept for errors). A project's colour comes from an FNV-1a hash of its
folder path. Its first session keeps it in the plugin's store (under the hash,
not the path), so it stays the same from session to session. When a running
session of another project holds that colour, the session gets the next free
one for its own lifetime only; the stored colour does not change.

**iTerm2**: when `TERM_PROGRAM=iTerm.app` (or `LC_TERMINAL=iTerm2`) and not
inside tmux, the reporter sets the tab colour (proprietary `OSC 6`), the tab
title (`OSC 1`, `● project`) and two user variables, `overseer_project` and
`overseer_color` (`OSC 1337 SetUserVar`). Control characters are removed from
the folder name first, so a name cannot smuggle escape sequences into the
terminal; the overseer cleans everything it reads the same way. When the
session ends the tab colour is reset and the user variables are cleared. In
any other terminal this is skipped.

Checked live in iTerm2 3.7.6: the tab takes the project colour (it stays,
paler, when the tab is not the active one), and both user variables are set.
The `OSC 1` title stays in some sessions and is replaced by `Chat` in others,
since Claude Code and iTerm2's own Claude Code integration set the title too.
For a title that always stays, put `\(user.overseer_project)` into iTerm2's
Profiles → General → Title (or the tab title components). A tab shows its
colour only in a visible tab bar: with one tab per window, turn on
Settings → Appearance → Tabs → "Show tab bar even when there is only one tab".

In iTerm2 the whole window takes the project colour too: the background is
tinted (12 % of the colour on a light profile, 18 % on a dark one, read from
`COLORFGBG`) and the project name shows as a badge. Both go back to the
profile's own when the session ends. `OVERSEER_TINT=off` in the environment
leaves background and badge alone and keeps only the tab colour.

**Line above the prompt**: `● project · branch · COLOUR · id` in the project's
colour. `OVERSEER_BAND=0` in the environment hides it.

## Development

```sh
claude plugin validate .        # manifest, hooks module, what it calls
claude plugin test .            # reporter tests against the engine (tests/)
node --test cli/test/*.test.mjs # overseer rules and rendering
claude --plugin-dir ~/Projects/claude-overseer   # a session with the working copy
```

`OVERSEER_DIR=/some/dir` points both reporter and overseer at another folder.
