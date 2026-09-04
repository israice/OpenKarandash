# 🗂️ Kanban

The tab shows **beads-web** — a ready-made Beads board installed into the project as the
`beads-kanban-ui` npm package. There is no board of our own here any more.

## 🧭 What this is

One of the Mission Control tabs — the `kanbanButton` toolbar button, the `kanbanView` view,
the client in `PROJECTS/Kanban/kanban.js`, the server half in `PROJECTS/Kanban/kanban-server.js`.

Everything you see on the tab is drawn by beads-web: the multi-project dashboard, the board
with `Open → In Progress → In Review → Closed`, epics with progress, the memory panel, the
agent panel and git operations. Our code does two things only: keeps its process alive and
hands the tab the address to look at.

## 📦 What got installed

`beads-kanban-ui@0.4.2` — pinned exactly, the lockfile is committed. The package itself is a
7 KB shim; its `postinstall` downloads a prebuilt Rust binary from GitHub Releases
(`node_modules/beads-kanban-ui/bin/beads-server.exe` on Windows, 8.2 MB) with the Next.js
interface baked in.

After a fresh clone `npm install` brings it back. Its own data lives outside the repository:
the project list in `%APPDATA%/beads/kanban-ui/data/settings.db`, the tasks in `.beads/issues.jsonl`
of whichever project is open.

## ⚙️ Who runs it

Our server does — not the user, and not the package's own `bead-kanban` command.
`kanban-server.js` on startup:

1. starts it **on the first visit to the Kanban tab**, not when the server boots — otherwise
   `node server.js` would always leave a second listening process behind, even in a session
   where the board was never opened. It first probes `BEADS_PORT` (from `.env`, `3008` by
   default): if something already answers `/api/health` there, that instance is reused;
2. otherwise spawns the binary and waits up to 20 seconds for it to answer;
3. registers this repository in it via its `POST /api/projects`, so the board opens on the
   right project. Running again does not duplicate the entry;
4. kills the binary when our server exits — it must not outlive us and hold the port.

Nothing ever opens a browser tab. The package can (`bead-kanban` → `openBrowser` in
`bin/cli.js`), but we do not call that command — we run the `beads-server` binary itself,
and it has no browser-launching code at all. `localhost:3008` never reaches the browser
either: the frame points at our own port, and 3008 is only the internal channel between
our server and the binary.

Restoring the tab is not the same as choosing it. After `node server.js` live reload
reloads any open page and `tabs.js` returns to the last view; if that was Kanban, the tab
used to ask for the status by itself and the server started a third-party process — which
looked exactly like "starting the server opens beads-web". So `showView(name, restored)`
passes that apart: a restored tab shows an **Открыть доску** button and lets the person
decide, while clicking Kanban in the toolbar starts it right away.

`BEADS_PORT=0` turns the whole thing off. That is what the smoke run uses, so a test run
never starts a stray process or fights the working copy for the port.

| Route | What it does |
|---|---|
| `/api/kanban/status` | `{ ok, url }` — the address of the board (`/kanban-ui/`), or `{ ok: false, error }` with the reason it is not there |

Liveness is re-checked on every request: the binary can die after a successful start.

### Served through our port

The frame points at `/kanban-ui/`, not at `localhost:3008` — that is what makes it
same-origin and lets Karandash reach inside. The module tells the dispatcher which addresses
belong to the board, and they are listed explicitly rather than taken as "anything unknown":

- `/kanban-ui` and everything under it — its markup (its own root, internally);
- `/_next/*` — its static assets, a path we do not use;
- `/api/<ns>` for `agents, bd, beads, fs, git, health, memory, projects, project-tags, tags,
  watch` — its API. The list comes from its own bundle and is disjoint from ours.

