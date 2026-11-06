# Ask Gemini

A question box on the wall. Type a question, Gemini answers it in a panel over
the wall, with the wall's own numbers in front of it. Full build only.

## Using it

- Click **ASK** in the top-right action group, press **Ctrl+Alt+G** anywhere, or
  pick **Ask Gemini...** in the tray.
- Type, press **Enter**. The answer streams into the panel. **Escape** cancels a
  question that is still running, and closes the panel when nothing is.
- The panel keeps the last five questions and answers of this session, in
  memory only. Nothing is saved to disk by the wall.
- The model is chosen in the tray under **Gemini model**: the Gemini Flash
  models `agy models` lists (default `gemini-3.8-flash-medium`), saved as
  `askModel` in settings.json.

## Setup

1. Install the Antigravity CLI (`agy`) from antigravity.google/download. The
   wall looks for it at `%LOCALAPPDATA%\agy\bin\agy.exe`.
2. Run `agy` once in a terminal and sign in with Google.

If agy is missing, signed out or out of quota, the panel says so in one plain
sentence with the fix. It never shows agy's own error text.

## Why Antigravity and not the Gemini CLI

The design ([design/gemini-ask.md](design/gemini-ask.md)) chose the Gemini CLI,
free on a personal Google login. On 2026-11-06 Google refused Gustav's sign-in
there with: "This client is no longer supported for Gemini Code Assist for
individuals. To continue using Gemini, please migrate to the Antigravity suite
of products". The Gemini CLI route cannot work on his account, so the backend is
the Antigravity CLI, which is signed in on his Google AI Plus account and runs
Gemini 3.8 Flash. The UI still says "Ask Gemini" because Gemini answers.

One backend, one file: `src/main/ask/agy.ts`. Nothing else in the app knows
which program answers.

