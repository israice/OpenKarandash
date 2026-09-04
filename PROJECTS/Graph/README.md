# 🕸 Graph

A living map of the project: files, sections, functions, routes and memory of past sessions — in one cloud of nodes that builds itself.

## 🧭 What this is

The **Graph** tab is a graph of everything that physically sits in the project folder. There is nothing to configure: on startup the server creates an Obsidian vault next to the code (`DATA/vault/`), fills it with notes — one per file, one per section of a large file, one per top-level function, one per API route — and keeps them up to date. The tab simply fetches the finished map in a single request.

The links here are not invented from matching names. An edge appears only where the code has a real binding: a `/api/...` string literal, a `src`/`href` attribute, a `require`/`import`, a function call inside a file, a `[[…]]` link in a note. Git history forms a separate layer — files that change together from commit to commit.

The graph is not only for looking at. Clicking a node opens the file's contents right in a window — editable and saveable. The search field at the top does a full-text search across code, notes and past sessions, and highlights the hits directly in the node cloud.

## ✨ Features

- **A live layout.** The force simulation runs every frame: nodes push each other apart, links pull them together, and light gravity keeps the cloud centred. The motion decays and stops on its own — no battery burned in the background.
- **Nodes can be dragged.** Grab a node with the mouse and its neighbours follow; let go and the graph settles by itself.
- **Seven node kinds.** Files, API, sections, functions, sessions, notes, history — each with its own colour. The chips on the left turn kinds on and off; functions, sessions and history are off by default, otherwise the picture becomes unreadable.
- **Neighbourhood highlighting.** Hovering brings a node and its links to the front and dims the rest. The circle grows with the number of links — hubs are visible at a glance.
- **Project-wide search.** Full-text (FTS5 with BM25 ranking) across code, vault notes and the conversations of past sessions. Matching nodes pulse, and the hint shows how many were found in total and how many of those are visible in the graph.
- **The links panel.** The selected node expands to the side: kind, file and line, date, and the list of neighbours — any of which can be opened with one click.
- **An editor in the window.** Text files can be edited and saved with a button or `Ctrl+S`. For a section node and a function node the text is already scrolled to the right line. Vault notes open read-only — they are rebuilt by the server, and an edit would not survive the next rebuild. Binary files show only their size.
- **A stale marker.** If the files a session touched have changed since, its note is marked `stale` and drawn dimmed: a past decision should not read as the current one.
- **Updates without a reload.** Edits in the project rebuild the map, and an open tab redraws itself.
- **Respect for accessibility settings.** With the system "reduce motion" setting, the appearance animation, transitions and pulsing are turned off.

## 🎛 Controls

| Action | What happens |
| --- | --- |
| Mouse wheel | Zoom towards the point under the cursor |
| Dragging empty space | Pan the canvas |
| Dragging a node | The node follows the cursor, neighbours are pulled along |
| Hovering a node | The node and its links are highlighted, the rest fades |
| Clicking a node | The links panel on the right plus a window with the contents |
| Clicking a kind chip | Turn that node kind on or off |
| Typing in the search field | After a 200 ms pause — the matches are highlighted in the graph |
| An empty search field | The highlighting is cleared |
| Clicking a link name | Jump to the neighbouring node |
| `Ctrl+S` / `Cmd+S` in the window | Save the edit |
| `×` in the right-hand panel | Close the panel and clear the selection |

Node labels appear as you zoom in: at a wide view they would blur into mush, so at that distance only the labels of the hovered and the selected node are shown.

## 🔬 How it works

**Where the nodes come from.** The server walks the entire project folder — including hidden files and things git ignores (`.env`, `.sessions.db`, local settings). There are exactly three exceptions, all unavoidable: `.git`, `node_modules` and `DATA/` — everything the server produced itself, the vault included.