Its client-side navigation (clicking a project) changes the frame's address to something like
`/project/<id>`; such paths cannot be listed in advance, so they are picked up by a residual
rule — a GET for an extensionless path we do not have on disk. Both previous contracts are
intact and covered by the smoke run: `/no-such-file.txt` is still 404, and
`POST /api/no-such-route` is still 404. With `BEADS_PORT=0` nothing is proxied at all.

## 🖼️ Why a frame

beads-web does not arrive as a chunk of markup — it is a whole Next.js App Router document
that calls `hydrateRoot(document, …)`, taking over the entire document when it comes alive.
Putting its markup inside one of our `<div>`s gives either a dead picture with no working
clicks, or its React taking over our whole page. So the tab hands it a frame at full height,
with no padding of ours. The reasoning in full — `DOCS/decisions/021`.

The frame is created on the first visit to the tab (`MissionKanban.show()`, called from
`tabs.js` the same way Graph and Book are) and is not reloaded on later visits.

## ✏️ Karandash on this tab

The pencil points at beads-web's own elements — its buttons, cards, columns — not at one
big rectangle covering the tab.

Two things had to be true for that. First, a foreign frame keeps mouse events to itself, so
the mode went blind over the whole tab; while Karandash is on, iframes are transparent to the
pointer (`body.karandash-mode iframe { pointer-events: none }`). Second, the board is served
through **our** port at `/kanban-ui/`, so the frame is same-origin and its document can be
read — on a foreign port `contentDocument` is null and there is no way in. `karandash.js`
then hit-tests inside the frame, offsets the outline by the frame's position, and stops the
wheel at the frame document's own `body`.

The comment window names what you picked, e.g.
`«Search projects...» input.flex.h-9 — section Kanban → embedded beads-web`.

One thing stays true: beads-web's interface lives in a prebuilt binary, not in this
repository, so a fix prompted by such a comment lands on our side — the frame, its size, what
surrounds it — not on its sources. Pointing at its elements is how you say *where* the
problem is.

## 🚀 How to use it

| Action | What happens |
|---|---|
| The `Kanban` button in the toolbar | The tab opens; on the first visit the frame with beads-web is created |
| Anything inside the board | Handled by beads-web itself — see its own README in `node_modules/beads-kanban-ui` |
| beads-web is down | Instead of the frame the tab shows the reason (`BEADS_PORT=0`, not installed, no answer on the port) |

To work with tasks the project needs a `.beads/` directory — beads-web reads it through the
Beads CLI format. Without it the board opens empty; that is beads' own business, not ours.

## ⚠️ What to know

`kanban-server.js` is a new file, and the live-reload watchdog builds its list of watched
files **once at startup** (`WATCHED_FILES` in `server.js`). Until the server is restarted by
hand, edits to this file do not reach it — and the symptom is misleading: the route answers,
but with the old code.

## 📁 Files

| File | What it does |
|---|---|
| `PROJECTS/Kanban/kanban.js` | Creates the frame with beads-web on the first visit, publishes `window.MissionKanban` |
| `PROJECTS/Kanban/kanban-server.js` | Starts, reuses, registers and kills the beads-web binary; `/api/kanban/status` |
| `PROJECTS/Kanban/kanban.css` | The frame at full height and the "not available" note |
| `PROJECTS/Karandash/karandash.css` | Makes iframes transparent to the pointer while the pencil is on |
| `PROJECTS/Karandash/karandash.js` | Descends into same-origin frames: hit test, outline offset, wheel boundary |
| `SYSTEM/index.html` | The `#kanbanView` / `#board` container, the `kanbanButton` button, loading `kanban.css` and `kanban.js` |
| `SYSTEM/tabs.js` | Switching to the `kanban` view; passes `restored` so a reload does not start the binary |
| `SYSTEM/smoke.js` | Two checks: the route answers with a reason when off, and the 404 contracts stay intact |
| `server.js` | `BEADS_PORT` in the `.env` template, the module in `featureRoutes`, and the two proxy hooks in the dispatcher |

---

License — MIT. beads-web is MIT as well.
