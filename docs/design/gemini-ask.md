# Ask Gemini on the wall | design (draft for Gustav, 2026-11-06)

A question box on Gustav's wall that sends a question to Gemini and shows the
answer, with the wall's own numbers (and later Work mode's mail and tasks)
available to Gemini as context. Nothing here is built.

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

## 4. Open decisions

1. Paid tier with a $5 prepaid balance (recommended: private, Search
   grounding included, about half a cent a question) or the free tier
   (no cost, but Google may train on and read the questions, and no Search).
2. What Gemini may read: wall usage numbers (proposed yes); mail and task
   content once Work mode exists (proposed: subjects and task names yes, mail
   bodies only when you open that mail and ask about it).