| Kind | What becomes a node | Visible immediately |
| --- | --- | --- |
| `file` | Any file in the project folder | yes |
| `route` | A `urlPath === '/api/…'` declaration in server code | yes |
| `section` | A `// ---------- … ----------` separator comment in a file of 200 lines or more | yes |
| `function` | A top-level function in such a large file | no |
| `session` | A note about a past session from `vault/Sessions/` | no |

A session note is named `<date> <title> <id prefix>`, and the title is the user's first
message — unbounded. Both parts are capped (`SESSION_TITLE_LIMIT`, `NOTE_NAME_LIMIT` in
`graph-server.js`): a full path over 260 characters cannot be written on Windows, and the
failure arrives as `ENOENT` on open — which reads as "no such directory" and used to take
down the whole map rebuild, not just that one note.
| `note` | A note written by hand in the vault root | yes |
| `history` | The "files that change together" summary from git history | no |

**Where the links come from.** Before looking for calls, strings and comments are stripped from the code — a function name mentioned in prose does not count as a call. A function is attached to the section it is declared in, and a section to its file: the result is a tree rather than a flat fan. The "changed together" pairs come from commits where the files met at least twice, and a file edited in more than 60 % of commits is excluded from the pairs so it does not become a false hub.

**Which routes the tab calls.** All `POST`, all local-only:

| Route | Why |
| --- | --- |
| `/api/obsidian/graph` | The vault's nodes and links — the whole canvas is built from them |
| `/api/search` | Search: `{ q, limit }` → a list of hits with snippets |
| `/api/file/read` | A node's contents for the window: text, size, the `binary` and `editable` flags |
| `/api/file/write` | Saving an edit; vault notes and binary files are rejected |

**Where state is kept.** The set of enabled node kinds survives a reload — it lives in `localStorage` under the key `graph.visibleKinds` (if storage is unavailable, the tab quietly falls back to the defaults). Everything else — the camera position, the node coordinates, the selection — lives only in the page's memory and is recomputed every time the tab is opened: the cloud comes alive from scratch each time.

**How updates arrive.** The server polls the project files every 400 ms. Three seconds after the last edit it rebuilds the vault and the search index (`DATA/.index.db`), then sends the page a `map` SSE event. The tab redraws the graph — but only if it is currently open: there is no point computing a layout for a hidden canvas. While a request to Claude is in flight, the rebuild is deferred until it finishes.

## 📁 Files

| File | What it is responsible for |
| --- | --- |
| `PROJECTS/Graph/graph.js` | The client: layout, simulation, search, links panel, contents window (`window.MissionGraph`) |
| `PROJECTS/Graph/graph.css` | The tab's styles: canvas, kind chips, links panel, the window and the file editing panel |
| `PROJECTS/Graph/graph-server.js` | The server half: building the vault, parsing code into sections and functions, session notes, the search index, reading and writing files — plus the tab's own routes (`createRoutes`): `/api/obsidian/graph`, `/api/search`, `/api/file/read`, `/api/file/write` |
| `PROJECTS/Graph/search.js` | The same search from the terminal: `node PROJECTS/Graph/search.js "query"`, reads the prebuilt index |
| `DATA/vault/` | The notes themselves: the map in `Project/`, session memory in `Sessions/`, your own notes alongside (not tracked by git) |

Only the wiring stays outside — the parts that cannot be moved out of the shared files:

| File | What it contains about Graph |
| --- | --- |
| `SYSTEM/index.html` | A `<link>` to `graph.css`, a `<script defer>` for `graph.js`, the `#graphView` markup and the `graphButton` toolbar button |
| `server.js` | Only wires the folder in: `graph.init(...)` at startup and `graph.createRoutes()` in the route table. None of the tab's routes live there any more |
| `SYSTEM/tabs.js` | `MissionGraph.show()` when switching to the tab |

The `graph-server.js` module knows nothing about the session store: everything external — the session list, their messages, a session's subject and notifying pages about a rebuild — arrives once through `init()`.

Put your own notes in the vault root: `DATA/vault/Project/` is overwritten in full on every rebuild, while everything else is left alone and shows up both in the graph and in the search.

---

MIT license.
