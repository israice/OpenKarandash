# OpenKarandash

**A local orchestrator for agentic CLIs: a web interface and per-chat Linux desktops.**

OpenKarandash and its Linux desktop manager run together in Docker Compose. For
OpenCode chats, every session gets an isolated Linux desktop; the chat history
and desktop lifecycle are managed by the local stack.

What is inside:

| Tab | What it is for |
| --- | --- |
| **PROJECTS** (Chat) | The conversation with the assistant: a stream of steps, session history, `Action` / `Chat` modes |
| **Graph** | A map of the project — files, sections, functions, routes and session memory — plus full-text search |
| **Flow** | An infinite canvas: the task as a diagram of nodes and arrows |
| **Kanban** | A task board (a skeleton for now: the columns exist, the cards do not) |
| **Book** | A card for every section, linking to its README |
| **Karandash** | Point at an element on the page, describe what is wrong — the assistant goes and fixes the sources |
| **Settings** | Finding and connecting a CLI, the model, the effort, the subscription limits |

## Requirements

Install Docker Desktop with Docker Compose v2.20+ and keep it running. On Windows,
enable Docker Desktop's “Expose daemon on tcp://localhost:2375 without TLS”
setting so the Linux desktop manager can create per-chat containers. Node.js
and the application dependencies run inside the Compose app container.

## Running

The one supported launch method is Docker Compose from the project root. It
starts OpenKarandash and the Linux desktop manager together; the app waits for
the manager to become healthy before starting:

```powershell
cd C:\0_PROJECTS\OpenKarandash
docker compose up -d --build
```

