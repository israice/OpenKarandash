# OpenKarandash

**A local orchestrator for agentic CLIs: a Node server plus a web interface.**

One page in the browser from which you talk to the Claude Code CLI installed on your machine, watch
every step it takes, keep the whole history, and see the project as a live map. No cloud, no account
of its own — the server only runs the CLI that is already yours, and answers requests from this
machine only.

What is inside:

| Tab | What it is for |
| --- | --- |
| **Home** | A live summary: how many sessions are running, activity, provider state |
| **PROJECTS** (Chat) | The conversation with the assistant: a stream of steps, session history, `Action` / `Chat` modes |
| **Graph** | A map of the project — files, sections, functions, routes and session memory — plus full-text search |
| **Flow** | An infinite canvas: the task as a diagram of nodes and arrows |
| **Kanban** | A task board (a skeleton for now: the columns exist, the cards do not) |
| **Book** | A card for every section, linking to its README |
| **Karandash** | Point at an element on the page, describe what is wrong — the assistant goes and fixes the sources |
| **Settings** | Finding and connecting a CLI, the model, the effort, the subscription limits |

Besides the Claude CLI the server can drive **OpenCode** — the same routes, another connector
in the `AGENTS` table.

## Requirements

Only Node.js 22.5+ has to be there beforehand — it runs the start command itself. Everything else
is checked on start and installed when missing (`SYSTEM/core/host-deps.js`): git, Python 3.10+,
Docker (Docker Desktop via winget on Windows, `apt` engine or the Windows Docker Desktop through
WSL integration in WSL), the Claude Code CLI through its official installer, and if the CLI is not
signed in, `claude auth login` runs right in that terminal. Installers use the platform's own
tools (winget / apt with sudo), so a UAC window or a sudo password prompt may appear on the first
run. The CLI checked is the one selected in Settings (WSL or Windows), by default the host's own;
the server then connects it automatically, so a fresh clone works without opening Settings.
`HOST_DEPS=0` in `.env` skips this check. Docker Desktop on Windows may require signing out and
back in after its installation — the server says so and starts without Hermes until then.

## Running

One command from the project root, the same in PowerShell and in WSL:

```powershell
cd C:\0_PROJECTS\OpenKarandash
node server.js
```

