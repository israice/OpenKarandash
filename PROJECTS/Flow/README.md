# 🌊 Flow

**An infinite canvas where a task turns into a diagram: nodes, arrows, zoom — and not a single dependency.**

## 🧭 What this is

Flow is the Mission Control tab where the project is seen as a graph rather than a list. It opens with the `flowButton` toolbar button, lives in the `#flowView` block, and all of its code fits in one file, `PROJECTS/Flow/flow.js`, which publishes `window.MissionFlow`.

In spirit it is an n8n-style editor: a dark dotted canvas, node cards with rounded corners, blue Bézier arcs with arrowheads. There are two starting nodes — **New** (the entry point: project name and opening date) and **Secretary** (a dispatcher agent with a provider, model and effort selector). From there you grow the diagram yourself: with the plus buttons on the card edges, by inserting nodes right into the middle of an edge, and by dragging arrows from node to node.

All state — node positions, the edge list, the camera position and scale, the selected agent — survives a page reload. It lives on the server, in the `flow_state` key/value table (`PROJECTS/Flow/flow-server.js`, `/api/flow/state`); the old `localStorage` keys are migrated into it once, on first load, and the key names are unchanged.

The tab can also draw a **session** as a graph: the session picker in the toolbar (`#flowSessionSelect`, shown on the `321` entry) feeds the messages of the selected session to `MissionFlow.buildFromSession`, and `PROJECTS/Flow/flow-session-sync.js` keeps that graph live while the session is running. Session nodes are not part of the saved state: they are derived from the messages and rebuilt from them every time — see "Session nodes" below.

## ✨ Features

