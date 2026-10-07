# 🕸 Project map

A living map of the project: files, sections, functions, routes and memory of past sessions — built by the server, read by search and by the file editor.

## 🧭 What this is

There used to be a **Graph** tab here — a canvas with a force layout of the whole project. It was removed (`DOCS/decisions/023`): nobody used it, and it cost about 700 lines of client code and styles. Everything the tab was built on stayed, because the rest of the project lives on it.

On startup the server creates an Obsidian vault next to the code (`DATA/vault/`) and fills it with notes — one per file, one per section of a large file, one per top-level function, one per API route, one per past session — and keeps them up to date. From those notes it builds a full-text index and a node/link map.

The links are not invented from matching names. An edge appears only where the code has a real binding: a `/api/...` string literal, a `src`/`href` attribute, a `require`/`import`, a function call inside a file, a `[[…]]` link in a note. Git history forms a separate layer — files that change together from commit to commit.

## 🎯 Who uses it

| Consumer | What it takes |
| --- | --- |
| `node PROJECTS/Graph/search.js "query"` | Full-text search over code, notes and past sessions — the way agents search this repo (`AGENTS.md`) |
| The Book tab | README panel on the right: reading, editing and autosaving a file through `MissionFiles.createFileEditor` |
| The Chat tab | The file panel instead of the message feed, plus `MissionFiles.closeFilePanel` when a session is switched |
| The Flow tab | "Open file" on a document node — `MissionFiles.openFileModal` |
| Agents and sessions | Session memory in `DATA/vault/Sessions/`: what was asked, how it ended, which files were touched |

## ✨ What it gives

- **Project-wide search.** Full-text (FTS5 with BM25 ranking) across code, vault notes and the conversations of past sessions.
- **A file editor.** Text files can be edited and saved with a button, with `Ctrl+S`, or automatically after a pause in typing. For a section node and a function node the text is already scrolled to the right line. Vault notes open read-only — they are rebuilt by the server, and an edit would not survive the next rebuild. Binary files show only their size.
- **A stale marker.** If the files a session touched have changed since, its note is marked `stale`: a past decision should not read as the current one.
- **Updates without a reload.** Commits in the project rebuild the map, and the page is told to fetch it again next time it needs it.

## 🔬 How it works

**Where the nodes come from.** The server walks the entire project folder — including hidden files and things git ignores (`.env`, `.sessions.db`, local settings). There are exactly three exceptions, all unavoidable: `.git`, `node_modules` and `DATA/` — everything the server produced itself, the vault included.

| Kind | What becomes a node |
| --- | --- |
| `file` | Any file in the project folder |
| `route` | A route declaration in server code — either `urlPath === '/api/…'` or a key of a route table, `'/api/…': handler` |
| `section` | A `// ---------- … ----------` separator comment in a file of 200 lines or more |
| `function` | A top-level function in such a large file |
| `session` | A note about a past session from `vault/Sessions/` |
| `note` | A note written by hand in the vault root |
| `history` | The "files that change together" summary from git history |

A session note is named `<date> <title> <id prefix>`, and the title is the user's first message — unbounded. Both parts are capped (`SESSION_TITLE_LIMIT`, `NOTE_NAME_LIMIT` in `graph-vault.js`): a full path over 260 characters cannot be written on Windows, and the failure arrives as `ENOENT` on open — which reads as "no such directory" and used to take down the whole map rebuild, not just that one note.

**Where the links come from.** Before looking for calls, strings and comments are stripped from the code — a function name mentioned in prose does not count as a call. A function is attached to the section it is declared in, and a section to its file: the result is a tree rather than a flat fan. The "changed together" pairs come from commits where the files met at least twice, and a file edited in more than 60 % of commits is excluded from the pairs so it does not become a false hub.

**Which routes there are.** All `POST`, all local-only:

| Route | Why |
| --- | --- |
| `/api/obsidian/graph` | The vault's nodes and links. The canvas is gone; now the file editor takes them for a node's list of links |
| `/api/search` | Search: `{ q, limit }` → a list of hits with snippets |
| `/api/complexity` | Project complexity report, POST: file sizes over 400 lines, requires per file, folder depth (`DOCS/decisions/111`) |
| `/api/file/read` | A file's contents for the panel: text, size, the `binary` and `editable` flags |
| `/api/file/write` | Saving an edit; vault notes and binary files are rejected |

**How updates arrive.** The server polls the project files every 400 ms. Three seconds after the last edit it rebuilds the vault and the search index (`DATA/.index.db`), then sends the page a `map` SSE event. The page does not refetch on the spot — it just forgets the map it holds and takes a fresh one the next time a file is opened. While an agent's turn is in flight, the rebuild is deferred until it finishes.

## 📁 Files

| File | What it is responsible for |
| --- | --- |
| `PROJECTS/Graph/file-editor.js` | The client: the project map (loading, `nodeByPath`, a node's links) and the file editor — the modal window, the Chat panel and the factory for someone else's panel (`window.MissionFiles`) |
| `PROJECTS/Graph/file-editor.css` | Its styles: the window, the panel in Chat and its markdown mode |
| `PROJECTS/Graph/md-editors.js` | EasyMDE over a panel's `textarea` (`MdEditors.attach`), vendored in `vendor/easymde/` |
| `PROJECTS/Graph/graph-server.js` | The server entry point: `init()` (what the folder needs from outside arrives here once), `prepareVault()` — the one place where the map and the search index are rebuilt together — and the routes (`createRoutes`): `/api/obsidian/graph`, `/api/search`, `/api/file/read`, `/api/file/write`, `/api/complexity`. Nothing else lives here: the work is split by topic into the three files below |
| `PROJECTS/Graph/graph-vault.js` | Building the vault: walking the project folder, parsing code into sections and functions, git history, file/section/route notes, reading the finished vault into a graph (`buildVaultGraph`), session-memory notes. Also owns the state shared by the server half — the project root, the `DATA`/vault paths and the `state` object filled by `init()` — the other two modules and the entry point `require` it, never the other way round |
| `PROJECTS/Graph/graph-search.js` | The FTS5 index in `DATA/.index.db`: full rebuild over code, vault notes and session conversations (`rebuildSearchIndex`) and the ranked query behind `/api/search` (`searchProject`) |
| `PROJECTS/Graph/graph-complexity.js` | The complexity metric: walking the project for file line counts, per-file require counts and folder depth |
| `PROJECTS/Graph/graph-files.js` | Reading and writing a file: the path comes from the client, so it is resolved through real paths and never allowed outside the project root; vault notes and binary files are refused for writing |
| `PROJECTS/Graph/search.js` | The same search from the terminal: `node PROJECTS/Graph/search.js "query"`, reads the prebuilt index |
| `DATA/vault/` | The notes themselves: the map in `Project/`, session memory in `Sessions/`, your own notes alongside (not tracked by git) |

Only the wiring stays outside — the parts that cannot be moved out of the shared files:

| File | What it contains about this folder |
| --- | --- |
| `SYSTEM/index.html` | A `<link>` to `file-editor.css`, a `<script defer>` for `file-editor.js` and the `#fileModal` markup. There is no toolbar button and no view of its own any more |
| `server.js` | Only wires the folder in: `graph.init(...)` at startup and `graph.createRoutes()` in the route table |

The server half knows nothing about the session store: everything external — the session list, their messages, a session's subject and notifying pages about a rebuild — arrives once through `init()` in `graph-server.js`, which puts it into the shared `state` object in `graph-vault.js`; `graph-search.js` and the session notes read it from there. There are no circular `require`s between the four files (`npx madge --circular PROJECTS/Graph/graph-server.js`).

Put your own notes in the vault root: `DATA/vault/Project/` is overwritten in full on every rebuild, while everything else is left alone and shows up both in the map and in the search.

---

MIT license.
