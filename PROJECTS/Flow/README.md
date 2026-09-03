# 🌊 Flow

**An infinite canvas where a task turns into a diagram: nodes, arrows, zoom — and not a single dependency.**

## 🧭 What this is

Flow is the Mission Control tab where the project is seen as a graph rather than a list. It opens with the `flowButton` toolbar button, lives in the `#flowView` block, and all of its code fits in one file, `PROJECTS/Flow/flow.js`, which publishes `window.MissionFlow`.

In spirit it is an n8n-style editor: a dark dotted canvas, node cards with rounded corners, blue Bézier arcs with arrowheads. There are two starting nodes — **New** (the entry point: project name and opening date) and **Secretary** (a dispatcher agent with a provider, model and effort selector). From there you grow the diagram yourself: with the plus buttons on the card edges, by inserting nodes right into the middle of an edge, and by dragging arrows from node to node.

All state — node positions, the edge list, the camera position and scale, the selected agent — survives a page reload: it lives in `localStorage`. The server knows nothing about Flow at all: the tab makes no API requests and works entirely in the browser.

## ✨ Features

- **A canvas with zoom and panning.** The mouse wheel zooms towards the point under the cursor (30 %–200 %), dragging the empty background moves the camera, and the 28 px background grid moves and scales along with the nodes.
- **Two plus buttons on every node.** The bottom one creates a child node below, the right one continues the chain to the right. Both are connected with an edge automatically.
- **The plus as a connector.** Dragging that same plus pulls a dashed arrow; the target node under the cursor is highlighted with a green frame, and releasing creates an edge.
- **A plus on an edge.** The circle in the middle of an arc splits it in two and inserts a new node between the neighbours, cascading everything further down the chain out of the way.
- **Dragging with the subtree.** When you drag a node, all of its vertical descendants and their branches follow. Collisions are resolved on the fly: nodes do not overlap each other.
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
| Move a node | Drag the card (descendants follow) |
| Select | Click a card or an arrow line |
| Delete a node or link | `Delete` (does not work while the focus is in an input or a select) |
| Current scale | The number between `−` and `+` in the zoom panel |

The **New** and **Secretary** nodes cannot be deleted — canvas centring depends on them.

## ⚙️ How it works

The canvas is an ordinary `div` with `transform: translate(x, y) scale(s)`; the grid is drawn as the container's `radial-gradient` background and is synchronised with the camera through `background-position` / `background-size`. Nodes are positioned absolutely inside the 6000 × 6000 px `#flowSurface` layer, and edges are drawn in the `#flowEdges` SVG layer as cubic Bézier curves with a shared arrow marker.

The side an arc attaches to is fixed by the type of plus that created the edge (horizontal — right/left, vertical — bottom/top), so dragging a node does not make the arrow "jump" to another face. The insert button is placed on the curve at `t = 0.5`.

Auto-layout runs the two passes of the classic tree algorithm: `measure` computes the width of each subtree in columns bottom-up, `place` hands out absolute columns top-down. Nodes with no path from the starting node are laid out as separate trees in rows below.

Centring is deferred: while the tab is hidden the canvas dimensions are zero, so on the first show `tabs.js` calls `MissionFlow.center()` — which places the starting nodes, restores the saved graph and draws the edges exactly once.

Browser storage:

| `localStorage` key | What it stores |
|---|---|
| `flowCanvasViews` | The camera position and scale for each menu entry (`{ [flow]: {x, y, scale} }`) |
| `flowNodePositions2` | The `left` / `top` of every node (by id, shared across all canvases) |
| `flowNodeGraph3` | The edge list (id + direction), which canvas each node belongs to (`flow`) and the new-node counter |
| `flowNodeSecretaryAgent` | The provider, model and effort of the Secretary card |

## 🚧 What works / what is planned

**Works:** the canvas, zoom and panning, creating nodes and links, inserting into a split edge, dragging with the subtree, collision resolution, selection and deletion, auto-layout, and persisting all state between sessions.

**Planned:**

- **Node contents.** New nodes are created from the `#flowNodeTemplate` template — "New node · Placeholder". They cannot be renamed or filled in yet; the styles for the edit button (`.flow-node__edit`) already exist, but the button itself is not in the markup.
- **Executing the flow.** Flow is currently a diagram editor, not an engine: the tab has no server routes, the graph is not sent anywhere and does not run anything.
- **The Secretary.** The card is honestly marked with a "Temporary node" badge: the provider and model selection is saved, but it does not affect real agent work yet. The model lists in `app.js` are a stub for real provider data.

## 📁 Files

| File | Role |
|---|---|
| `PROJECTS/Flow/flow.js` | All of the tab's logic: canvas, zoom/pan, nodes, edges, auto-layout, `window.MissionFlow` |
| `PROJECTS/Flow/flow.css` | The tab's styles: `.flow-canvas*`, `.flow-node*`, `.flow-edge*`, the zoom panel in the header |
| `SYSTEM/index.html` | The `#flowView` markup (canvas, starting nodes, node template, zoom panel) and the shared `.side-nav*` side menu styles |
| `SYSTEM/tabs.js` | Tab switching; calls `MissionFlow.center()` on the first show of Flow |
| `SYSTEM/app.js` | Shared core: `App.PROVIDERS` for the Secretary selects and `App.BOARD_COLUMNS` for the Flows menu |

---

Part of the Mission Control project. MIT license.
