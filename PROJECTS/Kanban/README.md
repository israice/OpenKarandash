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
3. registers this repository in it via its `POST /api/projects` and remembers the project id,
   so the frame opens straight at the board of this project (`/project?id=<id>` — its page
   reads the id from the query string, there is no `/project/<id>` path) instead of the
   project list, where the user would have to click the project card first. Running again
   does not duplicate the entry;
4. lets the binary outlive our own restarts: it is spawned `detached` and is not killed
   when we exit. Killing it used to cost more than it fixed — live reload restarts our
   server on every edit of a server file, and each restart killed the board and spawned a
   separate new process, twenty seconds of startup and a lost place in the board's own UI.

Nothing ever opens a browser tab. The package can (`bead-kanban` → `openBrowser` in
`bin/cli.js`), but we do not call that command — we run the `beads-server` binary itself,
and it has no browser-launching code at all. `localhost:3008` never reaches the browser
either: the frame points at our own port, and 3008 is only the internal channel between
our server and the binary.

Restoring the tab is not the same as choosing it. After `node server.js` live reload
reloads any open page and `tabs.js` returns to the last view; if that was Kanban, the tab
used to ask for the status by itself and the server started a third-party process — which
looked exactly like "starting the server opens beads-web". So `showView(name, restored)`
passes that apart: a restored tab asks for the status with `probe: true` — a question, not
a request. The server only checks whether anything answers on `BEADS_PORT` and starts
nothing: if the board is alive (the usual case — it survives our restarts) the frame comes
straight back, and if it is not, the tab shows an **Открыть доску** button and lets the
person decide. Clicking Kanban in the toolbar, or that button, starts it right away.

`BEADS_PORT=0` turns the whole thing off — handy for a headless run that must not start a
stray process or fight the working copy for the port.

| Route | What it does |
|---|---|
| `/api/kanban/status` | `{ ok, url }` — the address of the board (`/kanban-ui/`), or `{ ok: false, error }` with the reason it is not there. Body `{ probe: true }` asks without starting anything |

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
`/project?id=<id>`; such paths cannot be listed in advance, so they are picked up by a residual
rule — a GET for an extensionless path we do not have on disk.

The root `/` is a case of its own: its **Back to projects** button points there, and that is
our page's address. The link cannot be changed — the board is built without a `basePath` and
writes every address from the root — so the root is split by who is asking rather than by the
path (`ownsRoot`): a Next client navigation carries the `RSC` header, a reload of the frame
itself carries `Sec-Fetch-Dest: iframe`, and a person opening our page carries neither and
still gets `index.html`. Without this the button loaded our own interface into the frame.

Both previous contracts are intact: `/no-such-file.txt` is still 404, and
`POST /api/no-such-route` is still 404. With `BEADS_PORT=0` nothing is proxied at all.

## 🖼️ Why a frame

beads-web does not arrive as a chunk of markup — it is a whole Next.js App Router document
that calls `hydrateRoot(document, …)`, taking over the entire document when it comes alive.
Putting its markup inside one of our `<div>`s gives either a dead picture with no working
clicks, or its React taking over our whole page. So the tab hands it a frame at full height,
with no padding of ours. The reasoning in full — `DOCS/decisions/021`.

The frame is created on the first visit to the tab (`MissionKanban.show()`, called from
`tabs.js` the same way Book is) and is not reloaded on later visits.

### What is removed from inside it

The project list greets you with an `<h1>` — *Manage Your Beads Projects*. The tab is
already labelled Kanban and the list is only reached through **Back to projects**, so the
heading is gone. It takes two steps, and the first one is the one that matters.

It cannot be removed at the source: the board's markup is baked into the binary. Nor can it
be cut out of the proxied HTML — React compares the document with its own tree while
hydrating and would put the heading straight back; an injected `<style>` in `<head>` is
unreliable for the same reason. And the heading arrives already rendered by the board's
server, so anything that runs inside the frame runs too late: it can only touch the document
after hydration, and the person watches the heading appear and vanish.

So the rule lives in the board's own stylesheet. `kanban-server.js` appends
`main>h1.font-heading{display:none}` to every `/_next/static/css/*.css` it proxies
(`EXTRA_CSS`): React never looks inside a CSS file, and a stylesheet blocks the first paint,
so the heading is not visible for a single frame. `accept-encoding` is dropped for those
requests — a compressed body has nothing to append to — and `content-length` is recomputed;
a compressed answer passes through untouched.

Freshness for those files is ours, not the board's. Next marks its static assets
`immutable` for a year and the file name is hashed from *its* content, which does not change
when `EXTRA_CSS` does — so with the upstream headers a browser that has the stylesheet would
never ask for it again, and a new rule would reach nobody. The proxy therefore strips
`if-none-match`/`if-modified-since` on the way up (no 304 to worry about) and replaces
`cache-control` with `no-cache`, dropping `etag` and `last-modified` — they describe the
board's body, not the one we send.

The second step is `kanban.js`: on the frame's `load` event it removes the node itself
(`BOARD_INTRO`), which is possible only after `hydrateRoot(document)` has run.
A Next client navigation fires no `load`, so there the node stays in the document — hidden
by the same rule.

The line right under that heading — someone else's recommendation to use the *Beads
Orchestration Skill*, with a link out to GitHub — is gone in exactly the same two steps: it
has nothing to do with the work done here. `EXTRA_CSS` carries
`main>p.text-center.text-zinc-400{display:none}` and `BOARD_INTRO` removes the node after
`load`. There is nothing but utility classes to hold on to here — the paragraph has no role
and no label — so the selector leans on its position (the only direct `<p>` of the project
list) and its text colour.