On Windows, Docker Desktop must be running and expose its daemon at
`tcp://localhost:2375` (Docker Desktop → Settings → General → “Expose daemon on
tcp://localhost:2375 without TLS”). The desktop manager is bound to localhost
on port 8080; OpenKarandash is on port 3001. The manager and desktop image are
included in the same Compose project, so there is no second startup command.

If you have been running the desktop manager separately from
`docker_for_desktops`, stop that old Compose project once before migrating:
run `docker compose down` from that folder, and do not add `-v`. The integrated
stack reuses its manager state volume and desktop networks.

Stop the stack with `docker compose down`. The manager stops active desktop
containers during shutdown but keeps their data volumes, so existing chat
desktops can be resumed when the stack starts again. Deleting a chat removes
its desktop data.

OpenCode chat desktops are enabled automatically in this Compose setup. Before
using them, configure and sign in to OpenCode in the main desktop template.
Optional manager and repository settings are documented in `.env.example`.

On the first run OpenKarandash creates a `.env` at the project root with port 3001:

```
Created .env with port 3001 — edit the port and secrets there
```

## Your own port and secrets

`.env` is the only place where the port and any secrets live. The file is not tracked by git.

```
PORT=8123

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

The page reloads **once per commit**. The server watches the commit of the main working copy, not the files: commit something and the open tab picks it up by itself. Save a file and nothing happens — code that is not committed yet never reaches the interface.

How it works: a small script is mixed into the served HTML on the fly and keeps an SSE connection to `/__reload`. The commit the page was loaded with sits in `data-head` on `<html>`, and the server sends its current commit with every event, so the tab reloads only when the two differ. The project files themselves are not modified.

Consequences worth knowing:

- A **server restart does not reload the page**. It changes no code, so the tab stays as it is. If you edited a server file and its contract changed, refresh by hand until you commit.
- A tab opened after the commit does not reload pointlessly — its own commit already matches.
- While a request to Claude is in flight, the reload is deferred: the page does the same through `window.__holdReload`. Claude from the chat edits project files and `server.js` included, and reloading the tab would break reading the stream.

If the tab was closed or refreshed by hand mid-work anyway, the CLI does not stop: the request is carried to completion, and the question, the steps and the answer go into the database.

More than that, the refreshed page **reattaches to the work in progress**: `/api/sessions` marks such sessions with a `running` field, and `POST /api/sessions/attach` with a session id returns the stream of its remaining events — the same ones `/api/claude/ask` sends. The feed keeps filling live from where you left it. If the session has already finished, the answer comes back as ordinary JSON (`{"ok":true,"running":false}`) and the page simply shows the conversation from the database.

Edits to the server's own files are applied without a manual restart: the server runs in a child process, the parent (`SYSTEM/core/watchdog.js`) watches `server.js`, `SYSTEM/core/*`, `SYSTEM/cli/*` and every `*-server.js` and brings the child back up. It waits for the current turns to finish first — the child tells the parent it is busy over IPC. In the console it looks like this:

```
server file changed — restarting as soon as the current turns finish...
Server started: http://localhost:3001
```

To disable the commit watcher (then the page refreshes only by hand, while the restart stays automatic):

```powershell
$env:NO_RELOAD=1
docker compose up -d --build
```

## If the page does not refresh by itself

- Check that the commit actually happened **in the main working copy** — a commit in an executor's worktree (`/branch/<name>/` preview) is a different working copy, and the tab reads the main one.
- The address bar must show `http://localhost:...`, not `file:///C:/...`. When a file is opened by double-clicking, the server is not involved.
- Do not keep many tabs with the same page open: each one holds a persistent connection, and the browser allows no more than six per host — the seventh tab simply will not load.

## OpenCode desktops

In the Compose deployment, choose OpenCode in Settings. Detection, model
discovery, and chat turns run inside the Linux desktop assigned to that chat.
Other providers are not installed by this stack; they require a separate
runtime configuration.

Endpoints (all `POST`, local requests only):

| Path | Purpose |
| --- | --- |
| `/api/claude/detect` | looks for the CLI in every environment, returns the ones found |
| `/api/claude/connect` | fixes the chosen environment |
| `/api/claude/ask` | sends a request to the CLI and streams the work |

Requests to the CLI run in parallel: each one starts right away, without waiting for the ones already going (`activeRuns` in `SYSTEM/core/runs.js` keeps the registry). The server does not arbitrate two agents writing the same file at once, so nothing here needs file locks or a PreToolUse hook.

The syntax side is covered by the machine check instead (`npm run check`, `eslint` + `node --check` on every changed file): the server already rejects an unparsable edit during its self-restart (it keeps the previous version running) but only writes about it to its own console, so a session must learn about a broken file from a check that runs before the commit, not from a hook.

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

Storage is SQLite in the file `DATA/.sessions.db` (the `node:sqlite` module, no dependencies). Writing to the database never reloads the page: the page follows commits, not file writes.

Where the sessions come from: the server writes every exchange that went through `/api/claude/ask` into the database — the question, the answer and the `session_id` the CLI returned. The server does not read the Claude CLI's own history (`~/.claude/projects/*/*.jsonl`), so interactive sessions launched in a terminal in the same directory do not appear in the list.

To clear the list:

```bash
curl -s -X POST http://localhost:3001/api/sessions/reset
```

The database is cleared; the Claude CLI's own history files are left alone.

## Knowledge map (Obsidian)

The **Graph** tab shows the project map. There is nothing to configure: on startup the server creates `vault/` at the root and fills it with notes, so the tab opens ready to use.

**What becomes a node.** A project file, a section inside a large file (by the `// ---------- … ----------` separator comments), a top-level function, an API route and a past Claude session.

The map includes **everything that physically sits in the project folder** — including hidden files and things git ignores: `.env`, `.mcp.json`. There are exactly two exceptions, both unavoidable: `.git` (an internal database of thousands of objects, in which the project's contents are duplicated) and `DATA/` — everything the server produced itself: the vault is already present in the graph as nodes, and walking it again would breed notes about notes with every rebuild.

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

A different vault can be configured with `OBSIDIAN_VAULT` in `.env`.

## Stopping

Use `docker compose down` to stop both the app and the desktop manager.

## Structure

| Path | Purpose |
| --- | --- |
| `server.js` | A thin entry point: `.env`, module wiring, route table, `listen`. Everything with a topic of its own lives in a module: `SYSTEM/core/` is the shared plumbing (`env`, `watchdog`, `server-lock`, `watch`, `version`, `http-server`, `api`, `runs`, `run-turn`, `handoff`, `session-list`, `sessions-routes`, `agent-routes`, `sessions-db`), `SYSTEM/cli/` is the agent layer (connectors, process spawn, the turn itself, memory of what broke, turns started outside the browser) |
| `SYSTEM/` | The client shell: `index.html`, `app.js`, `tabs.js`, the toolbar and panel scripts, `core/` (server plumbing), `cli/` (CLI connectors), `styles/`, `assets/` |
| `PROJECTS/<Section>/*.eta` | Templates for the server fragments that htmx pulls in — next to the feature that renders them |
| `PROJECTS/<Section>/` | One folder per interface section — client, styles, the server half and its own README. A page created by the toolbar's «+» button is one of these too: its `page.js` *is* the page |
| `DOCS/decisions/` | Why something in the project is done the way it is; a new decision goes here when the "why" is not visible from the code |
| `AGENTS.md` | The project rules for the agent that works in this repo — pi, the only one left (`DOCS/decisions/078`, `094`) |
| `TOOLS/` | Helper scripts that belong to no section: the live-verification scenarios and the script that counts the next version and decision number |
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

`npm run check` — five stages: keys in the git index, unknown names (`eslint`), cycles (`madge`), file
size, and screen units. Whether a feature actually works is checked by hand in the browser, on the
server the user starts themselves; the client-side checklist is in `PLAN.md`. The smoke test was
removed (`DOCS/decisions/025`): keeping it in step with the routes cost more than it caught.

**Keys in the index** runs first (`SYSTEM/secrets-scan.js`, `DOCS/decisions/112`) — a key that reached
git is the most expensive find there is, since removing the file later does not revoke it. It reads
exactly the set a commit would take (`git ls-files --cached --others --exclude-standard`), so `.env`
and `DATA/` are never opened. Two levels: a match with no innocent twin (private key block, `AKIA…`,
provider tokens) fails the check; a value assigned to a variable with a secret-looking name is only
printed for you to look at, because that form exists in docs and examples too. Matched values are
never printed — the report of a find is itself the leak. It also runs standalone:

```bash
node SYSTEM/secrets-scan.js [--root <folder>]
```
