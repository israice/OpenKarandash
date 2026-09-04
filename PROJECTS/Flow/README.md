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
- **Files are nodes of their own.** A step that names a `file_path` gets an edge to a node for that file — one node per path for the whole session, so five reads of `app.js` are five edges into the same node. Its "Open file" button opens the file in the same editor window a graph node opens (`MissionGraph.openFileModal`), where it can be edited and saved.
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

## 🚧 What works / what is planned

**Works:** the canvas, zoom and panning, creating nodes and links, inserting into a split edge, selection and deletion, auto-layout, persisting all state between sessions, and drawing a session as a live graph of rich nodes.

**Planned:**

- **Executing the flow.** Flow is a map, not an engine: the only server side it has is `flow_state` (key/value for the canvas). The graph is not sent anywhere and does not run anything, so editing it does not change how future sessions behave.
- **The Secretary.** The card is honestly marked with a "Temporary node" badge: the provider and model selection is saved, but it does not affect real agent work yet. The model lists in `app.js` are a stub for real provider data.

## 📁 Files

| File | Role |
|---|---|
| `PROJECTS/Flow/flow.js` | All of the tab's logic: canvas, zoom/pan, nodes, edges, auto-layout, building a session graph, `window.MissionFlow` |
| `PROJECTS/Flow/flow.css` | The tab's styles: `.flow-canvas*`, `.flow-node*`, `.flow-edge*`, the zoom panel in the header |
| `PROJECTS/Flow/flow-server.js` | The tab's server half: the `flow_state` table and `/api/flow/state`, `/api/flow/state/set` |
| `PROJECTS/Flow/flow-session-sync.js` | The session picker in the toolbar: reads the messages and keeps the graph live while the session runs |
| `SYSTEM/index.html` | The `#flowView` markup (canvas, starting nodes, node template, zoom panel) and the shared `.side-nav*` side menu styles |
| `SYSTEM/tabs.js` | Tab switching; calls `MissionFlow.center()` on the first show of Flow |
| `SYSTEM/app.js` | Shared core: `App.PROVIDERS` for the Secretary selects and `App.BOARD_COLUMNS` for the Flows menu |

---

Part of the Mission Control project. MIT license.