**Quota is small.** AI Plus gives a baseline Antigravity quota plus 200 monthly
AI credits. On 2026-11-06 the quota ran out after three short prompts ("Individual
quota reached ... Resets in 35m21s"). The panel shows that as "Gemini's quota on
this Google account is used up for now. It resets in 35m21s."

## How a question runs

1. The renderer sends `ask:start(question)`. Main refuses anything that is not a
   string of 1 to 2,000 characters after trimming, and refuses a second question
   while one runs.
2. Main builds the prompt: a short preamble, the wall's numbers as plain text
   (below), and the question with every line quoted (`> `).
3. Main creates a fresh temporary folder `%TEMP%\mbw-ask-XXXXXX\` holding an empty
   `work\` folder (agy's working directory), the session settings file and agy's
   log file.
4. Main starts `agy.exe` directly (`shell: false`) with a fixed argument list and
   writes the prompt to its STDIN as one NDJSON line:
   `{"event":"user","message":{"content":"..."}}`.
5. agy's stream-json output is read line by line. Text deltas go to the renderer
   as `ask:chunk`; the final `result` becomes `ask:done` (or `ask:error`).
6. The folder is deleted afterwards, whatever happened. Quitting the wall
   cancels a running question and waits up to three seconds for that clean-up;
   anything a crash or forced quit leaves behind is swept at the next start
   (`sweepStaleRuns`: only directories named `mbw-ask-*` directly under the
   temp folder, never through a symlink or junction).

## The lock-down

agy is a coding agent with shell, file and browser tools, and the question is
outside input. Every run is locked down, and each item below was checked against
agy 1.4.11 on 2026-11-06.

The command, built in `buildArgs` and nowhere else:

```
agy.exe -p "" --input-format stream-json --output-format stream-json
        --mode plan --sandbox --model <slug> --print-timeout 90s
        --settings <run folder>\settings.json --log-file <run folder>\agy.log
```

- **The question never touches a command line.** `-p ""` only switches on print
  mode; the prompt arrives on stdin. Nothing about the question can become an
  argument, and no shell parses anything (agy.exe is a real executable, so there
  is no `.cmd` shim and no cmd.exe). The model slug is the only variable value
  and must match `^[a-z0-9][a-z0-9.-]{0,63}$`, so it can never be read as a flag.
- **Session settings that deny everything.** `--settings` is session only and is
  never saved by agy. Measured: its `permissions` REPLACE the user's own rules
  for the run (agy's log shows only these):

  ```json
  {
    "toolPermission": "strict",
    "allowNonWorkspaceAccess": false,
    "enableTerminalSandbox": true,
    "permissions": {
      "allow": [],
      "deny": ["command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)"]
    }
  }
  ```

  agy rejects unknown keys outright, so only keys that were accepted and run live
  are in it. Web search (`search_web`) is not a permission action and still
  works: measured, a question about the latest Node.js release was answered from
  a search with these rules in force. `unsandboxed(*)` is left out because agy
  ignores it on this account type and warns.
- **`--mode plan`** (read and propose only). agy 1.4.11 still prints "--mode
  plan has no effect while slash command expansion is disabled", the quirk
  gemini-bridge found on 1.3.2, so `--disable-slash-commands` is NOT passed.
  Instead the prompt always starts with the wall's preamble and every line of
  the question starts with `> `, so no line can be a slash command.
- **An empty working folder** outside any repository, deleted afterwards, with
  `allowNonWorkspaceAccess: false`. The settings file and the log sit beside it,
  not in it.
- **`--sandbox`** is passed, but on this machine agy logs "Terminal sandbox
  unavailable: sandboxing on Windows requires Windows 11 24H2 or later". It is a
  second layer that does nothing here; the deny rules are what holds.
- **A watchdog on an allowlist.** Every line agy prints is classified against
  the shapes SEEN in real agy 1.4.11 output on 2026-11-06: the `init` event;
  `step_update` steps of type `user_input` (the echoed question),
  `agent_response` (the model's text) and `error_message` (written before a
  failed result, seen in the quota run); a `tool` step named `search_web`; and
  the final `result`. Anything else (another tool, a step type agy adds later
  such as a browser or planner step, an unknown event, a line that is not JSON)
  kills the run at once and throws its answer away ("Gemini tried to use a tool
  the wall does not allow"). It reacts AFTER agy reports a step, not before:
  `toolPermission: strict` and the deny list are the prevention, the watchdog
  stops a run that is doing something else. A real agy release that starts
  printing a new harmless line will therefore end every question until that
  shape is added to `QUIET_STEPS` in `src/main/ask/agy.ts`; that is the
  intended failure direction.
- **Limits.** 90 seconds, then the process tree is killed (`taskkill /T /F`,
  called by its full path under `%SystemRoot%\System32`, no shell, and only
  while the process has not already exited, so a reused pid is never hit); agy's own `--print-timeout` is the same, so an orphan cannot outlive
  it. One run at a time. Escape cancels and kills the tree. stdout past 2 MB
  kills the run.
- **Never `--dangerously-skip-permissions`.**

What was measured live (2026-11-06, agy 1.4.11, gemini-3.8-flash-low): asked to
create `x.txt` with its file tool and run `echo pwned > y.txt`, agy tried
`write_file` and was refused ("permission check failed for write_file ...
Permission denied"), and the working folder stayed empty. The run then hit the
quota limit before trying the command. `npm run test:ask-live` repeats this
check with the watchdog off, so it proves the deny rules on their own. Its one
run at 11:24 the same day passed (folder empty, nothing written, no command),
but the model attempted no tool at all that time, so that run did not exercise
the deny rules themselves; the test now says so when it happens.

What is not proven: agy offers tools the permission system does not name
(`schedule`, `send_message`, `generate_image`, browser tools and others).
`toolPermission: strict` should make each of them ask, and an ask is a denial in
print mode, but that was not exercised for each tool. The watchdog is the
backstop: none of them is `search_web`, so any of them ends the run.

## Answers are untrusted text

Gemini writes them, and a web search can put anyone's words in them.

- Main strips ANSI escapes, C0 and C1 control characters, and invisible
  characters that change how text reads (zero-width space, non-joiner and
  joiner U+200B to U+200D, direction marks U+200E, U+200F and U+061C, bidi
  overrides and isolates, the separators U+2028 and U+2029, and the BOM), and
  caps the answer at 12,000 characters with a visible note.
- The renderer only ever sets text with `textContent`. Light formatting is done
  by splitting the text into elements: blank lines make paragraphs, lines
  starting `-`, `*` or `1.` make list items, `**` markers are dropped. No HTML
  is ever parsed.
- Errors are one of a fixed set of messages. agy's stderr is only pattern
  matched (for sign-in and quota), never shown and never logged, because it can
  hold paths and account details. The log gets a short code: `[ask] failed after
  9.7s: quota (exit 3)`.

## What is sent to Google

The prompt, through agy, to Google's Antigravity service:

- the preamble (Gemini is answering on Gustav's stats wall, the numbers are his,
  answer briefly in plain text, web search only when needed, no files or
  commands);
- the wall's numbers, built in `src/main/ask/context.ts` from the same payload
  the renderer shows: Claude and Codex totals, cost at list prices (floored to
  the cent), today so far, hours worked, plan-limit readings with their age, the
  last 14 days (labelled as UTC dates, because `daily` is keyed by UTC, rule
  38), tokens by model, and the top projects by LABEL only. Capped at 6,000
  characters, cut at a section boundary;
- the question.

Never sent: paths, the user name, `cwd`, session ids, transcript text, the
notes bar, mail or tasks (Work mode does not exist yet). Project labels go
through the same `labelProjects` the renderer and the projection wire use, and
then `safeLabel` drops anything still shaped like a path, and any label equal to
or containing the Windows user name or the home folder's name (case-insensitive).
That second rule exists because a session started in the home folder itself is
labelled with the folder's name, which on this machine is "HP 865 G10".

On Google's side: agy keeps the conversation in
`~/.gemini/antigravity-cli/conversations`, as it does for any agy session, and
Google's terms for the Antigravity service apply to what is sent. The wall does
not delete agy's own conversation history.

## Full build only, never projected

The stats edition has no ASK chip, no panel, no `ask:*` IPC handler, no
Ctrl+Alt+G hotkey, no tray item and no `ask` on the preload bridge
(`isStatsOnly` guards in `src/main/index.ts`, `src/preload/index.ts` and
`src/renderer/main.ts`). Nothing about Ask Gemini is added to `toWire()`, so a
paired screen never sees a question or an answer.

Precisely: the stats PRELOAD has no `ask` code at all (the guard folds to a
literal and the object is dropped). The stats main and renderer bundles still
carry the Ask code as dead bytes: esbuild folds the imported `isStatsOnly` to a
literal (`if(!0)return`) but does not remove the branch behind it. None of it
runs: no handler is registered, no chip or panel is built, and with no `ask` on
the bridge the renderer could not reach main anyway. Stripping the bytes too
would need a build-time define used directly at each guard.

## Keyboard focus

The wall cannot take a keystroke until the main process lends it focus
([notes-bar.md](notes-bar.md)). The ask bar uses the same loan, as `ask:focus`,
with its own flag (`askEditing`) beside `notesEditing`; `applyLayer` leaves the
window alone while either is set, and the window goes back to unfocusable only
when neither is. The bar awaits the loan: if focus is refused, the field stays
read-only and says so. The loan is returned on close and whenever the window
loses focus to another application.

A refused loan is taken back by the main process itself (`lendFocus`): the
renderer never opens the field then, so it would never hand the loan back, and
the window would stay focusable with `applyLayer` switched off. That was true of
the notes bar too before this change; it is fixed for both. Main also ends any
loan itself when the wall window loses focus, finishes a (re)load, or its
renderer process dies (`releaseLoans`), so a blur that lands while a borrow is
still opening, or a crashed renderer, cannot leave the window focusable. The
renderers still hand their loans back as before; the two paths agree.

The panel hangs inside `#wall-actions`, like the milestone list, so it always
starts just under the row's real bottom (the row's text has a pixel floor, so
its height is not a multiple of `--u` on a small screen), and its `max-height`
uses the row's height to end 24u above the bottom of the window.

