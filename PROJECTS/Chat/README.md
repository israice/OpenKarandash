# 💬 PROJECTS

**Chat with an AI assistant right in the browser: every step is visible and nothing is lost on reload.**

A Mission Control interface section. The toolbar button is `chatButton` (aria-label "PROJECTS"), the screen itself is `#chatView`, the logic is in `PROJECTS/Chat/chat*.js` — the entry point `chat.js` plus `chat-state.js`, `chat-sessions.js`, `chat-feed.js` and `chat-stream.js` (`DOCS/decisions/022`); it used to sit in `SYSTEM/app.js`, which now keeps only the shared core of `window.App`. The internal names are left over from the section's former name — `chat` — so that is what to look for in the code.

## 🧭 What this is

The tab where you talk to the locally installed **Claude Code CLI**. You write a question — the server runs `claude -p --output-format stream-json --verbose`, and the answer does not arrive as one lump at the end but as a **stream of events**: first the session id, then every tool call (`Read app.js`, `Bash git status`), then the text. The whole conversation goes into SQLite, so you can come back to it at any time.

On the left is the **Tasks** panel with every conversation started from this interface. While no session is selected, the feed shows a demo layout of task cards ("User Chat") — that is a mock-up of a future multi-agent view, not live data. The interface section cards (the README of each section) have moved to a separate top-menu tab — **Book** (`PROJECTS/Book/book-tab.js`).

## ✨ Features