Before starting the server the watchdog brings the whole stack into shape (`SYSTEM/core/hermes-stack.js`):
installs or updates what is missing (npm packages per `package.json`; `hermes/` — the upstream
[hermes-agent](https://github.com/NousResearch/hermes-agent) is not kept in this repo but cloned on
the first run and fast-forwarded to the latest `main` on every later run, `HERMES_REPO`/`HERMES_REF`
in `.env` override the source; the Hermes Docker image when its sources changed), adds the missing keys and
generated secrets to `.env` and `claude-bridge/.env`, then starts `claude-bridge` on the host
(python) and Hermes in Docker (`docker compose up -d gateway`, no dashboard) alongside the server.
`Ctrl+C` stops everything: the server, the Hermes container and the bridge. If Docker or python
could not be installed or started, the server still starts and says so — only Hermes is unavailable then.
`HERMES_STACK=0` in `.env` turns the whole stack off (the command then starts just the server).
The full key list is in `.env.example` — nothing there has to be filled in by hand.

On the first run the server creates a `.env` at the project root with port 3001 and starts on it:

```
Created .env with port 3001 — edit the port and secrets there
Server started: http://localhost:3001
```

## Your own port and secrets

`.env` is the only place where the port and any secrets live. The file is not tracked by git.

```
PORT=8123

# Path to the Claude CLI, if it is not in PATH
# CLAUDE_BIN=
# External Obsidian vault instead of the vault/ folder inside the project
# OBSIDIAN_VAULT=
```

The port is taken strictly from `.env`; the server does not fall back to neighbouring ones: a second
copy on the same folder would fight the first over `DATA/.sessions.db` and `DATA/.index.db`
("database is locked") and blindly overwrite `vault/`. If the port is busy, the server says so and
exits — most likely it is already running at that address.

An environment variable overrides `.env` (handy for starting a second copy on a free port), but for
normal work there is no need to touch the environment.

## Auto-reload

The server watches the project files. Save `index.html` (or any other file) and the open tab reloads by itself — no manual refresh needed.

It works like this: a small script is mixed into the served HTML on the fly, and it keeps an SSE connection to `/__reload`. The project files themselves are not modified.

While a request to Claude is in flight, auto-reload is deferred — both in the browser and on the server. Claude from the chat edits project files, `server.js` included, and reloading the tab would break reading the stream while restarting the server would break the CLI process itself. Both updates fire as soon as the request is finished: the child process tells the parent it is busy over IPC, and the page does the same through `window.__holdReload`.

If the tab was closed or refreshed by hand mid-work anyway, the CLI does not stop: the request is carried to completion, and the question, the steps and the answer go into the database.

More than that, the refreshed page **reattaches to the work in progress**: `/api/sessions` marks such sessions with a `running` field, and `POST /api/sessions/attach` with a session id returns the stream of its remaining events — the same ones `/api/claude/ask` sends. The feed keeps filling live from where you left it. If the session has already finished, the answer comes back as ordinary JSON (`{"ok":true,"running":false}`) and the page simply shows the conversation from the database.

Edits to `server.js` itself are also applied without a manual restart: the server runs in a child process, the parent watches the file and brings the child back up, and the tab reloads once the connection is restored. In the console it looks like this:

```
server file changed — restarting the server...
Server started: http://localhost:3001
```

To disable auto-reload (then both the restart and the page refresh are manual):

```powershell
$env:NO_RELOAD=1
node server.js
```

## If the page does not refresh by itself

- The address bar must show `http://localhost:...`, not `file:///C:/...`. When a file is opened by double-clicking, the server is not involved.
- Do not keep many tabs with the same page open: each one holds a persistent connection, and the browser allows no more than six per host — the seventh tab simply will not load.

## The Claude CLI connector

In the Settings dialog, the "Connect" button on the Claude provider does real work: the server looks for the Claude CLI in two environments at once — in Windows and in WSL.

- One environment found — it connects immediately.
- Both found — a selection dialog opens, and a click on a row connects.
- None found — a dialog with a hint about what to do.

After connecting, the provider row shows the environment and the CLI version, with the model list next to it. Messages from the Chat tab go to the chosen CLI and come back as an answer in the feed; the conversation continues in one session, so the model remembers the previous messages.

What you need: an installed Claude Code CLI. If it is not in `PATH`, give the path at startup:

```powershell
$env:CLAUDE_BIN="C:\Users\user\.local\bin\claude.exe"
node server.js
```

How the server looks for the CLI:

| Server runs in | Windows installation | WSL installation |
| --- | --- | --- |
| Windows | `claude` | `wsl.exe bash -lc "claude ..."` |
| WSL | `claude.exe` | `claude` |

Endpoints (all `POST`, local requests only):

| Path | Purpose |
| --- | --- |
| `/api/claude/detect` | looks for the CLI in every environment, returns the ones found |
| `/api/claude/connect` | fixes the chosen environment |
| `/api/claude/ask` | sends a request to the CLI and streams the work |

Requests to the CLI run **strictly one at a time**: no more than one turn works in parallel. A new run waits until the ones already going have finished (`activeRuns`/`waitForTurn` in `server.js`); while it waits, the page shows "Queued". This guarantees there is no conflicting write to the same file from two sessions at once — no separate file locks and no PreToolUse hook are needed for it.

A second hook works alongside it — the PostToolUse `.claude/hooks/syntax-check.js`. After every `Edit`/`Write` it runs `node --check` and, if the code no longer parses, returns the error text straight into the session. The server already rejects such an edit during its self-restart (it keeps the previous version running), but it writes about it to its own console — the session never learns about the error and keeps working against broken code. The hook closes exactly that gap.

Both `.js` and inline `<script>` in `.html` are checked: the bulk of the code lives in `index.html`, and nothing insures it — the server's self-check covers only `server.js`. From `.html` the contents of a bare `<script>` tag are taken and everything else is replaced with empty lines, so the line number in the error is the line number in `index.html` itself. Scripts with attributes (`src`, `type="module"`) are skipped by the hook. So are other files.

The `/api/claude/ask` response is not a single JSON document but an NDJSON stream (`claude -p --output-format stream-json --verbose`): one event per line, each arriving the moment it happens.

| Event | When | What it gives |
| --- | --- | --- |
| `{"type":"queued","ahead":N}` | before the start, if the CLI is busy | the request is queued, with N jobs ahead |
| `{"type":"session","id":…}` | the very first line, before the answer | the session id — the row appears in the Sessions panel immediately |
| `{"type":"tool","name":…,"detail":…}` | Claude called a tool | what it is doing right now: `Read README.md`, `Bash npm test`; the step is written to the database and is visible when the session is reopened |
| `{"type":"text","text":…}` | as it is generated | a chunk of the answer, straight into the feed |
| `{"type":"done","text":…}` | at the end | the final answer; the exchange is written to the database at the same time |
| `{"type":"error","error":…}` | on failure | the error text |

The connection does not fall off: the chosen environment, the model and the CLI session id are saved in the browser's `localStorage`. After a page reload the tab restores the connection by itself and continues the same conversation, and if the server has been restarted it quietly hands it the chosen environment back before sending the request. The "Disconnect" button clears the saved state.

Note: every request from the chat consumes your Claude account's limit. A simple request to `claude-haiku-4-5` cost roughly $0.05.

The server only answers requests from this same machine: requests from other addresses get a `403`. Since it can launch a local CLI, it must not be exposed to the outside.

## Sessions

The Sessions panel on the Chat tab shows the sessions started from this interface. Clicking a session opens its conversation and continues that exact one: the next question goes to the CLI with `--resume`. The "+ New" button clears the feed, and the next question starts a separate history. A comment from Karandash mode also starts a new session — the element selector and the comment text become the question.

Storage is SQLite in the file `DATA/.sessions.db` (the `node:sqlite` module, no dependencies). File watching skips the `DATA/` folder, so writing to the database does not trigger a page reload.

Where the sessions come from: the server writes every exchange that went through `/api/claude/ask` into the database — the question, the answer and the `session_id` the CLI returned. The server does not read the Claude CLI's own history (`~/.claude/projects/*/*.jsonl`), so interactive sessions launched in a terminal in the same directory do not appear in the list.

To clear the list:

```bash
curl -s -X POST http://localhost:3001/api/sessions/reset
```

The database is cleared; the Claude CLI's own history files are left alone.

## Knowledge map (Obsidian)

The **Graph** tab shows the project map. There is nothing to configure: on startup the server creates `vault/` at the root and fills it with notes, so the tab opens ready to use.

**What becomes a node.** A project file, a section inside a large file (by the `// ---------- … ----------` separator comments), a top-level function, an API route and a past Claude session.

The map includes **everything that physically sits in the project folder** — including hidden files and things git ignores: `.env`, `.claude/settings.local.json`. There are exactly two exceptions, both unavoidable: `.git` (an internal database of thousands of objects, in which the project's contents are duplicated) and `DATA/` — everything the server produced itself: the vault is already present in the graph as nodes, and walking it again would breed notes about notes with every rebuild.

**Where the links come from.** Only from anchor points, not from matching names: `/api/...` string literals (which is why you can see who calls which route), `src`/`href` in markup, `require`/`import`, function calls inside a file, `[[…]]` links in notes. Separately there is git history: files that change together, and when a file first appeared.

**Session memory.** `vault/Sessions/` keeps one note per session: the subject, how it ended, which files were edited. If those files have changed since the session, the note is marked `stale` and drawn dimmed in the graph — a past decision should not read as the current one.

**A live layout.** The nodes spread out under a force simulation before your eyes and settle once the graph calms down (no battery burned for nothing). Any node can be **dragged with the mouse** — the neighbours follow, and after you let go the graph settles by itself. Hovering brings a node and its links to the front and dims the rest; search matches pulse. All of this respects the system "reduce motion" setting.

**Controls.** The mouse wheel zooms, dragging empty space pans, dragging a node moves it, hovering highlights the neighbours. The chips on the left turn node kinds on and off (functions and sessions are off by default, otherwise the graph becomes unreadable); the choice is remembered in the browser. The search field highlights matches directly in the graph.

**Clicking a node** opens a window with the contents: a project file itself — editable and saveable (a button or `Ctrl+S`), and for a section node or a function node the text is already scrolled to the right line. The node's links are shown as chips at the top of the window — you can navigate through them without closing it. Vault notes open read-only: they are rebuilt by the server, and an edit would vanish on the next rebuild. Binary files show only their size.

## Project search

Full-text search (FTS5 with BM25 ranking) across code, vault notes and past sessions. The index lives in `DATA/.index.db` and is built by the server together with the map.

```bash
node PROJECTS/Graph/search.js "live reload"
node PROJECTS/Graph/search.js --kind session "graph"
```

It works without a running server too — it reads the prebuilt index. The same search is available at `POST /api/search`, and the search field on the Graph tab uses it.

Storage is an ordinary Obsidian vault: the `DATA/vault/` folder can be opened in Obsidian and you can write your own notes alongside; they will show up both in the graph and in the search. Only `DATA/vault/Project/` is overwritten. Neither the vault nor the index is tracked by git.

A different vault is set with an environment variable:

```bash
OBSIDIAN_VAULT="C:/path/to/vault" node server.js
```

## Stopping

`Ctrl+C` in the terminal running the server.

## Structure

| Path | Purpose |
| --- | --- |
| `server.js` | A thin dispatcher: `.env`, static files, sessions, live CLI runs. Everything feature-specific lives next to the feature and is wired in through a route table |
| `SYSTEM/` | The client shell: `index.html`, `app.js`, `tabs.js`, the toolbar and panel scripts, `core/`, `styles/`, `assets/` |
| `PROJECTS/<Section>/*.eta` | Templates for the server fragments that htmx pulls in — next to the feature that renders them |
| `PROJECTS/<Section>/` | One folder per interface section — client, styles, the server half and its own README. A page created by the toolbar's «+» button is one of these too: its `page.js` *is* the page |
| `DOCS/decisions/` | Why something in the project is done the way it is; a new decision goes here when the "why" is not visible from the code |
| `AGENTS.md` / `CLAUDE.md` | The project rules for any agent, and the Claude Code specifics on top of them |
| `VERSION.md` | The version history; its last `DEV LOG` line is the single source of truth about the version |
| `PLAN.md` | The plan for splitting the code into modules |
| `DATA/` | Everything the server built itself: the vault (`vault/Project/`, `vault/Sessions/`), the `.index.db` search index, the `.sessions.db` session database (not tracked by git) |

## What the server does

- `/` → serves `SYSTEM/index.html`
- any other path → the corresponding file from the project directory with the right `Content-Type`
- a non-existent file → `404`
- an attempt to escape the project directory → `403`
- `POST /api/obsidian/graph` → returns the vault's nodes and links for the Graph tab
- `POST /api/search` → full-text search across code, notes and sessions
- `POST /api/file/read` → a file's contents for the node window (inside the project directory only)
- `POST /api/file/write` → saving an edit from the window (vault notes and binary files are rejected)

## Checking without a browser

```bash
curl -i http://localhost:3001/
```

## Automated checks

There are none. The smoke test was removed (`DOCS/decisions/025`): keeping it in step with the routes
cost more than it caught. A server file is checked by parsing it — `node --check <file>` — and whether
a feature actually works is checked by hand in the browser, on the server the user starts themselves.
The client-side checklist is in `PLAN.md`.