## Tests

- `test/ask.test.mjs` (in `npm test`): a fake CLI
  (`test/fixtures/fake-agy.cjs`) stands in for agy and records what it was
  given. It proves the question arrives on stdin and in no argument; that shell
  metacharacters and quotes are inert and argv is exactly the fixed list; the
  deny-all settings; that the working folder is empty at start and at exit and
  gone afterwards; that a timeout and a cancel kill the process and its child; a
  second ask is refused; sign-in, quota (with reset time), missing CLI and
  unknown failures map to fixed messages; stderr paths and tokens never reach
  the payload or the log; ANSI, controls and invisible characters are stripped;
  answers are capped; the watchdog kills and discards a run that reports
  `run_command`, a browser tool, an unknown step type, a browser step type, an
  unknown event or a non-JSON line, while agy's own `error_message` step passes;
  the run folder is gone after a success, timeout, cancel, error and blocked
  run; the startup sweep removes a leftover `mbw-ask-*` folder and leaves a
  junction inside it, a top-level junction with that name, a file with that
  name, other folders and nested ones alone; and the context holds no path,
  cwd, session id, user name or home folder name. Revert checks: putting the
  prompt into argv makes two of them fail; letting unknown lines through makes
  twelve fail.
- `npm run test:ask-live`: the same suite plus ONE real agy run (it spends
  quota, so it is not in `npm test`): asked to write a file and run a command,
  with the watchdog off, the working folder must stay empty and no command tool
  may complete. It prints SKIP when agy is missing, signed out or out of quota.
- `npm run test:render`, in a window of its own with the wall's options: the
  chip; opening with focus REFUSED (the field stays read-only and says why);
  the pending state; markup shown as text; the panel with a long answer at all
  eight sizes (the window's real viewport checked first, then: inside the
  window, under the action row, the body scrolling, nothing wider than the
  panel, text at least 8 px); a real click on the field borrowing focus, with
  the window and the field really holding it; focus going back when the window
  loses it (the panel stays open); the last five kept; Escape closing it and
  returning focus; `ask:open` reopening it; and the stats edition built and
  loaded with no chip, no panel and no bridge.

  Why a window of its own: in the shared test window, after the rest of the
  file had run, the renderer stopped taking new sizes (the native window
  resized and `innerWidth` did not), so every size would have measured the same
  layout. The cause was not found. Each size now checks `innerWidth` before it
  trusts a measurement.
