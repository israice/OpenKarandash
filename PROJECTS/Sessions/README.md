# 💬 Sessions

**Talk to a locally installed agent right in the browser: every step is visible and nothing is lost on reload.**

A section of the Mission Control interface. The toolbar button is `chatButton` (label "Sessions"), the screen is `#chatView`, and everything about it lives in `PROJECTS/Sessions/`: the entry point `sessions.js`, its own markup in `session-view.eta` (rendered into the page by the server, `{{SESSION_VIEW}}`), styles in `sessions.css`, and the parts next to them. In `SYSTEM/index.html` only the container exists — `#chatView` with the `{{SESSION_VIEW}}` placeholder.

The file names used to say `chat` and nothing else did — that was the section's former name, and it outlived the rename. Now the name matches the folder, the button and the screen id.

## 🧭 What this is

The tab where you talk to the locally installed CLI (**pi**, `DOCS/decisions/074`, `094`). You write a question, the server launches the connector you picked in the header, and the answer does not arrive as one lump at the end but as a **stream of events**: first the session id, then every tool call (`read app.js`, `bash git status`), then the text. The whole conversation goes into SQLite, so you can come back to it at any time.

On the left is the **Sessions** panel with every conversation started from this interface. The interface-section cards (the README of each section) live in a separate top-menu tab — **Book** (`PROJECTS/Book/book-tab.js`).

## ✨ Features