- **A canvas with zoom and panning.** The mouse wheel zooms towards the point under the cursor (30 %–200 %), dragging the empty background moves the camera, and the 28 px background grid moves and scales along with the nodes.
- **Two plus buttons on every node.** The bottom one creates a child node below, the right one continues the chain to the right. Both are connected with an edge automatically.
- **The plus as a connector.** Dragging that same plus pulls a dashed arrow; the target node under the cursor is highlighted with a green frame, and releasing creates an edge.
- **A plus on an edge.** The circle in the middle of an arc splits it in two and inserts a new node between the neighbours, cascading everything further down the chain out of the way.
- **Selection and deletion.** A click selects a node (blue outline) or an edge (the arrow turns orange), and `Delete` removes the selection together with its links.
- **Auto-layout with one button.** `⤾` does more than reset the zoom: it honestly re-lays the whole graph as a tree — horizontal edges keep a row, vertical ones open a new one, each subtree gets its own non-overlapping column range — and fits the result to the screen.
- **The agent on the Secretary card.** Three selects — provider, model, effort — are filled from `App.PROVIDERS`; effort is hidden for providers that do not support it. The choice is saved.
- **The Flows menu on the left.** It mirrors the board columns from `App.BOARD_COLUMNS` (New, In Progress, Checking, Validator, Done) plus a separate **Temp** category for drafts created with the `+` button. Each entry has its own canvas: its own set of nodes, its own connectivity, its own zoom/pan — switching entries hides the other canvases' nodes and edges and restores the saved view of the current one. Opening the tab restores the entry that was active last time (`New` by default, which is where the starting "Secretary"/"New" pair lives); an empty canvas automatically gets one placeholder node so there is something to grow from.
- **A personal starting node for a profile.** A profile may have its own card instead of the shared placeholder: `PERSONAL_ROOTS` in `flow.js` maps the menu entry to a template id, and `ensureRootNode` puts that card on the entry's canvas — on switching to it, and on a reload that lands straight on it. Its id is fixed, so the graph restored after a reload picks the same template rather than the generic one. `Delete` does not remove such a node: it is the canvas's entry point. A shared placeholder left over from the time before the personal node existed is dropped the first time that canvas is opened, so it does not end up with two entry points. It is recognised by having no links at all — not by its title, which is only set when the placeholder is created and is never saved. The cleanup runs once per canvas; the list of canvases already cleaned lives in the state under `flowPersonalRootsMigrated`. Today only **QA** has one (`#flowNodeQaTemplate` in `SYSTEM/index.html`, `.flow-node--qa` in `flow.css`) and it carries no logic yet — just the card, laid out in two columns: on the left a vertical menu of icon+label buttons stacked in a column (`.flow-node__menu`) — it is taken out of the flow so that its buttons do not stretch the card: the card's height comes from the right column, and the buttons that do not fit are reached by scrolling the menu itself (the canvas `wheel` handler lets the wheel scroll it instead of zooming, the same way it does inside an expanded section's text; the scrollbar itself is hidden). The column's width is not a number in the CSS: `fitNodeMenu` in `flow.js` measures the menu's `max-content` width once, when the card first appears on screen, and puts it into the `--flow-node-menu` variable on the card — both the column and the space reserved for it are counted from it, so a longer button label widens the column by itself, on the right (`.flow-node__main`) a header, the text itself, and the same provider/model/effort row as every other node (`.flow-node__footer--controls`, filled by `populateNodeAgentSelects`). Because of the second column the card is wider than a regular node. The first menu item, **🔌MCP**, is wired: it swaps the right column for a panel with the MCP servers a tester usually needs (`QA_MCPS` in `flow.js`, rendered into `.flow-node__panel--mcp`), a search box above the list and a Connect/Disconnect button next to each server; clicking the item again brings the card back. The list scrolls with its scrollbar hidden, like the menu on the left, and the same `wheel` handler keeps the canvas from zooming over it. Connections are shared by every QA card and stored in the flow state under `flowQaMcp`; until the first click the connected one is **Playwright** — the only server really written into the profile's `mcp.json`. No server is actually started behind the button yet. The third item, **🫀Soul**, is wired the same way: it swaps the right column for the fields that describe who this agent is — who am I, personality, values and interaction style (`QA_SOUL` in `flow.js`, rendered into `.flow-node__panel--soul`). The text is shared by every QA card and stored in the flow state under `flowQaSoul`; nothing sends it to a CLI yet — so far it is a description for the human. The second item, **📜System Prompt**, is the same panel with another set of fields — how should I behave, rules, principles and output format (`QA_PROMPT` in `flow.js`, rendered into `.flow-node__panel--prompt`); The fourth item, **🧠Thinking**, is the same panel again — how deep do I think, thinking budget, when to think longer and visible reasoning (`QA_THINKING` in `flow.js`, rendered into `.flow-node__panel--thinking`), stored under `flowQaThinking` (the effort select in the card's footer is not wired to it). The **🧰Tools** item is the same panel once more — what can I do, connected tools, how I choose and what I lack (`QA_TOOLS` in `flow.js`, rendered into `.flow-node__panel--tools`), stored under `flowQaTools`; unlike the **MCP** panel it is a description in words, not a list of servers with a Connect button. All these panels are drawn by one `renderFieldPanel`, differing only in the fields, the state key and the class prefix; every field carries a ready description of the QA worker (`value` next to the field's `label`/`hint`), shown until someone edits that field — a field emptied by hand stays empty and does not get the default back, and the prompt text lives under `flowQaPrompt`, likewise unused by any CLI so far. The same panel again serves four more items: **🤖Model** — what do I think with, provider, why this one and a fallback (`QA_MODEL`, `.flow-node__panel--model`, stored under `flowQaModel`; its class prefix inside is `llm`, because `.flow-node__model` is already the model select in the footer), **🎓Skills** (`QA_SKILLS`, `flowQaSkills`), **👥Agents** (`QA_AGENTS`, `flowQaAgents`) and **💾Memory** (`QA_MEMORY`, `flowQaMemory`) — the last three have no file in the profile behind them yet, so their titles carry no file icon. Menu items are wired by their `data-panel` attribute, so a further panel is a matter of markup; every item in the menu today has one — there are no decorative buttons left. The buttons can also be reordered: holding any of them for two seconds turns the menu into the same "shake" mode the toolbar buttons use (`SYSTEM/toolbar-reorder.js`), where a button is dragged to its new place and `Esc` leaves the mode. The order is shared by every card with such a menu and is saved in the flow state under `flowQaMenuOrder`, keyed by the button labels, so a button added to the template later is not lost — it simply stays above the saved ones. Since `flow-minion.js` the header also carries a slowly spinning 3D character (`.flow-node__minion`, a 56×72 canvas) first in the row, to the left of the title.

## 🎮 Controls

| Action | How |
|---|---|
| Zoom in / out | The mouse wheel over the canvas, or the `+` / `−` buttons in the bottom right corner |
| Pan | Drag the empty background (the cursor turns into a hand) |
| Auto-layout + fit to screen | The `⤾` button |
| Add a node below / to the right | Click the plus on the node's bottom or right edge |
| Connect two nodes | Hold a plus and drag the arrow to the target node |
| Insert a node into a link | Click the plus in the middle of an arc |
| Select | Click a card or an arrow line |
| Delete a node or link | `Delete` (does not work while the focus is in an input or a select) |
| Reorder the QA menu buttons | Hold a button of the vertical menu for 2 s — the menu starts shaking — then drag the button into place; `Esc` leaves the mode |
| Current scale | The number between `−` and `+` in the zoom panel |

The **New** and **Secretary** nodes cannot be deleted — canvas centring depends on them.

## ⚙️ How it works

The canvas is an ordinary `div` with `transform: translate(x, y) scale(s)`; the grid is drawn as the container's `radial-gradient` background and is synchronised with the camera through `background-position` / `background-size`. Nodes are positioned absolutely inside the 6000 × 6000 px `#flowSurface` layer, and edges are drawn in the `#flowEdges` SVG layer as cubic Bézier curves with a shared arrow marker.

The side an arc attaches to is fixed by the type of plus that created the edge (horizontal — right/left, vertical — bottom/top), so dragging a node does not make the arrow "jump" to another face. The insert button is placed on the curve at `t = 0.5`.

Auto-layout runs the two passes of the classic tree algorithm: `measure` computes the width of each subtree in columns bottom-up, `place` hands out absolute columns top-down. Nodes with no path from the starting node are laid out as separate trees in rows below.

Centring is deferred: while the tab is hidden the canvas dimensions are zero, so on the first show `tabs.js` calls `MissionFlow.center()` — which places the starting nodes, restores the saved graph and draws the edges exactly once.

### Session nodes

A node built from a session message gets a deterministic id, `flowNode_<sessionId>_<position>`, and carries `data-session` with that session's id. What follows from that:

- **Rebuilds are incremental.** `buildSessionFlow` matches the messages against the nodes already on the canvas: missing ones are created, existing ones are updated in place, and nodes whose message is gone are removed. An open accordion, the selection and anything you inserted by hand all survive the live rebuild that runs once a second while the session is working.
- **The canvas holds the session and nothing else.** Switching to an empty entry normally leaves one placeholder node behind ("so there is something to grow from"); when a session is drawn there, every blank placeholder is removed — one with no text, no questions, no type and no edge at all. Anything you typed into a node, or tied to another node, keeps it out of that category and is never removed.
- **Opening the entry draws the session.** Switching to the menu entry that shows the session picker rebuilds the graph right then, not only once per page load. A rebuild that was already in flight is dropped if you moved to another entry meanwhile — otherwise it would pull its own canvas back on top of the one you just opened.
- **Session nodes are never saved.** Neither their text, nor their position, nor their edges go into `flow_state`: all of it is derived from the messages. Storing it would keep a second copy of the whole conversation — and on a long session that copy outgrew the 100 KB request-body limit of `readJson` (`SYSTEM/core/http.js`), which silently killed the whole state write.
- **Files are nodes of their own.** A step that names a `file_path` gets an edge to a node for that file — one node per path for the whole session, so five reads of `app.js` are five edges into the same node. Its "Open file" button opens the file in the shared editor window (`MissionFiles.openFileModal`), where it can be edited and saved.
- **The look says what happened.** Role plus tool name pick the emoji, the card colour (`.flow-node--kind-*`) and the title; a step that failed (`toolError`) gets a red border. The body holds a preview, and three native `<details>` sections hold the whole thing: `Input` (`toolInput`, or what was actually sent for a user message), `What happened` (`text`) and `Output` (`toolResult`). A step that ran inside a subagent hangs under the node of the `Task` call it belongs to (`parentToolUseId`), not in the main chain.
- **Your own words are editable.** The `What happened` section of a user message is edited in place, and the text goes into the session itself (`POST /api/sessions/message/set`). Only the `user` role can be changed — everything else is a record of what the model and the tools actually did, and the server refuses to rewrite it. See `DOCS/decisions/018`.
- **Nodes you add survive.** A node inserted into the chain by hand keeps its place across the live rebuild and across a reload: the edges tying it to a session node are saved (its id is deterministic, so it is the same node after the rebuild) and re-created as soon as the session graph is built again.

Stored state (the same key names now live in `flow_state` on the server):

| Key | What it stores |
|---|---|
| `flowCanvasViews` | The camera position and scale for each menu entry (`{ [flow]: {x, y, scale} }`) |
| `flowNodePositions2` | The `left` / `top` of every node (by id) — session nodes excluded |
| `flowNodeGraph3` | The edge list (id + direction), which canvas each node belongs to (`flow`) and the new-node counter |
| `flowNodeText` | The title and body you typed into a node |
| `flowNodeQuestions` | The question fields under a node's body |
| `flowNodeTypes` | The type picked in a node's select — this is what makes the `Ask Human` gate a real property of the node |
| `flowActiveFlow` | The menu entry that was open last |
| `flowNodeSecretaryAgent` | The provider, model and effort of the Secretary card |
| `flowQaMcp` | The MCP servers marked connected in the QA card's **MCP** panel — one list shared by every QA card. The real file behind it is `PROJECTS/Flow/profiles/QA/mcp.json` (see the file icon below) |
| `flowQaSoul` | The text of the QA card's **Soul** panel fields — one soul shared by every QA card. The real file behind it is `PROJECTS/Flow/profiles/QA/APPEND_SYSTEM.md` |
| `flowQaPrompt` | The text of the QA card's **System Prompt** panel fields — one prompt shared by every QA card. The real file behind it is `PROJECTS/Flow/profiles/QA/SYSTEM.md` |
| `flowQaThinking` | The text of the QA card's **Thinking** panel fields — one reasoning setup shared by every QA card. The real file behind it is `defaultThinkingLevel` in `PROJECTS/Flow/profiles/QA/settings.json` |
| `flowQaPermissions` | The text of the QA card's **Permissions** panel fields, named the way pi states limits — one set shared by every QA card. The real files behind it are `defaultTools`/`defaultProjectTrust` in `PROJECTS/Flow/profiles/QA/settings.json` and `PROJECTS/Flow/profiles/QA/extensions/permission-gate.ts` |
| `flowQaTools` | The text of the QA card's **Tools** panel fields — one toolkit shared by every QA card. The real file behind it is `defaultTools` in `PROJECTS/Flow/profiles/QA/settings.json` |
| `flowQaModel` | The text of the QA card's **Model** panel fields — one model choice shared by every QA card. The real files behind it are `defaultProvider`/`defaultModel` in `PROJECTS/Flow/profiles/QA/settings.json`; the provider/model selects in the card's footer are a separate control and are not wired to it |
| `flowQaSkills` | The text of the QA card's **Skills** panel fields — one set shared by every QA card. No file in the profile backs it yet: pi loads skills from the project's `.agents/skills` |
| `flowQaAgents` | The text of the QA card's **Agents** panel fields — who this worker may call in. No file behind it yet |
| `flowQaMemory` | The text of the QA card's **Memory** panel fields — what it keeps between sessions. No file behind it yet; the project's own memory lives in `DATA/vault` |
| `flowQaMenuOrder` | The order of the vertical menu's buttons (by label) — one order shared by every card with such a menu |
| `flowBackendMcp` | The MCP servers marked connected in the Backend developer card's **MCP** panel — its own list, separate from `flowQaMcp`. The real file behind it is `PROJECTS/Flow/profiles/Backend developer/config.yaml` → `mcp.servers` |
| `flowBackendSoul` | The text of the Backend developer card's **Soul** panel fields. The real file behind it is `PROJECTS/Flow/profiles/Backend developer/PERSONA.md` (stands in for `SOUL.md`, a filename Hermes blocks this agent from writing — see the profile's own `README.md`) |
| `flowBackendPrompt` | The text of the Backend developer card's **System Prompt** panel fields. Same real file as **Soul** above: `PERSONA.md` — Hermes has no split between a replacing and an appended system file the way pi does |
| `flowBackendThinking` | The text of the Backend developer card's **Thinking** panel fields. No file behind it: Hermes' `config.yaml` has no direct field for reasoning depth, the closest is `model`/`agent` |
| `flowBackendPermissions` | The text of the Backend developer card's **Permissions** panel fields, named the way Hermes states them (`approvals`, `security`) rather than pi's tool-allowlist language. The real file behind it is `PROJECTS/Flow/profiles/Backend developer/config.yaml` → `approvals`/`security` |
| `flowBackendTools` | The text of the Backend developer card's **Tools** panel fields. The real file behind it is `PROJECTS/Flow/profiles/Backend developer/config.yaml` → `toolsets` |
| `flowBackendModel` | The text of the Backend developer card's **Model** panel fields. The real file behind it is `PROJECTS/Flow/profiles/Backend developer/config.yaml` → `model` |
| `flowBackendSkills` | The text of the Backend developer card's **Skills** panel fields — its own set, separate from `flowQaSkills`. No file in the profile backs it yet: `skills/` is a placeholder folder |
| `flowBackendAgents` | The text of the Backend developer card's **Agents** panel fields. The real file behind it is `PROJECTS/Flow/profiles/Backend developer/config.yaml` → `delegation` |
| `flowBackendMemory` | The text of the Backend developer card's **Memory** panel fields. The real file behind it is `PROJECTS/Flow/profiles/Backend developer/config.yaml` → `memory`; `memories/` is a placeholder folder for the actual data |