- **A live stream of steps.** Every tool call is its own row in the feed. You can see what the assistant reads, edits and runs before it even formulates an answer. Steps are written to the database and stay visible when the session is reopened.
- **Continuing a conversation.** Clicking a session in the panel opens its history and continues that exact one: the next question goes to the CLI with the `--resume <id>` flag, so the model remembers the context.
- **Reattaching to work in progress.** If you closed or refreshed the tab in the middle of a request, the CLI does not stop. `/api/sessions` marks such sessions with a `running` field, and `POST /api/sessions/attach` returns the stream of remaining events: the feed keeps filling from where you left it.
- **Parallel runs with file-based locking.** Several sessions run at once as long as their files do not overlap. If they do, the new one waits for **exactly those** sessions that hold the file, and shows "Queued: N ahead".
- **Two send modes.** `Action` runs the CLI with `--permission-mode bypassPermissions` — the assistant really edits files. `Chat` is discussion without consequences: `--permission-mode plan`, `Edit`/`Write`/`Bash`/`Task` disabled, `--strict-mcp-config`, plus a "change nothing" preamble.
- **Markdown in answers.** Headings, lists, links, inline code and ``` blocks are rendered as HTML — an answer reads like a document rather than a wall of `pre-wrap`.
- **Model and effort on the fly.** The header of an open session has selects for the provider, the model and `effort` (`low` … `max`). A change applies to the next message in the same session. The provider selection is informational for now: the work goes through the Claude CLI.
- **Subscription limits.** The CLI sends a `rate_limit_event` with every request — the 5-hour and 7-day windows with their percentage and reset time are visible in Settings under the Claude provider.
- **Stop without side effects.** The `Send` button turns into `Stop` while a session is running and kills that session's process specifically — switch to another session and the state is recomputed.
- **A panel sized to taste.** The Tasks panel can be dragged by its right edge (minimum 210 px, maximum half the window); the width is remembered in `localStorage`.

## 🚀 How to use it

1. **Connect Claude.** Settings → the Claude provider → "Connect". The server looks for the CLI both in Windows and in WSL; if both are found, pick an environment.
2. **Open the PROJECTS tab** and write a question in the field at the bottom. The field grows with the text; send with **Ctrl+Enter** (Cmd+Enter on a Mac) or the `Send` button.
3. **Pick a mode:** `Action` to act, `Chat` to discuss. `Action` is on by default.
4. **Watch the work unfold** — steps appear in the feed as calls happen, and the answer is appended right away.
5. **Switch between sessions** by clicking in the panel on the left. Clicking the selected one again deselects it. `+ New` starts a separate history (a draft appears in the list immediately), 🗑 deletes one session, `Reset All` deletes them all.
6. **Copy the session id** with the `Copy ID` button in the header — a human-readable name is shown next to it, but what gets copied is the CLI's real `session_id`.

## ⚠️ Before you start

> **Every request from the chat consumes your Claude account's limit.** A simple request to `claude-haiku-4-5` cost roughly $0.05. `Action` mode runs with `bypassPermissions` — the assistant changes project files without asking.
>
> **The server only answers requests from this same machine**: requests from other addresses get a `403`. Since it can launch a local CLI, it must not be exposed to the outside.

## 🔧 How it works

The `/api/agent/ask` response is not a single JSON document but an **NDJSON** stream: one event per line, each arriving the moment it happens.

| Event | When | What it gives |
| --- | --- | --- |
| `{"type":"queued","ahead":N}` | before the start, if the files are busy | N jobs ahead; "Queued" is shown |
| `{"type":"session","id":…}` | the very first line, before the answer | the session id — the row appears in the panel immediately |
| `{"type":"tool","name":…,"detail":…}` | the assistant called a tool | `Read app.js`, `Bash git status`; the step is written to the database |
| `{"type":"text","text":…}` | as it is generated | a chunk of the answer, straight into the feed |
| `{"type":"rate_limit","info":…}` | together with the CLI's answer | the 5-hour / 7-day limit windows |
| `{"type":"done","text":…}` | at the end | the final answer; the exchange is written to the database at the same time |
| `{"type":"error","error":…}` | on failure | the error text |

Endpoints (all `POST`, localhost only):

| Path | Purpose |
| --- | --- |
| `/api/agent/detect` | looks for the CLI in Windows and WSL, returns the environments found |
| `/api/agent/connect` | fixes the chosen environment and returns the CLI version |
| `/api/agent/ask` | sends a request to the CLI and streams the work as NDJSON |
| `/api/agent/stop` | stops the process of the given session |
| `/api/fragment/chat-sessions` | the session list of the side panel, rendered as HTML by `chat-server.js` |
| `/api/sessions` | the session list with `running`, the message count and the number waiting |
| `/api/sessions/messages` | the conversation of one session (questions, answers, steps) |
| `/api/sessions/attach` | the stream of remaining events of work in progress |
| `/api/sessions/thumb` | the element preview for a session started from Karandash mode |
| `/api/sessions/delete` | deletes one session (refused while it is running) |
| `/api/sessions/reset` | clears the whole database |

**The queue.** Jobs from all CLIs run strictly one at a time: no more than one turn runs in parallel (`activeRuns`/`waitForTurn` in `server.js`). A new run waits until the ones already going have finished — no file locks and no separate PreToolUse hook are needed for this.

**Storage.** SQLite in the file `DATA/.sessions.db` (`node:sqlite`, no dependencies, `journal_mode = WAL`). The tables are `sessions` and `messages`; the `tool` role holds the work steps. File watching skips the `DATA/` folder, so writing to the database does not reload the tab. The server does not read the Claude CLI's own history (`~/.claude/projects/*/*.jsonl`) — interactive sessions from the terminal do not appear in the list.

**Tab state.** The CLI environment, the model, the `effort` and the current session id live in `localStorage` under the key `noname.claude`. After a reload the page restores the connection on the server, and if the same session is still running it opens it by itself and watches the rest of the stream. The session list refreshes every 8 seconds.

**Comments from Karandash mode.** A comment on an interface element starts a separate session: the selector and the comment text become the question, and a shot of the element is attached as a preview through `/api/sessions/thumb`.

## 📁 Files

| File | What is in it |
| --- | --- |
| `PROJECTS/Chat/chat.js` | the tab's entry point: send modes, the composer, wiring the panel, the feed and the stream together. Connected as `<script type="module">` right after `app.js`, it imports the core from there and adds its own functions to `window.App` |
| `PROJECTS/Chat/chat-state.js` | the tab's shared mutable state in one object (`export const state`); imports nothing |
| `PROJECTS/Chat/chat-sessions.js` | the Tasks panel: the list, selecting and deleting sessions, drafts, the "running" indicator, composer busy state |
| `PROJECTS/Chat/chat-feed.js` | the message feed: markdown, tool steps and thinking, autoscroll, the preview lightbox |
| `PROJECTS/Chat/chat-stream.js` | the NDJSON stream: `ask`/`attach`/`stop` and turning CLI events into feed rows |
| `SYSTEM/app.js` | the shared core the tab imports: `api()`, modals, the lightbox, `App.VIEWS`, restoring the CLI connection, `escapeHtml` |
| `SYSTEM/providers.js` | providers and connections, subscription limits, the session header with model and effort, the context gauge |
| `SYSTEM/sidebar-resize.js` | the handle on the panel's right edge: dragging the width, with persistence |
| `PROJECTS/Book/book-tab.js` | the Book top-menu tab: cards for the interface sections that open their README (it used to live here as the `Projects` tab) |
| `SYSTEM/index.html` | the `#chatView` markup and styles: panel, session header, feed, composer |
| `PROJECTS/Chat/chat-server.js` | the server half of the side panel: the `/api/fragment/chat-sessions` route and the `chat-sessions.eta` template next to it |
| `PROJECTS/Chat/pages-server.js` | the server half of the pages made by the toolbar's «+» button |
| `server.js` | what belongs to no single tab: the CLI connectors, the `/api/agent/*` and `/api/sessions/*` routes, the session database |
| `DATA/.sessions.db` | SQLite with sessions, messages and previews (not tracked by git) |

---

This project is distributed under the MIT license.
