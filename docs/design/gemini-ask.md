# Ask Gemini on the wall | design (2026-11-06)

A question box on Gustav's wall that sends a question to Gemini and shows the
answer, with the wall's own numbers (and later Work mode's mail and tasks)
available to Gemini as context.

**Status: implemented 2026-11-06, on the Antigravity CLI, not the Gemini CLI.**
How it works, the lock-down and what is sent: [../ask-gemini.md](../ask-gemini.md).
Section 6 records why the backend changed after sections 4 and 5 were decided.

## 1. What Google AI Plus does and does not give

Sources: Grok job `gemini-ai-plus-facts`, official Google pages, read 2026-11-06.

- **AI Plus has no Gemini API.** The plan covers the Gemini app (3.6 Flash and
  limited Omni Flash), Gemini in Gmail and Docs, 400 GB, and 200 monthly AI
  credits for Flow, Whisk and Antigravity. No API key, no API credits, no Cloud
  credits (those start at AI Pro: US$10 a month). API billing is a separate
  Cloud Billing account. (one.google.com/intl/en_za/about/google-ai-plans,
  ai.google.dev/gemini-api/docs/billing)
- **Gemini CLI does not support AI Plus.** Its documented quotas are personal
  login 1,000 requests a day, AI Pro 1,500, AI Ultra 2,000, and "tiers not
  listed, including Google AI Plus, are not supported". Calling the service
  behind the CLI from other software breaks its terms.
  (github.com/google-gemini/gemini-cli, quota-and-pricing.md, tos-privacy.md)
- **gemini-bridge** (Gustav's existing MCP server) does use the AI Plus
  allowance, by driving gemini.google.com in a dedicated Chrome profile. It is
  built for Claude's occasional calls: one call at a time, a Chrome start on
  first use, answers in tens of seconds, and it breaks when Google changes the
  page. Not a fit for a box on the wall you type into.

So the wall needs **the Gemini API**, with its own key, separate from AI Plus.

## 2. The Gemini API

| | Free tier | Paid tier |
|---|---|---|
| Models | Gemini 3.8 Flash, 3.6 Flash | Plus 3.1 Pro Preview, Gemini 4 Argon |
| Price per 1M tokens | free | 3.8 Flash: $0.75 in, $3.75 out (to 31 Dec 2026; then $1.50 and $7.50) |
| Your questions used to train and reviewed by people | **Yes** | No (kept for a limited time for abuse checks only) |
| Google Search grounding | Not on 3.8 Flash | 5,000 searches a month free, then $14 per 1,000 |
| Rate limits | Per project, shown in AI Studio, not guaranteed | Higher |
| Setup | AI Studio key | Link Cloud Billing, prepay at least $5 |

South Africa is a supported region. A typical wall question (about 3,000
tokens of context and question, 800 tokens of answer) costs about **half a US
cent** on 3.8 Flash paid, so $5 lasts on the order of a thousand questions.

## 3. Design

- **Where:** an `ASK` chip in the wall's top bar, and a hotkey. It opens an
  input bar that borrows keyboard focus the way the notes bar does
  (`docs/notes-bar.md`), and the answer streams into a panel over the wall.
  Escape closes it. The last few questions of the session stay in a list.
- **What Gemini can see:** read-only functions the wall offers it through
  function calling: Claude and Codex totals and daily figures, models, top
  projects, plan limits; later, Work mode's tasks and mail headers. It only
  gets what a question needs, nothing is sent unless asked, and it can never
  change anything (no write functions in v1).
- **Web answers:** Google Search grounding on, so "what changed in Claude Code
  this week" works; sources listed under the answer.
- **Model:** `gemini-3.8-flash` by default; Pro as a choice in the tray.
- **Plumbing:** the call is made in the main process (the renderer stays
  `connect-src 'none'`), streaming over `streamGenerateContent`. The key lives
  in `safeStorage`, entered once in a small dialog, never logged, never on the
  projection wire. Answers are model-written text, shown as text with light
  formatting (no HTML), marked as Gemini's.
- **Full build only**, like Work mode. Never projected to a paired screen.
- **Cost guard:** a monthly spend line in the panel (tokens times list price)
  and a cap you set, after which it stops asking.
- Security-sensitive (a secret, outbound data): tests that the key never
  reaches the renderer, a log or the wire, and an independent Opus audit.

## 4. Decisions (Gustav, 2026-11-06)

1. **No paid API.** Ask Gemini runs through the **Gemini CLI** on Gustav's own
   Google login: free, 1,000 requests a day on a personal account, with its
   built-in Google web search. A few seconds slower per answer than the API.
   Questions on this free tier may be used by Google to improve its products.
2. **Context:** the wall's usage numbers now; with Work mode, task names and
   mail subjects, and a mail body only when that mail is open and asked about.

## 5. How it changes the design (CLI route)

- The main process runs `gemini -p` headless with `--output-format json` (or
  streamed JSON events) once per question, with no shell: the question and the
  context the wall chose go in as one argument or on stdin, never through a
  command string.
- **The CLI's own tools are locked down.** It is a coding agent with shell and
  file tools; the wall runs it in an empty temporary folder with a settings
  file that allows only web search and nothing that runs commands or writes
  files. Tests prove a question cannot make it run a command or touch a file.
- Gemini cannot call back into the wall, so the wall puts the relevant numbers
  into the prompt itself (no function calling on this route).
- One-time setup: install the CLI (`npm install -g @google/gemini-cli`) and
  sign in once with Google. Its sign-in lives in the CLI's own folder; the
  wall never holds a Google token.
- If the CLI is missing or signed out, the ASK panel says so and shows the one
  command to fix it.
- Security-sensitive (it starts a process with outside input): the independent
  Opus audit applies.

## 6. The Gemini CLI was refused; Antigravity CLI is the backend (2026-11-06)

When Gustav signed in to the Gemini CLI (0.67.0) on 2026-11-06, Google refused
it: "Failed to sign in. Message: This client is no longer supported for Gemini
Code Assist for individuals. To continue using Gemini, please migrate to the
Antigravity suite of products". A headless run returned the same
`IneligibleTierError`. Section 1 had already found that the CLI does not support
AI Plus; this confirmed it on his account.

So the route in section 5 is built on the **Antigravity CLI** (`agy` 1.4.11),
which is signed in on his AI Plus account and runs Gemini 3.8 Flash. Everything
else in sections 3 to 5 stands: the panel, the hotkey, the focus loan, the
context the wall chooses, full build only, never projected, no shell, the
question on stdin, an empty temporary folder, tools locked down, tested.

What changed with the backend:

- The lock-down uses agy's own controls: a session-only `--settings` file whose
  deny rules replace the user's for the run (commands, file reads and writes,
  URL fetches, MCP), `toolPermission: strict`, `--mode plan`, and a watchdog on
  agy's event stream that kills any run using a tool other than web search.
- Quota is AI Plus's Antigravity baseline plus 200 monthly AI credits. It ran
  out after three short prompts while this was being built, so the panel names
  quota plainly, with the reset time agy gives.
- The model list comes from `agy models`; the tray offers its Gemini Flash
  models, default `gemini-3.8-flash-medium`.
- Gemini CLI code was not kept: one backend, in `src/main/ask/agy.ts`.