Every panel of the QA card that has a file behind it carries a file icon right of its title: it opens the file pi actually reads for that panel — the QA worker profile in `PROJECTS/Flow/profiles/QA/` (`mcp.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `settings.json`, `extensions/permission-gate.ts`) — in the shared editor window (`MissionFiles.openFileModal`). That folder is a real pi agent directory (`PI_CODING_AGENT_DIR`), one per worker; see `PROJECTS/Flow/profiles/QA/README.md` and `DOCS/decisions/028`. The path lives in the button's `data-file` in `SYSTEM/index.html`, so a new panel needs its own button and nothing in `flow.js`. The **Skills**, **Agents** and **Memory** panels have no such file yet, so their titles carry no icon.

The Backend developer card (`#flowNodeBackendTemplate`) works the same way but its profile is a real Hermes profile directory instead of a pi one — `PROJECTS/Flow/profiles/Backend developer/` (`config.yaml`, `PERSONA.md`) — because Hermes itself runs in this project (`DOCS/decisions/029`) while pi does not read a Hermes-shaped profile. See `PROJECTS/Flow/profiles/Backend developer/README.md` and `DOCS/decisions/033` for the field-by-field mapping and the design calls (why System Prompt and Soul share one file, why Thinking has no icon, why the file is named `PERSONA.md` and not `SOUL.md`).

Four more cards — **Developer 💻, Docs writer 📝, QA checker 🔬, Reviewer 🔎** — are not invented roles at all: they are the four real profile directories the Hermes stack itself creates and mounts, `hermes-home/profiles/{developer,docs-writer,qa-checker,reviewer}/` (`DOCS/decisions/029`, `DOCS/decisions/036`). They share the plain `#flowNodeProfileTemplate` with Secretary/UI developer/HR rather than getting their own markup, because the four real directories are themselves nearly identical — the same factory `SOUL.md`, the same `config.yaml`, the same bundled `skills/`. Only **System Prompt** shows something profile-specific (the real `description` from that profile's `profile.yaml`, plus how many sessions it has actually run); every other panel (Soul, Thinking, Tools, Permissions, Model, Skills, Agents, Memory) shows the same `HERMES_*` text on all four, because the underlying files really are the same — inventing per-role differences that are not in the files would be dishonest. Each panel's 📄 icon opens the real file at its real path under `hermes-home/profiles/<name>/` (`FILE_BY_ROOT`/`applyPanelFiles` in `flow.js`), not a stand-in under `PROJECTS/Flow/profiles/`. Their MCP panel is empty on purpose — nothing is configured in the real `config.yaml`. See `DOCS/decisions/036` for the full reasoning.

## 🚧 What works / what is planned

**Works:** the canvas, zoom and panning, creating nodes and links, inserting into a split edge, selection and deletion, auto-layout, persisting all state between sessions, and drawing a session as a live graph of rich nodes.

**Planned:**

- **Executing the flow.** Flow is a map, not an engine: the only server side it has is `flow_state` (key/value for the canvas). The graph is not sent anywhere and does not run anything, so editing it does not change how future sessions behave.
- **The Secretary.** The card is honestly marked with a "Temporary node" badge: the provider and model selection is saved, but it does not affect real agent work yet. The model lists in `SYSTEM/providers.js` are a stub for real provider data.

## 📁 Files

| File | Role |
|---|---|
| `PROJECTS/Flow/flow.js` | All of the tab's logic: canvas, zoom/pan, nodes, edges, auto-layout, building a session graph, `window.MissionFlow` |
| `PROJECTS/Flow/flow.css` | The tab's styles: `.flow-canvas*`, `.flow-node*`, `.flow-edge*`, the zoom panel in the header |
| `PROJECTS/Flow/flow-server.js` | The tab's server half: the `flow_state` table and `/api/flow/state`, `/api/flow/state/set` |
| `PROJECTS/Flow/flow-session-sync.js` | The session picker in the toolbar: reads the messages and keeps the graph live while the session runs |
| `PROJECTS/Flow/flow-minion.js` | The spinning 3D character in the QA node header, first in the row, left of the title: a small three.js scene per card, ported from the island-sim dossier. An ES module (`type="module"`, imports `three` through the importmap in `index.html`); it watches the page for `.flow-node--qa` and mounts itself, so `flow.js` knows nothing about it (`DOCS/decisions/027`) |
| `PROJECTS/Flow/assets/traveler.glb` | The character model (static, no skeleton or clips) — the same one the island-sim residents use |
| `SYSTEM/index.html` | The `#flowView` markup (canvas, starting nodes, node template, zoom panel) and the shared `.side-nav*` side menu styles |
| `SYSTEM/tabs.js` | Tab switching; calls `MissionFlow.center()` on the first show of Flow |
| `SYSTEM/app.js` | Shared core through `window.App`: `App.BOARD_COLUMNS` for the Flows menu and `App.PROVIDERS` for the Secretary selects — the provider list itself now lives in `SYSTEM/providers.js` (`DOCS/decisions/022`) |

---

Part of the Mission Control project. MIT license.