- **A live stream of steps.** Every tool call is its own row in the feed, and you see what the agent reads, edits and runs before it even formulates an answer. Steps are written to the database and stay visible when the session is reopened.
- **Continuing a conversation.** Clicking a session in the panel opens its history and continues that exact one: the next question goes to the CLI with `--resume <id>`, so the model remembers the context.
- **Reattaching to work in progress.** If you closed or refreshed the tab in the middle of a request, the CLI does not stop. `/api/sessions` marks such sessions with `running`, and `POST /api/sessions/attach` returns the stream of remaining events: the feed keeps filling from where you left it.
- **Two send modes.** `Action` lets the agent work for real — it edits files. `Chat` is discussion without consequences: the mode is written into the session row, and pi's own `--tools read,grep,find,ls` leaves the agent only the reading tools, so the restraint of `Chat` is enforced by the CLI and not only by the wording (`DOCS/decisions/093`).
- **Markdown in answers.** Headings, lists, links, inline code and ``` blocks are rendered as HTML — an answer reads like a document rather than a wall of `pre-wrap`.
- **Model on the fly.** The header of an open session carries the same four dropdowns as Settings — **CLI / Gateway / Provider / Model** — built by the same code (`SYSTEM/model-cascade.js`) and writing to the same saved choice. A change applies to the next message in the same session, appears at once in Settings, and is still there after a page reload. Only connected CLIs are listed here: the turn goes to the chosen one, and it cannot go to one that is not connected. The CLI level lists the agents from OpenRouter's "CLI agents" page (`SYSTEM/cli-agents.js`) plus a disabled **Add** row, not the project's own providers — the real agent appears in that list under its own name (`pi`) and stays real because that name is a provider id.
- **Stop without side effects.** The `Send` button turns into `Stop` while the open session is running and kills that session's process specifically — switch to another session and the state is recomputed. The truth about "is it running" is the orange circle in the panel, so the button appears even when the turn started elsewhere: in another tab, from Telegram or from Flow.
- **Everything the server knows is visible.** Under each reply and each tool step there is a collapsed `Details` block with the model, token spend, Event Schema fields and the raw event — the same set the other two views show (`DOCS/decisions/039`).
- **A panel sized to taste.** The Sessions panel can be dragged by its right edge (minimum 210 px, maximum half the window); the width is remembered in `localStorage`.

## 🚀 How to use it

1. **Connect pi.** Settings → the pi provider → "Connect". The server looks for the CLI on this machine.
2. **Open the Sessions tab** and write a question in the field at the bottom. The field grows with the text; send with **Ctrl+Enter** (Cmd+Enter on a Mac) or the `Send` button.
3. **Pick a mode:** `Action` to act, `Chat` to discuss. `Action` is on by default.
4. **Watch the work unfold** — steps appear in the feed as calls happen, and the answer is appended right away.
5. **Switch between sessions** by clicking in the panel on the left. The last one you opened is reopened on reload; if it is gone, the most recent session is opened instead, and if the database is still empty the tab comes up with a blank sheet for a new session. Clicking the selected row again (or `+ New`) starts a separate history — a draft appears in the list immediately. The bin icon deletes one session, `Reset All` deletes them all.
6. **Copy a link to the session** with the copy button on the row — what gets copied is not the bare id but the id, the session title and the command that prints the whole conversation: `node TOOLS/sessions/read.mjs <id>`. An id on its own opens nothing outside the interface, so pasting it into a conversation left the reader hunting for where such sessions are kept (`DOCS/decisions/099`).

## ⚠️ Before you start

> **A request goes out under your own account** — the model provider you picked in the header pays for it. `Action` mode lets the agent change project files without asking.
>
> **The server only answers requests from this same machine**: requests from other addresses get a `403`. Since it can launch a local CLI, it must not be exposed to the outside.

## 🔧 How it works

The `/api/agent/ask` response is not a single JSON document but an **NDJSON** stream: one event per line, each arriving the moment it happens.

| Event | When | What it gives |
| --- | --- | --- |
| `{"type":"session","id":…}` | the very first line, before the answer | the session id — the row appears in the panel immediately |
| `{"type":"tool","name":…,"detail":…}` | the assistant called a tool | `Read app.js`, `Bash npm test`; the step is written to the database |
| `{"type":"delta","kind":…,"text":…}` | while text is being generated | a chunk of an answer or a thought; reassembled live in the feed |
| `{"type":"text","text":…}` | as it is generated | a chunk of the answer, straight into the feed |
| `{"type":"context","percent":…}` | together with the CLI's answer | context fill and window |
| `{"type":"done","text":…}` | at the end | the final answer; the exchange is written to the database at the same time |
| `{"type":"error","error":…}` | on failure | the error text |

Endpoints (all `POST`, localhost only):

| Path | Purpose |
| --- | --- |
| `/api/agent/ask` | sends a request to the CLI and streams the work as NDJSON |
| `/api/agent/stop` | stops the process of the given session |
| `/api/fragment/session-list` | the session list of the side panel, rendered as HTML by `sessions-server.js` |
| `/api/sessions` | the session list with `running`, the message count and the number waiting |
| `/api/sessions/new` | creates and returns a chat session immediately; on the first turn, the chat adopts the already-prepared standby desktop |
| `/api/sessions/messages` | the conversation of one session (questions, answers, steps) |
| `/api/sessions/attach` | the stream of remaining events of work in progress |
| `/api/sessions/thumb` | the element preview for a session started from Karandash mode |
| `/api/image/session-thumb?id=…` | the preview itself as image bytes (`GET`, cached by `ETag` — the lists carry only the fact that a preview exists, see `DOCS/decisions/091`) |
| `/api/sessions/delete` | deletes one session (refused while it is running) |
| `/api/sessions/reset` | clears the whole database |

**The queue.** Jobs from all CLIs run strictly one at a time: no more than one turn runs in parallel. A new run waits until the ones already going have finished.

**Storage.** SQLite in the file `DATA/.sessions.db` (`node:sqlite`, no dependencies, `journal_mode = WAL`). The tables are `sessions` and `messages`; the `tool` role holds the work steps. Writing to the database never reloads the tab: the page follows commits, not file writes.

**Linux desktops.** In the root Docker Compose setup, OpenKarandash and the desktop manager start together. The manager's main desktop is the template; OpenKarandash also keeps one prepared standby desktop running. A chat adopts that standby on its first turn, while a replacement standby is prepared in the background. CLI detection/model discovery use the standby without assigning it to a chat; each streamed turn runs in the chat's own desktop, and the session-list button opens that container. Thus, with `N` active chat desktops, the expected manager total is `N + 2` (main template, standby, and one per chat). Deleting a chat removes its container and home-volume data but preserves the standby; other CLI choices continue through their existing executors.

**Tab state.** The CLI environment, the model and the current session id live in `localStorage`. After a reload the page restores the connection on the server, and if the same session is still running it opens it by itself and watches the rest of the stream. The session list refreshes every 8 seconds.

**Comments from Karandash mode.** A comment on an interface element starts a separate session: the selector and the comment text become the question, and a shot of the element is attached as a preview through `/api/sessions/thumb`.

## 📁 Files

The section is split by concern, so that a change in one thing does not touch the others. Nothing here is longer than 400 lines (`DOCS/decisions/022`).

| File | What is in it |
| --- | --- |
| `session-view.eta` | the markup of the tab — panel, feed, composer, file-editor panel. Rendered into the page by the server (`{{SESSION_VIEW}}`, see SYSTEM/core/version.js) and also served as `/api/fragment/session-view` |
| `sessions.js` | the entry point: send modes, the composer, panel handlers, restoring the connection and the last session on load. A module right after `app.js`, so it imports the core from there and adds its own functions to `window.App` |
| `sessions-state.js` | the section's shared mutable state in one object (`export const state`) plus `PENDING_SESSION_ID`; imports nothing |
| `sessions-panel.js` | The Sessions panel: the list, selection and deletion, drafts, the "running" indicator, composer busy state, the live duration counter, the re-hook after htmx swaps the list. Also `copySessionRef` — what the copy button puts on the clipboard |
| `sessions-feed.js` | the feed's drawing code, gathered in one place: markdown, replies, tool steps and thoughts (thoughts open in full, no accordion — `DOCS/decisions/121`), the waiting row with its clock, scroll rules and the tool-step accordion |
| `sessions-feed-message.js` | a reply in the feed: the model's answer, the human's line, the error line. The only place an answer becomes HTML |
| `sessions-feed-steps.js` | a tool step: what the agent did, and the accordion of its body |
| `sessions-feed-thinking.js` | a block of thoughts: the tag in the head, the paragraphs in the body |
| `sessions-feed-input.js` | the prompt that actually went to the model, under its own accordion |
| `sessions-feed-pending.js` | the waiting row with its clock, and the "turn interrupted" notice with the continue button |
| `sessions-feed-tag.js` | the coloured tag to the left of a row — the one tag for steps, thoughts and prompts |
| `sessions-feed-markdown.js` | the small markdown parser for the model's answer |
| `sessions-feed-scroll.js` | the scroll rules: follow to the bottom only if the reader was already there |
| `sessions-details.js` | the fullness of a session row: field summary, raw event, result images, the step body and the `Details` block under a reply |
| `sessions-history.js` | a row from the database → the feed: one role → one kind, plus "this turn was not finished" |
| `sessions-ndjson.js` | reading the NDJSON stream, surviving a dropped connection (`followRun`), stopping a turn |
| `sessions-stream.js` | the turn itself: stream events → feed rows, sending the question, opening a session, re-reading the history afterwards |
| `sessions.css` | the tab's own styles: layout, panel, session list, header, gauges, composer |
| `sessions-server.js` | the server half of the panel: the `/api/fragment/session-list` route, and the `session-list.eta` template next to it |
| `SYSTEM/styles/messages.css` | the vocabulary of feed messages — shared by Sessions, Feed and Flow, which show the same rows |
| `SYSTEM/styles/mode-switch.css` | the send-mode switch — shared with the Karandash comment popup |
| `SYSTEM/app.js` | the shared core the tab imports: `api()`, modals, the lightbox, `App.VIEWS`, restoring the CLI connection, `escapeHtml` |
| `SYSTEM/providers.js` | providers and connections, the context gauge |
| `SYSTEM/model-cascade.js` | the four dropdowns in the session header and the saved choice behind them — the same code and storage Settings uses |
| `SYSTEM/sidebar-resize.js` | the handle on the panel's right edge: dragging the width, with persistence |
| `PROJECTS/Book/book-tab.js` | the Book top-menu tab: cards for the interface sections that open their README |
| `PROJECTS/Graph/file-editor.js` | the file editor panel the tab shows instead of the feed |
| `server.js` | what belongs to no single tab: the CLI connectors, the `/api/agent/*` and `/api/sessions/*` routes, the session database |
| `DATA/.sessions.db` | SQLite with sessions, messages and previews (not tracked by git) |

---

This project is distributed under the MIT license.