The board's quick-filter bar above the columns (search, type, statuses, *Today*, Memory,
Agents) is dropped the same way — `EXTRA_CSS` also carries
`[role="toolbar"][aria-label="Quick filters"]{display:none}`. Unlike the heading it is only
hidden, never removed from the document: the bar is a live part of the React tree and its
parent re-renders on every board update, so a hand-removed node would come back. The rule
holds on to the role and the label rather than the utility classes — class lists follow the
layout, the accessibility pair does not.

The board's own floating *Start feedback mode* button goes the same way: commenting on the
interface is Karandash's job here, and a second pencil on top of the board only gets in the
way. `EXTRA_CSS` carries
`[class*="toolbarContainer"],[title="Start feedback mode"]{display:none!important}` — it is
hidden, not removed, for the same React reason. Its class is hashed by a CSS module inside
the binary and will change when the package is updated, so the rule matches the stable part
of the name and keeps the collapsed state's `title` as a fallback. `!important` is required:
the button's own rule lives in a different stylesheet, and which one comes last is not up to
us.

One rule in `EXTRA_CSS` is not enough for it, though: the browser keeps the board's
stylesheet in its cache and gets a `304` on reload — an answer with nothing appended to it.
So `kanban.js` puts the same rule into a `<style>` of its own inside the frame's document on
`load` (`hideFeedbackButton`), where the cache plays no part.

The project list's **Search projects** field goes too — the board is registered with exactly
one project, this repository, so there is nothing to search through. `EXTRA_CSS` carries
`:has(>input[aria-label="Search projects"]){display:none}`: the rule hides the wrapper, not
the `<input>` itself, because the magnifier icon sits beside the field in the same container
and would otherwise stay hanging there alone. Hidden, not removed — the field's value is
React state and its parent re-renders on the tag filters. The hook is the `aria-label`, not
the utility classes.

The strip at the bottom of the board with links to other people's repositories (*Beads
Kanban UI*, *Beads CLI*) is gone as well: it has nothing to do with the work done here and
only eats room at the foot of the tab. `EXTRA_CSS` carries `footer.mt-auto{display:none}` —
hidden, not removed, for the same React reason as the rest. The strip has neither a role nor
a label, so the hook is the `footer` tag itself plus its `mt-auto`: a tag with a class
outweighs Tailwind's single-class utilities.

The bar at the top of the project list — a sticky strip holding a single *Settings* gear —
is dropped as well: the board's own settings (tags, PR options) are none of our business, and
the strip only takes the top of the frame. `EXTRA_CSS` carries
`nav:has(>div>a[aria-label="Settings"]){display:none}`: the whole `nav` goes, not the
container inside it, because the strip has a background and a bottom border of its own and
would otherwise stay as an empty line. Hidden, not removed, for the same React reason as the
rest. The hook is the label of the link inside it, not the strip's utility classes.

The row of board sections (*All*, *Epics*, *Tasks*, *Today*, *Memory*, *Agents*) keeps its
padding to itself: its wrapper arrives with `px-4 pb-3`, and those bottom twelve pixels push
the board away from its own tabs for no reason. `EXTRA_CSS` carries
`div.flex.justify-center.px-4.pb-3{padding:0}`. Here there is nothing but utility classes to
hold on to — no role, no label — so the selector uses four of them at once: that outweighs
Tailwind's single-class utilities, and our rules are appended after theirs, so no
`!important` is needed.

The first column is called *New* here, not *Open*. The word is baked into the binary, and
rewriting the text node by hand is pointless — the column heading is a live part of the React
tree, so the next repaint would bring the old word back. So the label is not replaced but
re-drawn: `::after` paints our word and the original is killed with a zero font size, leaving
the node itself untouched, which is all React looks at. `EXTRA_CSS` carries
`h2.font-semibold.text-sm.text-blue-400{font-size:0;line-height:1.25rem}` plus the matching
`::after{content:"New";font-size:0.875rem}` — the line height is spelled out because a zero
font size would collapse the line box and pull the column up. There is no role and no label
to hold on to, only utility classes; `text-blue-400` is what tells this column from its
neighbours. Like the feedback button, the rule also lives in `FRAME_CSS` (`kanban.js`),
because a cached stylesheet answers `304` and comes back without our appendix.

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
| `PROJECTS/Kanban/kanban.js` | Creates the frame with beads-web on the first visit, hides its project-list heading, publishes `window.MissionKanban` |
| `PROJECTS/Kanban/kanban-server.js` | Starts, reuses, registers and kills the beads-web binary; `/api/kanban/status`; appends the heading-hiding rule to its stylesheets |
| `PROJECTS/Kanban/kanban.css` | The frame at full height and the "not available" note |
| `PROJECTS/Karandash/karandash.css` | Makes iframes transparent to the pointer while the pencil is on |
| `PROJECTS/Karandash/karandash.js` | Descends into same-origin frames: hit test, outline offset, wheel boundary |
| `SYSTEM/index.html` | The `#kanbanView` / `#board` container, the `kanbanButton` button, loading `kanban.css` and `kanban.js` |
| `SYSTEM/tabs.js` | Switching to the `kanban` view; passes `restored` so a reload does not start the binary |
| `server.js` | `BEADS_PORT` in the `.env` template, the module in `featureRoutes`, and the two proxy hooks in the dispatcher |

---

License — MIT. beads-web is MIT as well.
